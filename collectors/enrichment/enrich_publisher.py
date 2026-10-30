#!/usr/bin/env python3
"""Read only publicly displayed abstract/keyword blocks from rs.yiigle.com.

No personal credentials, browser cookies or full-text downloads. HTML is parsed
as inert text; only explicitly selected public bibliographic blocks are saved.
"""
import argparse
import collections
import datetime as dt
import gzip
import hashlib
import html.parser
import json
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from zoneinfo import ZoneInfo
import cnki_client as c
from enrich_cnki import read_csv,tokens,dump_gzip


class Node:
    def __init__(self,tag='root',attrs=None,parent=None):
        self.tag,self.attrs,self.parent,self.children=tag,dict(attrs or []),parent,[]
    def has(self,cls):return cls in self.attrs.get('class','').split()
    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child,Node):yield from child.walk()
    def text(self):
        raw=''.join(child.text() if isinstance(child,Node) else child for child in self.children)
        if self.tag in {'p','div','li','br','h1','h2','h3'}:raw+=' '
        return raw


class Parser(html.parser.HTMLParser):
    VOID={'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr'}
    def __init__(self):super().__init__(convert_charrefs=True);self.root=Node();self.current=self.root
    def handle_starttag(self,tag,attrs):
        node=Node(tag,attrs,self.current);self.current.children.append(node)
        if tag not in self.VOID:self.current=node
    def handle_startendtag(self,tag,attrs):
        node=Node(tag,attrs,self.current);self.current.children.append(node)
    def handle_endtag(self,tag):
        node=self.current
        while node.parent is not None:
            if node.tag==tag:self.current=node.parent;return
            node=node.parent
    def handle_data(self,data):self.current.children.append(data)


def tidy(value):return re.sub(r'\s+',' ',value or '').strip()


