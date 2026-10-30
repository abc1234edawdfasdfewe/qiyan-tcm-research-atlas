#!/usr/bin/env python3
"""Merge source metadata without changing the previous catalogue ID sets."""
import argparse
import collections
import csv
import gzip
import json
import re
from html.parser import HTMLParser
from pathlib import Path
import cnki_client as c
from enrich_cnki import RICH_FIELDS,read_csv,dump_gzip

ROOT=Path(__file__).resolve().parent


class PlainText(HTMLParser):
    def __init__(self):super().__init__(convert_charrefs=True);self.parts=[]
    def handle_data(self,value):self.parts.append(value)
    def handle_starttag(self,tag,attrs):
        if tag=='br':self.parts.append('\n')
    def handle_endtag(self,tag):
        if tag in {'p','div','li'}:self.parts.append('\n')


def plain(value):
    parser=PlainText();parser.feed(value or '')
    return re.sub(r'[ \t]+',' ',''.join(parser.parts)).strip()


def normalize_summary(row):
    raw=row.get('abstract','');row['source_summary_raw']=raw
    body=raw.lstrip().startswith('<正>')
    text=plain(re.sub(r'^\s*<正>','',raw))
    placeholder=not text or bool(re.fullmatch(r'[~～\s]+',text)) or text in {'无摘要','无摘要。','暂无摘要','暂无摘要。','null'}
    row['summary_excerpt']=''
    if placeholder:
        row['abstract']='';row['summary_kind']='source_placeholder';row['abstract_status']='source_placeholder'
    elif body:
        row['abstract']='';row['summary_excerpt']=text;row['summary_kind']='body_excerpt';row['abstract_status']='body_excerpt_not_abstract'
    else:
        row['abstract']=text;row['summary_kind']='abstract';row['abstract_status']='present' if text else row.get('abstract_status','not_returned')
    # Keep source keyword separators in keywords_raw; render scientific markup
    # as plain text in the user-facing keyword/abstract columns.
    row['keywords']=plain(row.get('keywords',''))
    return row


def main():
    global ROOT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT,help='Data/checkpoint directory')
    ROOT=parser.parse_args().root.resolve()
    with gzip.open(ROOT/'cnki_enriched_all_scopes.json.gz','rt',encoding='utf-8') as f:rows=json.load(f)
    for row in rows:
        if row['source']!='publisher_yiigle':continue
        path=ROOT/'publisher'/(row['id'].split(':')[-1]+'.json')
        if not path.exists():
            row.update(detail_status='publisher_not_fetched',abstract_status='record_not_matched',keywords_status='record_not_matched')
            continue
        detail=json.loads(path.read_text())
        if detail.get('id')!=row['id'] or detail.get('meta_doi','').lower()!=row['doi'].lower():raise RuntimeError('Publisher identity mismatch')
        row.update({field:detail.get(field,'') for field in RICH_FIELDS})
    rows=[normalize_summary(row) for row in rows]
    assert len({r['id'] for r in rows})==len(rows)
    partitions={s:[r for r in rows if r['collection_scope']==s] for s in ['main','early','supplement']}
    filenames={'main':'全部已出版文献_含摘要关键词.csv','early':'提前上线文献_含摘要关键词.csv','supplement':'增刊文献_含摘要关键词.csv'}
    # Keep raw source summaries in JSON and source checkpoints; the main CSV
    # contains the readable abstract/excerpt columns without a duplicate blob.
    fields=[key for key in rows[0] if key!='source_summary_raw']
    for scope,name in filenames.items():c.write_csv(ROOT/name,partitions[scope],fields)
    c.write_csv(ROOT/'全部文献详情.csv',rows,fields)
    dump_gzip(ROOT/'全部文献详情.json.gz',rows)
    with gzip.open(ROOT/'全部文献详情.jsonl.gz','wt',encoding='utf-8') as f:
        for row in rows:f.write(json.dumps(row,ensure_ascii=False)+'\n')
    main_rows=partitions['main'];per_journal=collections.defaultdict(list)
    for row in main_rows:per_journal[row['journal']].append(row)
    coverage=[]
    for journal,group in per_journal.items():
        cov={'期刊':journal,'代码':group[0]['journal_code'],'文献数':len(group),
             '详情匹配数':sum(r['detail_status']=='matched' for r in group),
             '有摘要':sum(bool(r['abstract']) for r in group),'有关键词':sum(bool(r['keywords']) for r in group),
             '有作者单位':sum(bool(r['affiliations']) for r in group),'有分类号':sum(bool(r['clc_code']) for r in group),
             '有基金':sum(bool(r['fund']) for r in group),'有英文摘要':sum(bool(r['abstract_en']) for r in group)}
        cov.update(正文摘录=sum(r['summary_kind']=='body_excerpt' for r in group),占位内容=sum(r['summary_kind']=='source_placeholder' for r in group))
        coverage.append(cov)
        folder=ROOT/'各刊'/(c.safe_name(journal)+'_'+group[0]['journal_code']);folder.mkdir(parents=True,exist_ok=True)
        c.write_csv(folder/'主目录_含摘要关键词.csv',group,fields)
        dump_gzip(folder/'主目录_含摘要关键词.json.gz',group)
        for old,new in [('abstracts.csv','接口Summary原始字段.csv'),('abstracts.json.gz','接口Summary原始字段.json.gz')]:
            source=folder/old
            if source.exists():source.replace(folder/new)
    c.write_csv(ROOT/'各刊字段覆盖情况.csv',coverage,list(coverage[0]))
    def stats(group):
        return {'records':len(group),'matched':sum(r['detail_status']=='matched' for r in group),
                **{key:sum(bool(r[key]) for r in group) for key in ['abstract','keywords','affiliations','clc_code','fund','title_en','abstract_en','keywords_en']},
                'abstract_status':dict(collections.Counter(r.get('abstract_status') for r in group)),
                'summary_kind':dict(collections.Counter(r['summary_kind'] for r in group)),
                'keyword_status':dict(collections.Counter(r.get('keywords_status') for r in group))}
    summary={'journal_count':len(per_journal),'scope_months':['2025-11','2026-10'],
             'main':stats(main_rows),'early':stats(partitions['early']),'supplement':stats(partitions['supplement']),
             'all_scopes':stats(rows),'detail_sources':dict(collections.Counter(r['detail_source'] for r in rows))}
    c.dump(ROOT/'结果摘要.json',summary)
    requests=[]
    for path in sorted((ROOT/'pages').glob('*/*/*.json.gz')):
        with gzip.open(path,'rt',encoding='utf-8') as f:page=json.load(f)
        requests.append(page['request'])
    c.dump(ROOT/'请求审计.json',requests)
    missing=[{k:r[k] for k in ['id','journal','title','abstract_status','keywords_status','detail_status']} for r in rows if not r['abstract'] or not r['keywords'] or r['detail_status']!='matched']
    c.write_csv(ROOT/'字段缺失清单.csv',missing,['id','journal','title','abstract_status','keywords_status','detail_status'])
    make_html(rows,summary)
    print(json.dumps(summary,ensure_ascii=False,indent=2))


