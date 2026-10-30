#!/usr/bin/env python3
"""Build the final CSVs, coverage ledger and searchable HTML from cached results."""
import argparse
import collections
import datetime as dt
import hashlib
import html
import json
from pathlib import Path
import cnki_catalog as c

ROOT = Path(__file__).resolve().parent
AS_OF = '2026-10-29'
FIELDS = c.COLUMNS + ['source', 'publisher_url', 'publication_date', 'publication_status', 'period_scope', 'in_issue_index']


def main():
    global ROOT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT,help='Data/checkpoint directory')
    ROOT=parser.parse_args().root.resolve()
    plan = json.loads((ROOT/'采集计划.json').read_text())
    data = {d['journal']['Id']: d for p in (ROOT/'数据').glob('*/catalog.json') if (d:=json.loads(p.read_text()))}
    main_rows, early, supplements, coverage, period_states = [], [], [], [], []
    duplicates = []
    for item in plan['journals']:
        info = item['info']; code = info['Id']; result = data[code]
        entries = [dict(a, source='CNKI API', publisher_url='', publication_date='', publication_status='indexed_in_published_issue') for a in result['articles']]
        specials = [dict(a, source='CNKI API', publisher_url='', publication_date='', publication_status='supplement_month_unverified') for a in result['supplement_articles']]
        issues = {x['year_issue']: dict(x) for x in result['issues']}
        duplicates.extend(dict(d,journal=info['Title']) for d in result.get('source_duplicates',[]))
        publisher_early, publisher_issues = [], []
        if code == 'GWZY':
            for path in sorted((ROOT/'官网补采').glob('*.json')):
                issue = json.loads(path.read_text()); period = issue['period']
                is_early = issue['issue_date'] > AS_OF
                publisher_entries = []
                for article in issue['articles']:
                    row = {'journal':info['Title'],'journal_code':code,'year':period[:4],'issue':period[4:],
                           'id':'YIIGLE:'+article['url'].rstrip('/').split('/')[-1],
                           'title':article['title'],'authors':article['authors'],'pages':article['pages'],
                           'doi':article['doi'],'api_date':'','cnki_url':'',
                           'doi_url':'https://doi.org/'+article['doi'] if article['doi'] else '',
                           'source':'publisher_yiigle','publisher_url':article['url'],
                           'publication_date':issue['issue_date'],
                           'publication_status':'early_directory_future_print_date' if is_early else 'published',
                           'period_scope':'early_directory' if is_early else 'regular_window','in_issue_index':True}
                    publisher_entries.append(row)
                if is_early:publisher_early.extend(publisher_entries)
                else:entries.extend(publisher_entries);publisher_issues.append(period)
                issues[period].update(count=0 if is_early else len(publisher_entries),
                    early_count=len(publisher_entries) if is_early else 0,
                    status='publisher_early_directory' if is_early else 'publisher_supplemented',
                    source='publisher_yiigle',publication_date=issue['issue_date'])
            publisher_result = dict(result, articles=entries,
                article_count=len(entries),issue_count=len(publisher_issues),
                issues=[x for x in issues.values() if x['count']],
                scope='Publisher official catalogue; future print-date issue separated')
            folder=ROOT/'官网补采'
            c.dump(folder/'catalog.json',publisher_result)
            c.write_csv(folder/'catalog.csv',entries,FIELDS)
            c.write_html(folder/'catalog.html',publisher_result)
        main_rows.extend(entries);early.extend(publisher_early);supplements.extend(specials)
        missing=[period for period,state in issues.items() if not state['count'] and state.get('status')!='publisher_early_directory']
        recovered=[x['year_issue'] for x in result['issues'] if x['status']=='recovered_missing_index']
        positive=[period for period,state in issues.items() if state['count']]
        coverage.append({'期刊':info['Title'],'代码':code,'出版周期':info['Type'],
                         '计划常规期次':len(issues),'已有主目录期次':len(positive),'主目录记录数':len(entries),
                         '缺少目录的期号':';'.join(sorted(missing)),
                         '论文接口补回索引缺漏期号':';'.join(sorted(recovered)),
                         '提前上线目录记录数':len(publisher_early),'增刊另列记录数':len(specials),
                         '来源':'官网补采（知网近一年为零）' if code=='GWZY' else 'CNKI API',
                         '状态':'有待补齐期次' if missing else '计划范围有目录（按接口）'})
        for state in issues.values():
            period_states.append({'journal':info['Title'],'journal_code':code,**state})
    assert len({r['id'] for r in main_rows})==len(main_rows)
    assert all(r['title'] and r['journal'] and r['year'] and r['issue'] for r in main_rows)
    c.write_csv(ROOT/'全部已出版目录.csv',main_rows,FIELDS)
    c.write_csv(ROOT/'提前上线目录.csv',early,FIELDS)
    c.write_csv(ROOT/'增刊_月份未核验.csv',supplements,FIELDS)
    c.write_csv(ROOT/'全部目录_含提前上线.csv',main_rows+early,FIELDS)
    c.write_csv(ROOT/'采集覆盖情况.csv',coverage,list(coverage[0]))
    c.dump(ROOT/'逐期覆盖状态.json',period_states)
    raw_names=(ROOT/'原始刊名清单.txt').read_text().splitlines()
    mapping={r['input']:r for r in json.loads((ROOT/'刊名映射.json').read_text())}
    first={};mapped=[]
    for line,name in enumerate(raw_names,1):
        match=mapping[name];code=match['code']
        mapped.append({'原始行号':line,'输入刊名':name,'标准刊名':match['name'],'期刊代码':code,
                       '重复于原始行号':first.get(code,'')})
        first.setdefault(code,line)
    c.write_csv(ROOT/'原始清单去重映射.csv',mapped,list(mapped[0]))
    c.dump(ROOT/'服务端重复记录核验.json',duplicates)
    # Recover complete request provenance from durable page checkpoints.
    requests=[json.loads(p.read_text())['request'] for p in (ROOT/'数据').glob('*/pages/*/*.json')]
    c.dump(ROOT/'CNKI请求审计.json',requests)
    stats={'as_of':AS_OF,'scope_months':['2025-11','2026-10'],'input_lines':len(raw_names),'unique_journals':len(coverage),
           'main_records':len(main_rows),'main_unique_ids':len({r['id'] for r in main_rows}),
           'main_issues':sum(x['已有主目录期次'] for x in coverage),'expected_issue_slots':sum(x['计划常规期次'] for x in coverage),
           'missing_issue_slots':sum(len(x['缺少目录的期号'].split(';')) for x in coverage if x['缺少目录的期号']),
           'journals_with_gaps':sum(bool(x['缺少目录的期号']) for x in coverage),
           'early_directory_records':len(early),'supplement_records':len(supplements),
           'recovered_index_issues':sum(len(x['论文接口补回索引缺漏期号'].split(';')) for x in coverage if x['论文接口补回索引缺漏期号']),
           'source_duplicates_removed':len(duplicates),'missing_doi':sum(not x['doi'] for x in main_rows),
           'sources':dict(collections.Counter(x['source'] for x in main_rows))}
    c.dump(ROOT/'结果摘要.json',stats)
    make_index(main_rows,early,supplements,coverage,stats)
    print(json.dumps(stats,ensure_ascii=False,indent=2))