def extract(raw):
    parser=Parser();parser.feed(raw.decode('utf-8'));nodes=list(parser.root.walk())
    metas=collections.defaultdict(list)
    for node in nodes:
        if node.tag=='meta' and node.attrs.get('name'):metas[node.attrs['name']].append(node.attrs.get('content',''))
    result={'abstract':'','abstract_en':'','keywords':'','keywords_raw':'','keywords_en':'',
            'affiliations':'','fund':'','clc_code':'','title_en':'','meta_doi':next(iter(metas['citation_doi']),''),
            'page_title':next(iter(metas['citation_title']),''),'field_blocks':[]}
    for node in nodes:
        if node.has('abstract_content'):
            value=tidy(node.text());parent=node.parent
            if parent.has('trans_abstract'):result['abstract_en']=value
            elif parent.has('abstract'):result['abstract']=value
            result['field_blocks'].append({'field':'abstract_en' if parent.has('trans_abstract') else 'abstract','selector':parent.attrs.get('class','')+' > .abstract_content'})
        if node.has('abstract_key_point') and node.has('kwd_group'):
            words=[tidy(n.text()).rstrip(';；') for n in node.walk() if n.has('kwd')]
            labels=' '.join(tidy(n.text()) for n in node.children if isinstance(n,Node) and n.tag=='label')
            if '关键词' in labels:
                result['keywords_raw']=';'.join(words);result['keywords']='; '.join(tokens(result['keywords_raw']))
            elif 'KEYWORDS' in labels.upper():result['keywords_en']='; '.join(words)
        if node.has('foot_content'):
            labels=[tidy(n.text()) for n in node.children if isinstance(n,Node) and n.tag=='label']
            if any('基金项目' in label for label in labels):
                right=next((n for n in node.children if isinstance(n,Node) and n.has('foot_right')),None)
                if right:result['fund']=tidy(right.text())
        # English title metadata can omit inline italic text; take displayed title.
        if node.tag=='meta' and node.attrs.get('name')=='citation_title' and not result['title_en']:
            pass
    # Nuxt initially renders empty abstract containers, then hydrates them from
    # xmlData. Decode that ONE JSON string as data, without executing JavaScript.
    # Parse only the public <front> metadata; discard everything after </front>.
    # Meta tags are insufficient: the site's values can contain a literal 'null'
    # and omit italic inline text. The front metadata matches the visible DOM.
    source=raw.decode('utf-8')
    marker=re.search(r'\bxmlData\s*:',source)
    if marker:
        value,end=json.JSONDecoder().raw_decode(source[marker.end():].lstrip())
        if not isinstance(value,str) or '</front>' not in value:raise RuntimeError('Missing public front metadata')
        front_xml=value[:value.index('</front>')+len('</front>')]+'</article>'
        front=ET.fromstring(front_xml)
        meta=front.find('./front/article-meta')
        if meta is None:raise RuntimeError('Missing article-meta')
        def text(element):return tidy(''.join(element.itertext())) if element is not None else ''
        abstract=meta.find('abstract');translated=meta.find('trans-abstract')
        result['abstract']=text(abstract)
        result['abstract_en']=text(translated)
        group=meta.find('kwd-group');translated_group=meta.find('trans-kwd-group')
        words=[text(k) for k in group.findall('kwd')] if group is not None else []
        result['keywords_raw']=';'.join(words);result['keywords']='; '.join(tokens(result['keywords_raw']))
        result['keywords_en']='; '.join(text(k) for k in translated_group.findall('kwd')) if translated_group is not None else ''
        result['title_en']=text(meta.find('./title-group/trans-article-title'))
        chinese_affs=[]
        for aff in meta.findall('./contrib-group//aff'):
            # Prefer inline author affiliations; avoid duplicate numbered lists.
            if aff.get('id'):continue
            value=text(aff)
            if value and value not in chinese_affs:chinese_affs.append(value)
        result['affiliations']='; '.join(chinese_affs)
        groups=[g for g in meta.findall('funding-group') if g.get('{http://www.w3.org/XML/1998/namespace}lang','zh')!='en']
        result['fund']='; '.join(text(g) for g in groups)
        result['field_blocks']=[{'field':'abstract','selector':'front/article-meta/abstract'},
                                {'field':'abstract_en','selector':'front/article-meta/trans-abstract'}]
        result['metadata_extraction']='inert JSON string; public JATS front only'
        result['parser_version']=2
    # A missing selected block is different from a request/identity failure.
    result['abstract_status']='present' if result['abstract'] else 'not_in_public_abstract_block'
    result['keywords_status']='present' if result['keywords'] else 'not_in_public_keyword_block'
    result['fund_status']='present' if result['fund'] else 'not_in_public_fund_block'
    result['english_abstract_status']='present' if result['abstract_en'] else 'not_in_public_abstract_block'
    result['detail_source']='publisher_public_front_metadata'
    result['detail_status']='matched'
    return result


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--catalog-root',type=Path,required=True)
    ap.add_argument('--output',type=Path,default=Path(__file__).resolve().parent)
    ap.add_argument('--refresh',action='store_true',help='Refresh public metadata instead of reusing saved records')
    args=ap.parse_args();root=args.output
    targets=[]
    for name in ['全部已出版目录.csv','提前上线目录.csv']:
        targets.extend(r for r in read_csv(args.catalog_root/name) if r['source']=='publisher_yiigle')
    results=[];errors=[];last=0
    for i,base in enumerate(targets,1):
        article_id=base['id'].split(':')[-1];path=root/'publisher'/f'{article_id}.json'
        cached=json.loads(path.read_text()) if path.exists() else None
        if cached and cached.get('parser_version')==2 and not args.refresh:result=cached
        else:
            url=base['publisher_url']
            if not re.fullmatch(r'https://rs\.yiigle\.com/cmaid/\d+',url):raise RuntimeError('Unexpected publisher URL')
            try:
                time.sleep(max(0,last+.7-time.monotonic()));last=time.monotonic()
                for attempt in range(3):
                    try:
                        with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=30) as response:
                            raw=response.read();status=response.status;final_url=response.url
                        break
                    except (urllib.error.URLError,TimeoutError,ConnectionError):
                        if attempt==2:raise
                        time.sleep(attempt+1)
                result=extract(raw)
                if result['meta_doi'].strip().lower()!=base['doi'].strip().lower():raise RuntimeError('Publisher DOI does not match catalogue')
                result.update(id=base['id'],source_url=url,received_at=dt.datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
                              response_sha256=hashlib.sha256(raw).hexdigest(),http_status=status,final_url=final_url)
                c.dump(path,result)
            except Exception as error:
                errors.append({'id':base['id'],'url':url,'error':str(error)})
                result={'id':base['id'],'detail_status':'request_failed','error':str(error)}
                print(f'ERROR {article_id}: {error}',flush=True)
        results.append(result)
        if i%10==0 or i==len(targets):
            print(f'Publisher [{i}/{len(targets)}] abstracts {sum(bool(r.get("abstract")) for r in results)}, keywords {sum(bool(r.get("keywords")) for r in results)}',flush=True)
            c.dump(root/'publisher_progress.json',{'completed':i,'total':len(targets),'errors':errors})
    c.dump(root/'publisher_run_summary.json',{'records':len(results),'errors':errors,
           'with_abstract':sum(bool(r.get('abstract')) for r in results),
           'with_keywords':sum(bool(r.get('keywords')) for r in results),
           'with_english_abstract':sum(bool(r.get('abstract_en')) for r in results),
           'with_fund':sum(bool(r.get('fund')) for r in results)})
    return 1 if errors else 0


if __name__=='__main__':raise SystemExit(main())
