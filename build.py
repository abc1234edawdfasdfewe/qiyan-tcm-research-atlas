#!/usr/bin/env python3
"""Build a fully local, single-file bibliometric workbench from the saved corpus."""
import argparse
import collections
import csv
import gzip
import hashlib
import json
import math
import re
import unicodedata
from pathlib import Path

ROOT=Path(__file__).resolve().parent


def norm(value):return re.sub(r'\s+',' ',unicodedata.normalize('NFKC',value or '')).strip().lower()
def title_key(value):return re.sub(r'\s+','',norm(value))


def render_page(data):
    payload=json.dumps(data,ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
    page=(ROOT/'index.template.html').read_text()
    page=page.replace('__AI_PANEL__',(ROOT/'ai-panel.html').read_text())
    page=page.replace('__STYLES__',(ROOT/'styles.css').read_text()+'\n'+(ROOT/'ai.css').read_text()).replace('__ENGINE__',(ROOT/'engine.js').read_text().replace('</','<\\/'))
    page=page.replace('__APP__',(ROOT/'app.js').read_text().replace('</','<\\/')).replace('__CORPUS__',payload)
    page=page.replace('__AI_APP__',(ROOT/'ai.js').read_text().replace('</','<\\/'))
    (ROOT/'中医药热点计量工作台.html').write_text(page,encoding='utf-8')


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--prepared',type=Path,help='Rebuild the HTML using an already prepared corpus.json.gz; no original collection folders required.')
    ap.add_argument('--corpus',type=Path,default=(ROOT/'datasets/enriched/全部文献详情.json.gz' if (ROOT/'datasets/enriched/全部文献详情.json.gz').exists() else ROOT.parent/'中医药文献摘要关键词批量采集/全部文献详情.json.gz'))
    ap.add_argument('--catalogue',type=Path,default=(ROOT/'datasets/catalogue' if (ROOT/'datasets/catalogue/采集计划.json').exists() else ROOT.parent/'中医药期刊目录批量采集'))
    args=ap.parse_args()
    if args.prepared:
        with gzip.open(args.prepared,'rt',encoding='utf-8') as f:data=json.load(f)
        render_page(data)
        print(json.dumps(data['meta'],ensure_ascii=False,indent=2))
        return
    with gzip.open(args.corpus,'rt',encoding='utf-8') as f:raw=[x for x in json.load(f) if x['collection_scope']=='main']
    lex=json.loads((ROOT/'terminology.json').read_text())
    alias={norm(c):c for c in lex['aliases']}
    for canonical,variants in lex['aliases'].items():
        for term in variants:alias[norm(term)]=canonical
    term_stats=collections.Counter();variants=collections.defaultdict(collections.Counter);kw_lists=[]
    for doc in raw:
        labels=[]
        for value in doc['keywords'].split(';'):
            value=value.strip()
            if not value:continue
            key=norm(value);key=norm(alias.get(key,key));variants[key][value]+=1
            labels.append(key)
        keys=sorted(set(labels));kw_lists.append(keys);term_stats.update(keys)
    canonical_labels={norm(key):key for key in lex['aliases']}
    ordered=sorted(term_stats,key=lambda k:(-term_stats[k],k));term_id={k:i for i,k in enumerate(ordered)}
    terms=[{'label':canonical_labels.get(k,variants[k].most_common(1)[0][0]),'key':k,'count':term_stats[k],
            'generic':k in {norm(v) for v in lex['generic_terms']},'variants':dict(variants[k])} for k in ordered]
    with (args.catalogue/'采集覆盖情况.csv').open(encoding='utf-8-sig',newline='') as f:coverage=list(csv.DictReader(f))
    plan=json.loads((args.catalogue/'采集计划.json').read_text())
    annual={x['info']['Id']:x['selection']['issues_per_year'] for x in plan['journals']}
    journals=[{'code':c['代码'],'name':c['期刊'],'complete':c['已有主目录期次']==c['计划常规期次'],
               'expected':int(c['计划常规期次']),'available':int(c['已有主目录期次']),
               'missing':c['缺少目录的期号'],'frequency':c['出版周期']} for c in coverage]
    journal_id={j['code']:i for i,j in enumerate(journals)}
    entity_defs=[]
    for category,labels in lex['entities'].items():
        for label in labels:
            forms=list(dict.fromkeys([label]+lex['aliases'].get(label,[])))
            entity_defs.append({'label':label,'category':category,'forms':[norm(v) for v in forms]})
    # Exact DOI + normalized title duplicates only. Conflicting DOI/title groups
    # and missing-DOI same-title groups are audited, not automatically removed.
    by_doi=collections.defaultdict(list);dupes={};audit=[]
    for index,doc in enumerate(raw):
        if doc['doi']:by_doi[norm(doc['doi'])].append(index)
    for doi,indexes in by_doi.items():
        title_groups=collections.defaultdict(list)
        for i in indexes:title_groups[title_key(raw[i]['title'])].append(i)
        for group in title_groups.values():
            if len(group)<2:continue
            best=min(group,key=lambda i:(not bool(re.fullmatch(r'[A-Z]{4}\d{9}',raw[i]['id'])),
                                         not bool(raw[i]['abstract']),not bool(raw[i]['keywords']),len(raw[i]['id']),raw[i]['id']))
            for i in group:
                if i!=best:dupes[i]=best
            audit.append({'type':'same_doi_and_title','doi':doi,'keep':raw[best]['id'],'members':[raw[i]['id'] for i in group]})
        if len(title_groups)>1 and len(indexes)>1:audit.append({'type':'same_doi_conflicting_titles','doi':doi,'members':[{'id':raw[i]['id'],'title':raw[i]['title']} for i in indexes]})
    docs=[];periods=[f'{2025+(10+i)//12}-{(10+i)%12+1:02d}' for i in range(12)]
    suspicious=re.compile(r'征稿启事|征订启事|稿约|投稿须知|编委会成员|编辑委员会名单|缩略语|证书|招聘启事|严正声明|编辑部声明|杂志明细|创刊.*贺词')
    for i,(doc,keywords) in enumerate(zip(raw,kw_lists)):
        text=norm(' '.join([doc['title'],doc['keywords'],doc['abstract']]))
        year=int(doc['year']);issue=int(doc['issue']);month=math.ceil(issue*12/annual[doc['journal_code']])
        period=f'{year}-{month:02d}';assert period in periods,(doc['id'],period)
        entities=[n for n,e in enumerate(entity_defs) if any(value in text for value in e['forms'])]
        docs.append({'id':doc['id'],'j':journal_id[doc['journal_code']],'p':periods.index(period),
                     'year':doc['year'],'issue':doc['issue'],'title':doc['title'],'authors':doc['authors'],
                     'abstract':doc['abstract'],'keywords':doc['keywords'],'k':[term_id[k] for k in keywords],
                     'e':entities,'doi':doc['doi'],'url':doc['doi_url'] or doc['publisher_url'] or doc['cnki_url'],
                     'pages':doc['pages'],'affiliations':doc['affiliations'],'summary_kind':doc['summary_kind'],
                     'dup':dupes.get(i,-1),'suspect':bool(suspicious.search(doc['title']))})
    meta={'title':'中医药热点计量工作台','scope':'2025-11 至 2026-10 刊期','snapshot':'2026-10-29 corpus',
          'records':len(docs),'journals':len(journals),'with_abstract':sum(bool(d['abstract']) for d in docs),
          'with_keywords':sum(bool(d['k']) for d in docs),'duplicate_records':len(dupes),
          'complete_journals':sum(j['complete'] for j in journals),'missing_periods':37,
          'lexicon_version':lex['version'],'corpus_sha256':hashlib.sha256(args.corpus.read_bytes()).hexdigest(),
          'references_available':False,'citations_available':False,'periods':periods,
          'note':'月份按出版周期与期号折算；实体分类为术语提及；共现不代表因果或证据质量。'}
    data={'meta':meta,'journals':journals,'terms':terms,'entities':entity_defs,'lexicon':lex,'docs':docs}
    work=ROOT/'data';work.mkdir(exist_ok=True)
    with gzip.open(work/'corpus.json.gz','wt',encoding='utf-8') as f:json.dump(data,f,ensure_ascii=False,separators=(',',':'))
    (ROOT/'数据质量与去重.json').write_text(json.dumps({'meta':meta,'duplicate_audit':audit,'suspicious_titles':[
        {'id':d['id'],'title':d['title']} for d in docs if d['suspect']]},ensure_ascii=False,indent=2))
    with (ROOT/'关键词归一词表.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=['term_id','canonical','document_frequency','generic','variants']);writer.writeheader()
        writer.writerows({'term_id':i,'canonical':t['label'],'document_frequency':t['count'],'generic':t['generic'],
                         'variants':json.dumps(t['variants'],ensure_ascii=False)} for i,t in enumerate(terms))
    render_page(data)
    print(json.dumps(meta,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