def make_index(rows,early,supplements,coverage,stats):
    data=json.dumps({'main':rows,'early':early,'supplement':supplements,'coverage':coverage},ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
    template='''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>中医药期刊目录 · 67 刊</title><style>
:root{--ink:#18332d;--accent:#1f6d57;--line:#dce3d9}*{box-sizing:border-box}body{margin:0;background:#f4f3ee;color:var(--ink);font:15px/1.6 system-ui,-apple-system,sans-serif}main{max-width:1440px;margin:auto;padding:36px 30px}.label{font-size:12px;letter-spacing:3px;color:#78867b}h1{font:36px/1.3 serif;margin:13px 0}.sub{color:#63756c}.stats{display:flex;gap:40px;flex-wrap:wrap;padding:26px 0}.stats b{font-size:30px;font-weight:550}.stats small{display:block;color:#708275}.controls{display:flex;gap:12px;flex-wrap:wrap;padding:18px;background:white;border:1px solid var(--line);border-radius:8px}input,select,button{font:inherit;color:inherit;border:1px solid #ccd7cd;border-radius:5px;background:white;padding:9px 12px}input{flex:1;min-width:230px}select{max-width:310px}button{cursor:pointer}button:disabled{opacity:.4;cursor:default}.note{padding:12px 0;font-size:13px;color:#6c7a70}.tablewrap{overflow-x:auto;background:white;border:1px solid var(--line);border-radius:8px}table{width:100%;border-collapse:collapse;min-width:900px}th{text-align:left;background:#edf1e9;font-size:12px;color:#6b7d70;padding:12px}td{padding:14px 12px;border-top:1px solid #e8ece5;vertical-align:top;font-size:13px}td.paper{width:48%}.paper a{font-size:15px}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}.authors{font-size:12px;color:#6d7b70;margin-top:5px}.doi{font-size:11px;color:#8a958b}.pager{display:flex;justify-content:space-between;align-items:center;padding:18px 0}footer{font-size:12px;color:#78867b}.badge{background:#e6ede1;padding:3px 8px;border-radius:3px}.links{margin:14px 0}.links a{margin-right:20px}dialog{width:min(1100px,95vw);max-height:85vh;border:1px solid #bfcdbf;border-radius:8px;padding:22px}dialog::backdrop{background:#142f2555}.warning{color:#a35f26}</style>
<main><div class="label">TCM JOURNAL CATALOGUE · 2026.10.29</div><h1>中医药期刊论文目录</h1><div class="sub">2025 年 11 月—2026 年 10 月刊期 · 84 项清单归并为 67 刊 · 离线可检索</div>
<div class="stats"><div><b>67</b><small>期刊</small></div><div><b>__COUNT__</b><small>主目录记录</small></div><div><b>__ISSUES__</b><small>已有目录期次</small></div><div><b>__GAPS__</b><small>接口暂无目录期次</small></div></div>
<div class="controls"><input id="query" type="search" placeholder="检索标题、作者或 DOI" aria-label="检索目录"><select id="journal" aria-label="选择期刊"><option value="">全部期刊</option></select><select id="scope" aria-label="目录类型"><option value="main">主目录（已出版刊期）</option><option value="early">提前上线目录（18 条）</option><option value="supplement">增刊，月份待核验（73 条）</option></select></div>
<div class="links"><a href="全部已出版目录.csv" download>下载主目录 CSV</a><a href="采集覆盖情况.csv" download>下载覆盖情况</a><a href="README.md">说明与复采方法</a><button id="coverage">查看覆盖情况</button></div>
<div id="count" class="note"></div><div class="tablewrap"><table><thead><tr><th>期刊</th><th>年 / 期</th><th>标题与作者</th><th>页码</th><th>来源</th></tr></thead><tbody id="records"></tbody></table></div><div class="pager"><button id="prev">上一页</button><span id="page"></span><button id="next">下一页</button></div>
<footer>近一年按各刊出版周期与刊期推算，非论文首次上线日期。主目录含知网接口及《国际中医中药杂志》官网补采。部分刊期接口暂无记录，不表示期刊未出版；未逐条独立核验所有出版社。官网标注 2026-10-30 出版的 18 条目录另列。无 DOI 的记录保留原状。</footer>
<dialog id="dialog"><button id="close">关闭</button><h2>67 刊覆盖情况</h2><div class="tablewrap"><table><thead><tr><th>期刊</th><th>期次</th><th>记录</th><th>暂无目录期号</th></tr></thead><tbody id="coverageRows"></tbody></table></div></dialog>
<script id="data" type="application/json">__DATA__</script><script>
const dataset=JSON.parse(document.getElementById('data').textContent),size=50;let page=0,filtered=[];
const el=id=>document.getElementById(id),escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
dataset.coverage.forEach(x=>{let o=document.createElement('option');o.value=x['代码'];o.textContent=x['期刊'];el('journal').append(o)});
for(const kind of ['main','early','supplement'])dataset[kind].forEach(x=>x.search=[x.title,x.authors,x.doi].join(' ').toLowerCase());
function filter(){const q=el('query').value.trim().toLowerCase(),j=el('journal').value;filtered=dataset[el('scope').value].filter(x=>(!j||x.journal_code===j)&&(!q||x.search.includes(q)));page=0;render()}
function render(){let pages=Math.max(1,Math.ceil(filtered.length/size));el('count').textContent=`当前结果 ${filtered.length.toLocaleString()} 条 · 每页 ${size} 条`;el('page').textContent=`第 ${page+1} / ${pages} 页`;el('prev').disabled=page===0;el('next').disabled=page>=pages-1;el('records').innerHTML=filtered.slice(page*size,(page+1)*size).map(x=>`<tr><td>${escape(x.journal)}</td><td>${escape(x.year)} / ${escape(x.issue)}</td><td class="paper"><a href="${escape(x.doi_url||x.publisher_url||x.cnki_url)}" target="_blank" rel="noopener">${escape(x.title)}</a><div class="authors">${escape(x.authors)}</div><div class="doi">${escape(x.doi||'DOI 未返回')}</div></td><td>${escape(x.pages)}</td><td>${x.source==='publisher_yiigle'?'期刊官网':'知网'}</td></tr>`).join('')}
let timer;el('query').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(filter,120)});el('journal').addEventListener('change',filter);el('scope').addEventListener('change',filter);el('prev').onclick=()=>{page--;render()};el('next').onclick=()=>{page++;render()};el('coverage').onclick=()=>el('dialog').showModal();el('close').onclick=()=>el('dialog').close();el('coverageRows').innerHTML=dataset.coverage.map(x=>`<tr><td>${escape(x['期刊'])}</td><td>${x['已有主目录期次']} / ${x['计划常规期次']}</td><td>${x['主目录记录数']}</td><td class="warning">${escape(x['缺少目录的期号']||'—')}</td></tr>`).join('');filter();
</script></main></html>'''
    template=template.replace('__COUNT__',f"{stats['main_records']:,}").replace('__ISSUES__',str(stats['main_issues'])).replace('__GAPS__',str(stats['missing_issue_slots'])).replace('__DATA__',data)
    (ROOT/'总目录.html').write_text(template,encoding='utf-8')


if __name__=='__main__':main()