def make_html(rows,stats):
    keys=['id','journal','journal_code','year','issue','title','authors','abstract','summary_excerpt','summary_kind','keywords','affiliations','fund','clc_code','abstract_en','title_en','keywords_en','doi','doi_url','cnki_url','publisher_url','collection_scope','abstract_status','keywords_status','detail_source']
    data=json.dumps([{k:r.get(k,'') for k in keys} for r in rows],ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
    template='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>67刊文献摘要与关键词</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f2ed;color:#18342e;font:15px/1.7 system-ui,-apple-system,sans-serif}main{max-width:1400px;margin:auto;padding:32px 28px}.eyebrow{font-size:12px;letter-spacing:3px;color:#748377}h1{font:36px/1.3 serif;margin:15px 0}.muted{color:#6d7d70}.stats{display:flex;gap:38px;flex-wrap:wrap;margin:26px 0}.stats b{font-size:29px;display:block}.stats small{color:#718174}.controls{display:flex;gap:10px;flex-wrap:wrap;padding:17px;background:white;border:1px solid #dce3d8;border-radius:8px}input,select,button{font:inherit;color:inherit;background:white;border:1px solid #ccd6cb;border-radius:5px;padding:8px 11px}input{flex:1;min-width:230px}select{max-width:295px}button{cursor:pointer}button:disabled{opacity:.4;cursor:default}a{color:#216d54;text-decoration:none}a:hover{text-decoration:underline}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:14px 0;font-size:13px}.links a{margin-right:20px}article{border:1px solid #e0e5da;border-radius:7px;background:white;padding:21px 24px;margin:14px 0}.meta{font-size:12px;color:#758376}.title{font-size:19px;font-weight:550;margin:7px 0}.author{font-size:13px;color:#6b7d71}.keywords{margin-top:12px;font-size:13px;color:#2e745c}.snippet{color:#586a5e;font-size:14px;margin:10px 0}summary{cursor:pointer;color:#256c54;font-size:14px}.abstract{white-space:pre-wrap;line-height:1.9;font-size:15px}.field{font-size:13px;padding:8px 0;border-top:1px solid #e8ece4}.field b{display:inline-block;min-width:84px}.empty{color:#9b8b73}.pager{display:flex;justify-content:space-between;align-items:center;padding:18px 0}footer{font-size:12px;color:#758374;margin:20px 0}.tag{display:inline-block;background:#edf2e8;padding:2px 8px;border-radius:3px}</style>
<main><div class="eyebrow">RESEARCH METADATA · ABSTRACTS & KEYWORDS</div><h1>中医药文献摘要与关键词</h1><div class="muted">67 刊 · 沿用 2025 年 11 月—2026 年 10 月刊期 · 按原始文献 ID 补采</div>
<div class="stats"><div><b>__TOTAL__</b><small>主目录记录</small></div><div><b>__ABSTRACTS__</b><small>有摘要</small></div><div><b>__KEYWORDS__</b><small>有关键词</small></div><div><b>67</b><small>期刊</small></div></div>
<div class="controls"><input id="q" type="search" aria-label="检索文献" placeholder="检索标题、摘要、关键词、作者或 DOI"><select id="journal" aria-label="选择期刊"><option value="">全部期刊</option></select><select id="scope" aria-label="文献范围"><option value="main">主目录</option><option value="early">提前上线目录</option><option value="supplement">增刊</option></select><select id="availability" aria-label="字段筛选"><option value="">全部字段状态</option><option value="keywords">有关键词</option><option value="no_keywords">无关键词</option><option value="english">有英文摘要</option><option value="fund">有基金</option></select></div>
<div class="toolbar"><div id="count"></div><div class="links"><a href="全部已出版文献_含摘要关键词.csv" download>主目录 CSV</a><a href="各刊字段覆盖情况.csv" download>字段覆盖情况</a><a href="README.md">入口与复采说明</a></div></div><div id="results"></div><div class="pager"><button id="prev">上一页</button><span id="page"></span><button id="next">下一页</button></div><footer>文本来自接口及期刊官网公开元数据，未用 AI 生成或翻译。空值不代表论文没有该信息；应结合字段状态判断。基金、英文摘要等字段的覆盖因来源而异。本次沿用上一轮目录范围，未补齐原目录尚缺的刊期。</footer>
<script type="application/json" id="data">__DATA__</script><script>
const data=JSON.parse(document.getElementById('data').textContent),el=id=>document.getElementById(id),size=30;let page=0,filtered=[];
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const names=new Map();data.forEach(r=>{names.set(r.journal_code,r.journal);r.search=[r.title,r.authors,r.abstract,r.keywords,r.doi].join(' ').toLowerCase()});names.forEach((name,code)=>{let o=document.createElement('option');o.value=code;o.textContent=name;el('journal').append(o)});
function filter(){const q=el('q').value.trim().toLowerCase(),j=el('journal').value,s=el('scope').value,a=el('availability').value;filtered=data.filter(r=>r.collection_scope===s&&(!j||r.journal_code===j)&&(!q||r.search.includes(q))&&(!a||(a==='keywords'&&r.keywords)||(a==='no_keywords'&&!r.keywords)||(a==='english'&&r.abstract_en)||(a==='fund'&&r.fund)));page=0;render()}
function field(label,value){return `<div class="field"><b>${label}</b>${value?escape(value):'<span class="empty">来源未提供</span>'}</div>`}
function render(){const total=Math.max(1,Math.ceil(filtered.length/size));el('count').textContent=`当前结果 ${filtered.length.toLocaleString()} 条`;el('page').textContent=`第 ${page+1} / ${total} 页`;el('prev').disabled=page===0;el('next').disabled=page>=total-1;el('results').innerHTML=filtered.slice(page*size,(page+1)*size).map(r=>`<article><div class="meta"><span class="tag">${escape(r.journal)}</span>　${escape(r.year)} 年 ${escape(r.issue)} 期　·　${escape(r.id)}</div><div class="title"><a href="${escape(r.doi_url||r.publisher_url||r.cnki_url)}" target="_blank" rel="noopener">${escape(r.title)}</a></div><div class="author">${escape(r.authors)}</div><div class="keywords">关键词：${escape(r.keywords||'来源未提供')}</div><p class="snippet">${r.abstract?escape(r.abstract.slice(0,160))+(r.abstract.length>160?'…':''):escape(r.summary_kind==='body_excerpt'?'接口返回正文摘录，未作为摘要填入。':'来源仅返回占位内容，未提供可用摘要。')}</p><details><summary>展开摘要与更多字段</summary><div class="abstract">${escape(r.abstract||'来源未提供可用摘要')}</div>${r.summary_excerpt?field('正文摘录',r.summary_excerpt):''}${field('作者单位',r.affiliations)}${field('中图分类号',r.clc_code)}${field('基金',r.fund)}${field('DOI',r.doi)}${field('英文题目',r.title_en)}${r.abstract_en?'<p class="abstract">'+escape(r.abstract_en)+'</p>':''}${field('英文关键词',r.keywords_en)}${field('数据来源',r.detail_source)}</details></article>`).join('')}
let timer;el('q').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(filter,180)});['journal','scope','availability'].forEach(id=>el(id).addEventListener('change',filter));el('prev').onclick=()=>{page--;render()};el('next').onclick=()=>{page++;render()};filter();
</script></main></html>'''
    for token,value in [('__TOTAL__',stats['main']['records']),('__ABSTRACTS__',stats['main']['abstract']),('__KEYWORDS__',stats['main']['keywords'])]:template=template.replace(token,f'{value:,}')
    (ROOT/'摘要关键词检索.html').write_text(template.replace('__DATA__',data),encoding='utf-8')


if __name__=='__main__':main()
