#!/usr/bin/env python3
"""Enrich the existing journal catalogues with source abstracts and keywords.

Python standard library only. No desktop client, personal credentials or full
text downloads. Durable pages include the exact requested fields in cache IDs.
"""
import argparse
import collections
import csv
import datetime as dt
import gzip
import hashlib
import html
import json
import re
from pathlib import Path
from zoneinfo import ZoneInfo
import cnki_client as c

FIELDS = 'Id,Title,Creator,Source,SourceCode,Year,Issue,Date,PageRange,DOI,Summary,KeyWords,Contributor,Fund,ClcCode,Summary@EN,KeyWords@EN,Title@EN'
RICH_FIELDS = ['abstract','keywords','keywords_raw','affiliations','fund','clc_code','title_en','abstract_en','keywords_en',
               'abstract_status','keywords_status','fund_status','english_abstract_status','detail_status','detail_source']


def read_csv(path):
    with path.open(encoding='utf-8-sig',newline='') as f:return list(csv.DictReader(f))


def dump_gzip(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    with gzip.open(path,'wt',encoding='utf-8') as f:json.dump(data,f,ensure_ascii=False)


def tokens(value):
    return list(dict.fromkeys(x.strip() for x in re.split(r'[;；]+',value or '') if x.strip()))


def state(record,key):
    if key not in record:return 'not_returned'
    return 'present' if record[key].strip() else 'returned_empty'


def fetch(client,root,code,query,refresh=False):
    digest=hashlib.sha256((FIELDS+'\n'+query).encode()).hexdigest()[:20]
    folder=root/'pages'/code/digest
    rows=[];expected=None;offset=0
    while True:
        path=folder/f'{offset:07d}.json.gz'
        if path.exists() and not refresh:
            with gzip.open(path,'rt',encoding='utf-8') as f:data=json.load(f)
            if data['fields']!=FIELDS or data['query']!=query or data['start']!=offset:raise RuntimeError('Cache identity mismatch')
        else:
            response=client.query('CJFD',FIELDS,query,offset,100,'Date desc')
            data={'fields':FIELDS,'query':query,'start':offset,'count':response['Count'],
                  'rows':[c.flatten(r) for r in response['Rows']], 'request':client.log[-1]}
            dump_gzip(path,data)
        if expected is None:expected=data['count']
        if expected!=data['count']:raise RuntimeError('API Count changed between pages')
        if not data['rows'] and offset<expected:raise RuntimeError('Empty page before Count')
        rows.extend(data['rows']);offset+=len(data['rows'])
        if offset>=expected:break
    if len(rows)!=expected:raise RuntimeError('Returned row count does not match Count')
    return rows


def enrich(base,record):
    row=dict(base)
    if record is None:
        row.update({key:'' for key in RICH_FIELDS})
        row.update(abstract_status='record_not_matched',keywords_status='record_not_matched',
                   fund_status='record_not_matched',english_abstract_status='record_not_matched',
                   detail_status='record_not_matched',detail_source='CNKI API')
        return row
    raw_keywords=record.get('KeyWords','')
    row.update(abstract=record.get('Summary',''),keywords='; '.join(tokens(raw_keywords)),keywords_raw=raw_keywords,
               affiliations=record.get('Contributor',''),fund=record.get('Fund',''),clc_code=record.get('ClcCode',''),
               title_en=record.get('Title@EN',''),abstract_en=record.get('Summary@EN',''),
               keywords_en=record.get('KeyWords@EN',''),abstract_status=state(record,'Summary'),
               keywords_status=state(record,'KeyWords'),fund_status=state(record,'Fund'),
               english_abstract_status=state(record,'Summary@EN'),detail_status='matched',detail_source='CNKI API')
    return row


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog-root',type=Path,required=True)
    parser.add_argument('--output',type=Path,default=Path(__file__).resolve().parent)
    parser.add_argument('--refresh',action='store_true',help='Refresh source pages instead of reusing checkpoints')
    args=parser.parse_args();old=args.catalog_root;root=args.output
    root.mkdir(parents=True,exist_ok=True)
    plan=json.loads((old/'采集计划.json').read_text())
    scopes={'main':'全部已出版目录.csv','early':'提前上线目录.csv','supplement':'增刊_月份未核验.csv'}
    originals={scope:read_csv(old/name) for scope,name in scopes.items()}
    all_base=[dict(row,collection_scope=scope) for scope,rows in originals.items() for row in rows]
    c.dump(root/'input_catalogue_manifest.json',{'catalogue_root':str(old.resolve()),
        'files':[{ 'name':n,'sha256':hashlib.sha256((old/n).read_bytes()).hexdigest()} for n in scopes.values()],
        'record_counts':{s:len(r) for s,r in originals.items()}})
    existing={r['id']:r for r in all_base if r['source']=='CNKI API'}
    by_code=collections.defaultdict(dict)
    for row in existing.values():by_code[row['journal_code']][row['id']]=row
    client=c.Client(.7);details={};errors=[];duplicate_ids=[];conflicts=[];journals=[]
    identity=['Id','Title','Summary','KeyWords','Contributor','Fund','ClcCode','DOI']
    for index,item in enumerate(plan['journals'],1):
        code=item['info']['Id'];targets=by_code[code]
        if not targets:continue
        try:
            records=fetch(client,root,code,item['query'],args.refresh)
            for special in item['supplements']:
                records.extend(fetch(client,root,code,f"SourceCode eq {code} and Year eq {special['Year']} and Issue eq {special['Issue']}",args.refresh))
            chosen={}
            for record in records:
                if record['Id'] not in targets:continue
                previous=chosen.get(record['Id'])
                if previous:
                    if any(record.get(k)!=previous.get(k) for k in identity):
                        conflicts.append({'id':record['Id'],'journal':item['info']['Title'],'fields':[k for k in identity if record.get(k)!=previous.get(k)]})
                    else:duplicate_ids.append(record['Id'])
                else:chosen[record['Id']]=record
            missing=sorted(set(targets)-set(chosen))
            # Rescue exact existing IDs if the range source changed since the catalogue snapshot.
            for start in range(0,len(missing),10):
                query=' or '.join("Id eq '"+value+"'" for value in missing[start:start+10])
                for record in fetch(client,root,code,query,args.refresh):
                    if record['Id'] in targets:chosen[record['Id']]=record
            for conflict in conflicts:
                if conflict['journal']==item['info']['Title']:chosen.pop(conflict['id'],None)
            details.update(chosen)
            enriched=[enrich(row,chosen.get(row['id'])) for row in targets.values()]
            fields=list(enriched[0])
            directory=root/'各刊'/f"{c.safe_name(item['info']['Title'])}_{code}"
            directory.mkdir(parents=True,exist_ok=True)
            c.write_csv(directory/'abstracts.csv',enriched,fields)
            dump_gzip(directory/'abstracts.json.gz',enriched)
            summary={'journal':item['info']['Title'],'code':code,'target_records':len(targets),'matched':len(chosen),
                     'with_abstract':sum(bool(r['abstract']) for r in enriched),
                     'with_keywords':sum(bool(r['keywords']) for r in enriched),
                     'with_affiliations':sum(bool(r['affiliations']) for r in enriched),
                     'with_fund':sum(bool(r['fund']) for r in enriched),
                     'with_english_abstract':sum(bool(r['abstract_en']) for r in enriched)}
            journals.append(summary)
            print(f"[{index}/67] {summary['journal']}: matched {summary['matched']}/{summary['target_records']}, abstracts {summary['with_abstract']}, keywords {summary['with_keywords']}",flush=True)
        except Exception as error:
            errors.append({'journal':item['info']['Title'],'code':code,'error':str(error)})
            print(f'ERROR {code}: {error}',flush=True)
        c.dump(root/'progress.json',{'completed_cnki_journals':len(journals),'target_journals':len(by_code)-int('GWZY' in by_code),
                                   'matched_records':len(details),'errors':errors})
        c.dump(root/'request_log.json',client.log)
    enriched_all=[]
    for row in all_base:
        enriched_all.append(enrich(row,details.get(row['id'])) if row['source']=='CNKI API' else {**row,**{k:'' for k in RICH_FIELDS},'detail_status':'publisher_pending'})
    dump_gzip(root/'cnki_enriched_all_scopes.json.gz',enriched_all)
    c.dump(root/'cnki_run_summary.json',{'fields':FIELDS,'matched_records':len(details),'target_records':len(existing),
               'errors':errors,'duplicate_ids':duplicate_ids,'conflicts':conflicts,'journals':journals,
               'fetched_at':dt.datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()})
    return 1 if errors else 0


if __name__=='__main__':raise SystemExit(main())
