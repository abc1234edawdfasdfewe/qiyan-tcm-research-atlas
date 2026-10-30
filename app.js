(() => {
  'use strict';
  const $=id=>document.getElementById(id), esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const corpus=JSON.parse($('corpus').textContent), docs=corpus.docs, meta=corpus.meta;
  let worker=null,fallback=null,serial=0,current=null,paperPage=0,paperEvidence=null,pending=false,lastSubmittedQuery='',resizeTimer;
  const num=n=>Number(n).toLocaleString('zh-CN'),pct=n=>Number(n).toFixed(1)+'%';
  function config(){return {query:$('query').value.trim(),field:$('field').value,journal:Number($('journal').value),from:Number($('from').value),to:Number($('to').value),dedup:$('dedup').checked,expand:$('expand').checked,abstractOnly:$('abstractOnly').checked,excludeSuspect:$('excludeSuspect').checked,hideGeneric:$('hideGeneric').checked,completeTrend:$('completeTrend').checked,nodes:Number($('nodes').value),minCo:Math.max(1,Math.min(10000,Number($('minCo').value)||1)),edgeWeight:$('edgeWeight').value,matrix:$('matrix').value,trendMetric:$('trendMetric').value};}
  function exportState(disabled){['exportPapers','exportConfig'].forEach(id=>$(id).disabled=disabled);document.querySelectorAll('[data-export],[data-svg]').forEach(b=>b.disabled=disabled);}
  function setBusy(value){pending=value;$('loading').hidden=!value;exportState(value);}
  function analyze(){
    const cfg=config();if(cfg.query!==lastSubmittedQuery){$('trendMetric').value=cfg.query?'share':'count';cfg.trendMetric=$('trendMetric').value;lastSubmittedQuery=cfg.query;}
    $('queryError').hidden=true;setBusy(true);const id=++serial;
    if(worker)worker.postMessage({type:'analyze',id,config:cfg});
    else setTimeout(()=>{try{receive({id,result:fallback.analyze(cfg)});}catch(error){receive({id,error:error.message});}},0);
  }
  function receive(message){if(message.id!==serial)return;setBusy(false);if(message.error){$('queryError').textContent=message.error+' 以下保留上一次有效分析结果；请修正后重新分析。';exportState(true);$('queryError').hidden=false;$('live').textContent=message.error;return;}current=message.result;paperPage=0;paperEvidence=null;render();$('live').textContent='分析完成，匹配 '+current.stats.hits+' 条记录。';}
  function runQuery(value){$('query').value=value;analyze();}
  function quote(value){return '"'+String(value).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"';}
  function addTerm(value){const old=$('query').value.trim();runQuery(old?'('+old+') AND '+quote(value):quote(value));}
  corpus.journals.forEach((j,i)=>{const o=document.createElement('option');o.value=i;o.textContent=j.name+(j.complete?'':' · 刊期不完整');$('journal').append(o);});
  meta.periods.forEach((p,i)=>{for(const id of ['from','to']){const o=document.createElement('option');o.value=i;o.textContent=p;$(id).append(o);}});$('from').value=0;$('to').value=11;
  $('corpusline').textContent=`${num(meta.records)} 条主目录 · 67 本期刊 · ${meta.scope} · ${num(meta.with_abstract)} 条可用摘要`;
  $('searchForm').addEventListener('submit',event=>{event.preventDefault();analyze();});
  document.querySelectorAll('[data-query]').forEach(b=>b.onclick=()=>runQuery(b.dataset.query));$('clearQuery').onclick=()=>runQuery('');
  ['field','journal','from','to','dedup','expand','abstractOnly','excludeSuspect','hideGeneric','completeTrend','nodes','minCo','edgeWeight','matrix'].forEach(id=>$(id).addEventListener('change',analyze));
  $('trendMetric').addEventListener('change',()=>{if(current){current.config.trendMetric=$('trendMetric').value;drawTrend();}});
  $('reset').onclick=()=>{$('query').value='';$('field').value='all';$('journal').value=-1;$('from').value=0;$('to').value=11;['dedup','expand','hideGeneric','completeTrend'].forEach(id=>$(id).checked=true);['abstractOnly','excludeSuspect'].forEach(id=>$(id).checked=false);$('minCo').value=3;$('nodes').value=32;$('matrix').value='疾病|方法';$('edgeWeight').value='cosine';$('trendMetric').value='count';analyze();};
  function render(){
    const s=current.stats;$('statHits').textContent=num(s.hits);$('statBase').textContent=`基础筛选 ${num(s.base)} 条`; $('statJournals').textContent=s.journals;
    $('statAbstract').textContent=num(s.withAbstract);$('statKeywords').textContent=num(s.withKeywords);$('statDedup').textContent=`本范围保守去重排除 ${s.removedDuplicates} 条`;
    $('analysisTitle').textContent=current.config.query||'全部文献';$('viewTag').textContent=current.config.query?'话题分析':'全库探索';
    $('analysisNote').textContent=`${meta.periods[current.config.from]} — ${meta.periods[current.config.to]} · ${current.config.expand?'同义词扩展':'字面匹配'}`;
    $('notice').textContent=`图表随当前文献集重算。关键词缺失 ${num(s.hits-s.withKeywords)} 条，疑似非研究记录 ${num(s.suspects)} 条。当前样本不含参考文献与可靠引文计数，不生成高被引或共被引排名。`;
    renderBars();drawNetwork();drawMatrix();drawTrend();renderPapers();window.dispatchEvent(new CustomEvent('atlas:results'));
  }
  function renderBars(){
    const rows=current.keywords.slice(0,12),max=Math.max(1,...rows.map(r=>r.count));
    $('keywordChart').innerHTML=rows.length?rows.map(r=>`<button class="barrow" data-term="${esc(r.label)}" aria-label="检索 ${esc(r.label)}，${r.count} 条"><span class="barlabel">${esc(r.label)}</span><span class="bartrack"><span class="barfill" style="display:block;width:${r.count/max*100}%"></span></span><span class="barvalue">${num(r.count)}</span></button>`).join(''):empty('当前文献没有可用的非泛化关键词。');
    $('keywordNote').textContent=`频次以 ${num(current.stats.withKeywords)} 条有关键词的命中记录为分母。词典 ${meta.lexicon_version}；${current.config.hideGeneric?'已隐藏泛化词，可取消。':'已显示泛化词。'}`;
    const jr=current.journals.slice(0,12),jm=Math.max(1,...jr.map(r=>r.count));
    $('journalChart').innerHTML=jr.length?jr.map(r=>`<button class="barrow journalrow" data-journal="${r.id}" aria-label="只看 ${esc(r.label)}"><span class="barlabel">${esc(r.label)}</span><span class="bartrack"><span class="barfill" style="display:block;width:${r.count/jm*100}%"></span></span><span class="barvalue">${num(r.count)}<small>${pct(r.share)}${r.complete?'':' · 缺期'}</small></span></button>`).join(''):empty('当前没有匹配文献。');
  }
  function empty(message){return `<div class="empty">${esc(message)}</div>`;}
  function svgOpen(id,w,h,label){return `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>`;}
  function drawNetwork(){
    if(!current)return;const g=current.network,box=$('networkChart'),w=Math.max(280,box.clientWidth),h=w<500?410:460;
    if(!g.nodes.length){box.innerHTML=empty('当前文献集未达到关键词频次门槛（至少 2 篇）。');$('edgeList').innerHTML='';$('networkNote').textContent='';return;}
    let seed=([...current.config.query].reduce((a,c)=>a+c.charCodeAt(0),731)+g.nodes.length)>>>0;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
    const max=Math.max(...g.nodes.map(n=>n.count)),nodes=g.nodes.map((n,i)=>({...n,x:w/2+Math.cos(i*2*Math.PI/g.nodes.length)*Math.min(w,h)*.29+(rand()-.5)*10,y:h/2+Math.sin(i*2*Math.PI/g.nodes.length)*Math.min(w,h)*.30,r:7+Math.sqrt(n.count/max)*17}));
    const map=new Map(nodes.map(n=>[n.id,n]));
    for(let iter=0;iter<180;iter++){
      const forces=new Map(nodes.map(n=>[n.id,{x:0,y:0}]));
      for(let a=0;a<nodes.length;a++)for(let b=a+1;b<nodes.length;b++){
        const x=nodes[a],y=nodes[b],dx=x.x-y.x,dy=x.y-y.y,d=Math.max(3,Math.hypot(dx,dy)),rep=1600/(d*d)+(d<x.r+y.r+25?2.2:0);forces.get(x.id).x+=dx/d*rep;forces.get(x.id).y+=dy/d*rep;forces.get(y.id).x-=dx/d*rep;forces.get(y.id).y-=dy/d*rep;
      }
      g.edges.forEach(e=>{const a=map.get(e.source),b=map.get(e.target),dx=b.x-a.x,dy=b.y-a.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-88)*.005;forces.get(a.id).x+=dx/d*f;forces.get(a.id).y+=dy/d*f;forces.get(b.id).x-=dx/d*f;forces.get(b.id).y-=dy/d*f;});
      nodes.forEach(n=>{const f=forces.get(n.id),cool=1-iter/230;n.x=Math.max(35,Math.min(w-35,n.x+(f.x+(w/2-n.x)*.002)*cool*2.2));n.y=Math.max(38,Math.min(h-38,n.y+(f.y+(h/2-n.y)*.002)*cool*2.2));});
    }
    const labels=[],boxes=[];
    nodes.forEach((n,i)=>{
      const length=[...n.label].reduce((a,c)=>a+(c.charCodeAt(0)>255?11:6.5),0),width=Math.min(w-20,length),candidates=[{x:n.x-width/2,y:n.y-n.r-8},{x:n.x-width/2,y:n.y+n.r+18},{x:n.x+n.r+7,y:n.y+4},{x:n.x-n.r-width-7,y:n.y+4}];
      let best=null;
      for(const p of candidates){const r={x:Math.max(8,Math.min(w-width-8,p.x)),y:Math.max(15,Math.min(h-10,p.y)),w:width,h:14};const overlap=boxes.some(b=>r.x<b.x+b.w+4&&r.x+r.w+4>b.x&&r.y-12<b.y+4&&r.y+4>b.y-12);if(!overlap){best=r;break;}}
      if(best){boxes.push(best);labels.push(`<text x="${best.x}" y="${best.y}">${esc(n.label)}</text>`);}
    });
    const largest=Math.max(1,...g.edges.map(e=>current.config.edgeWeight==='count'?e.count:e.cosine));
    let html=svgOpen('networkSvg',w,h,'当前文献集关键词共现网络');
    g.edges.forEach(e=>{const a=map.get(e.source),b=map.get(e.target),weight=current.config.edgeWeight==='count'?e.count:e.cosine;html+=`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#bad0b8" stroke-opacity=".52" stroke-width="${.6+weight/largest*3}"/>`;});
    nodes.forEach((n,i)=>html+=`<g class="network-node" data-term="${esc(n.label)}" tabindex="0" role="button" aria-label="检索 ${esc(n.label)}" data-tip="${esc(n.label)} · ${n.count} 条关键词记录"><circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${i===0?'#397552':i<8?'#79a174':'#afc59d'}" stroke="#fff" stroke-width="1.3"/></g>`);
    html+=labels.join('')+'</svg>';box.innerHTML=html;
    $('edgeList').innerHTML=g.edges.length?g.edges.slice(0,14).map(e=>`<div class="edgerow"><div><b>${esc(map.get(e.source).label)} × ${esc(map.get(e.target).label)}</b><small>余弦关联 ${e.cosine.toFixed(3)}</small></div><span>${e.count} 篇</span></div>`).join(''):empty('共现门槛下没有连线。可调低最少共现数。');
    $('networkNote').textContent=`展示 ${nodes.length} 个高频词，${g.edges.length} / ${g.totalEdges} 条满足门槛的边。节点布局用于阅读，不表示机制距离或因果。`;
  }
  function drawMatrix(){
    if(!current)return;const m=current.matrix,box=$('matrixChart'),w=Math.max(280,box.clientWidth),h=338,left=w<450?105:130,top=111,right=w<450?55:40,bottom=30;
    if(!m.x.length||!m.y.length){box.innerHTML=empty('当前文献集没有足够的词典实体提及。');$('directions').innerHTML='';return;}
    const cw=(w-left-right)/m.x.length,ch=Math.min(25,(h-top-bottom)/m.y.length),max=Math.max(1,...m.cells.map(c=>c.count));
    let html=svgOpen('matrixSvg',w,h,`${m.left}与${m.right}同文献术语提及矩阵`);
    m.x.forEach((x,i)=>{const px=left+cw*(i+.5);html+=`<text transform="translate(${px},${top-12}) rotate(-55)" text-anchor="start" data-tip="${esc(x.label)}">${esc(x.label)}</text>`;});
    m.y.forEach((y,i)=>html+=`<text x="${left-9}" y="${top+ch*(i+.5)+4}" text-anchor="end" data-tip="${esc(y.label)}">${esc(y.label)}</text>`);
    m.cells.forEach(c=>{const strength=Math.sqrt(c.count/max),rgb=[Math.round(241-strength*189),Math.round(245-strength*119),Math.round(234-strength*139)];html+=`<g class="matrix-cell" data-pair="${esc(m.y[c.y].label)}|${esc(m.x[c.x].label)}" tabindex="0" role="button" aria-label="查看支持文献 ${esc(m.y[c.y].label)} 与 ${esc(m.x[c.x].label)}，${c.count} 条" data-tip="${esc(m.y[c.y].label)} × ${esc(m.x[c.x].label)}：${c.count} 条同文献提及"><rect x="${left+c.x*cw+1}" y="${top+c.y*ch+1}" width="${cw-2}" height="${ch-2}" rx="2" fill="rgb(${rgb.join(',')})"/><text x="${left+(c.x+.5)*cw}" y="${top+(c.y+.5)*ch+4}" text-anchor="middle" style="fill:${strength>.65?'#fff':'#6e8063'}">${c.count||'·'}</text></g>`;});
    html+=`<text x="${left}" y="${top+ch*m.y.length+21}" class="axis-title">格内数值：同时提及两类术语的文献记录数</text></svg>`;box.innerHTML=html;
    $('directions').innerHTML=m.directions.length?m.directions.map(d=>`<button class="direction" data-pair="${esc(d.a)}|${esc(d.b)}"><span>${esc(d.a)} × ${esc(d.b)}</span><b>${d.count} 篇</b></button>`).join(''):empty('支持记录不足 3 条，暂不列方向组合。');
  }
  function drawTrend(){
    if(!current)return;const box=$('trendChart'),rows=current.monthly,w=Math.max(280,box.clientWidth),h=340,left=55,right=20,top=25,bottom=65,share=$('trendMetric').value==='share'&&!!current.config.query;
    if(!rows.some(r=>r.base)){box.innerHTML=empty('当前筛选下没有刊期完整的期刊可比较。可以取消完整期刊限制，但须留意收录偏差。');$('trendNote').textContent='完整刊期比较集：0 本期刊。';return;}
    const vals=rows.map(r=>share?r.share:r.hits),max=Math.max(share?.5:1,...vals.filter(v=>v!==null))*1.13,x=i=>left+(rows.length<2?(w-left-right)/2:i*(w-left-right)/(rows.length-1)),y=v=>h-bottom-v/max*(h-top-bottom);
    let svg=svgOpen('trendSvg',w,h,share?'按刊期月份推算的话题文献占比':'按刊期月份推算的匹配记录数');
    for(let i=0;i<=4;i++){const value=max*i/4,yy=y(value);svg+=`<line x1="${left}" y1="${yy}" x2="${w-right}" y2="${yy}" stroke="#e8eddf"/><text x="${left-10}" y="${yy+4}" text-anchor="end">${share?value.toFixed(value<2?1:0):Math.round(value)}</text>`;}
    svg+=`<text x="${left}" y="14" class="axis-title">${share?'占比（%）':'记录数（条）'}</text><text x="${(w+left-right)/2}" y="${h-8}" text-anchor="middle" class="axis-title">刊期月份（按出版周期推算）</text>`;
    let segments=[],segment=[];vals.forEach((v,i)=>{if(v===null){if(segment.length)segments.push(segment);segment=[];}else segment.push([x(i),y(v)]);});if(segment.length)segments.push(segment);
    segments.forEach(points=>svg+=`<path d="${points.map((p,i)=>(i?'L':'M')+p.join(',')).join(' ')}" fill="none" stroke="#4d8260" stroke-width="2.3"/>`);
    rows.forEach((r,i)=>{if(i%Math.ceil(rows.length/(w<450?4:7))===0||i===rows.length-1)svg+=`<text x="${x(i)}" y="${h-bottom+23}" text-anchor="middle">${r.period.slice(2).replace('-','.')}</text>`;if(vals[i]!==null)svg+=`<g data-tip="${r.period}：命中 ${r.hits} / 基础记录 ${r.base}，占比 ${r.share.toFixed(2)}%"><circle cx="${x(i)}" cy="${y(vals[i])}" r="14" fill="transparent"/><circle cx="${x(i)}" cy="${y(vals[i])}" r="3.8" fill="#598966" stroke="white"/></g>`;});
    svg+='</svg>';box.innerHTML=svg;
    $('trendNote').textContent=`趋势比较集 ${current.trendCohortJournals} 本期刊；${current.config.completeTrend?'仅纳入原快照整个一年范围收录完整的期刊。':'已包含刊期不完整的期刊，波动可能受缺期影响。'} ${share?'占比分母为比较集当月基础筛选记录数。':current.config.query?'按月显示命中记录数；发文量与收录差异可能影响波动。':'空检索式时显示基础记录量，不能据此判断某个主题升温。'}`;
  }
  function paperIndices(){return paperEvidence?paperEvidence.indices:current.indices;}
  function showEvidencePair(a,b){
    const ai=corpus.entities.findIndex(e=>e.label===a),bi=corpus.entities.findIndex(e=>e.label===b);
    paperEvidence={a,b,indices:current.indices.filter(i=>docs[i].e.includes(ai)&&docs[i].e.includes(bi))};
    paperPage=0;renderPapers();$('papers').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function renderPapers(){
    if(!current)return;const pageSize=20,total=Math.max(1,Math.ceil(paperIndices().length/pageSize));paperPage=Math.min(paperPage,total-1);
    $('paperCount').innerHTML=paperEvidence?`${paperEvidence.label?'文献证据子集':'矩阵证据子集'}：${esc(paperEvidence.label||(paperEvidence.a+' × '+paperEvidence.b))}，${num(paperIndices().length)} 条 / 当前分析集 ${num(current.stats.hits)} 条 <button id="clearEvidence" class="quiet">恢复全部命中</button>`:`${num(current.stats.hits)} 条命中 · 按推算刊期由近到远排列，每页 20 条。可展开摘要，并使用 DOI / 原站链接回溯。`;$('exportPapers').textContent=paperEvidence?'导出证据子集 CSV ↓':'导出当前文献 CSV ↓';if($('clearEvidence'))$('clearEvidence').onclick=()=>{paperEvidence=null;paperPage=0;renderPapers();};
    $('paperList').innerHTML=paperIndices().slice(paperPage*pageSize,(paperPage+1)*pageSize).map(i=>{const d=docs[i],j=corpus.journals[d.j];return `<article class="paper"><div class="paper-top"><span>${esc(j.name)}</span><span>${d.year} 年 ${d.issue} 期</span><span>${esc(d.id)}</span>${d.dup>=0?'<span class="badge">同 DOI 同标题重复记录</span>':''}${d.suspect?'<span class="badge">疑似非研究内容，需核查</span>':''}</div><h3><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a></h3><div class="authors">${esc(d.authors)}</div><div class="kw">关键词：${esc(d.keywords||'源数据未提供')}</div><p class="excerpt">${esc(d.abstract?d.abstract.slice(0,150)+(d.abstract.length>150?'…':''):d.summary_kind==='body_excerpt'?'源字段为正文摘录，未作为摘要分析。':'源数据仅有占位内容或未提供可用摘要。')}</p><details><summary>展开摘要与元数据</summary><p>${esc(d.abstract||'没有可用摘要。')}</p><div class="fieldline">作者单位：${esc(d.affiliations||'未提供')}</div><div class="fieldline">页码：${esc(d.pages)} · DOI：${esc(d.doi||'未返回')} · 月份归入 ${meta.periods[d.p]}（推算）</div></details></article>`;}).join('')||empty('没有符合检索条件的文献。请检查检索字段、同义词选项和筛选范围。');
    $('pageLabel').textContent=`第 ${paperPage+1} / ${total} 页`;$('prevPage').disabled=paperPage===0;$('nextPage').disabled=paperPage>=total-1;
  }
  $('prevPage').onclick=()=>{paperPage--;renderPapers();};$('nextPage').onclick=()=>{paperPage++;renderPapers();};
  function download(name,content,type='text/plain;charset=utf-8'){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  function csv(rows,columns){return '\ufeff'+[columns,...rows.map(r=>columns.map(k=>r[k]??''))].map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');}
  const filename=label=>'岐研_'+label+'_'+(current?.config.query||'全库').replace(/[^\w\u4e00-\u9fff-]/g,'_').slice(0,45);
  $('exportPapers').onclick=()=>{if(!current||pending)return;const rows=paperIndices().map(i=>{const d=docs[i];return {id:d.id,journal:corpus.journals[d.j].name,year:d.year,issue:d.issue,inferred_month:meta.periods[d.p],title:d.title,authors:d.authors,abstract:d.abstract,keywords:d.keywords,doi:d.doi,url:d.url,duplicate_of:d.dup>=0?docs[d.dup].id:'',summary_kind:d.summary_kind};});download(filename('命中文献')+'.csv',csv(rows,['id','journal','year','issue','inferred_month','title','authors','abstract','keywords','doi','url','duplicate_of','summary_kind']),'text/csv;charset=utf-8');};
  $('exportConfig').onclick=()=>{if(!current||pending)return;download(filename('分析快照')+'.json',JSON.stringify({created_at:new Date().toISOString(),corpus:meta,provenance:current.provenance,lexicon:corpus.lexicon,matched_document_ids:current.indices.map(i=>docs[i].id),paper_evidence:paperEvidence?{label:paperEvidence.label,a:paperEvidence.a,b:paperEvidence.b,document_ids:paperEvidence.indices.map(i=>docs[i].id)}:null,keyword_summary:current.keywords,network:current.network,matrix:current.matrix,monthly:current.monthly,journals:current.journals},null,2),'application/json');};
  function allKeywordRows(){
    const counts=new Map(),spreads=new Map();
    current.indices.forEach(i=>docs[i].k.forEach(k=>{
      if(current.config.hideGeneric&&corpus.terms[k].generic)return;
      counts.set(k,(counts.get(k)||0)+1);if(!spreads.has(k))spreads.set(k,new Set());spreads.get(k).add(docs[i].j);
    }));
    return [...counts].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).map(([id,count])=>({label:corpus.terms[id].label,count,pct:current.stats.withKeywords?count/current.stats.withKeywords*100:0,journals:spreads.get(id).size}));
  }
  function exportTable(kind){
    if(!current||pending)return;
    if(kind==='keywords')download(filename('关键词')+'.csv',csv(allKeywordRows(),['label','count','pct','journals']),'text/csv;charset=utf-8');
    if(kind==='journals')download(filename('期刊分布')+'.csv',csv(current.journals,['label','count','base','share','complete']),'text/csv;charset=utf-8');
    if(kind==='network'){const labels=new Map(current.network.nodes.map(n=>[n.id,n.label]));download(filename('共词边表')+'.csv',csv(current.network.edges.map(e=>({source:labels.get(e.source),target:labels.get(e.target),cooccurrence:e.count,cosine:e.cosine})),['source','target','cooccurrence','cosine']),'text/csv;charset=utf-8');}
  }
  function exportSvg(id){
    const svg=$(id);if(!svg||pending)return;
    const copy=svg.cloneNode(true),ns='http://www.w3.org/2000/svg',vb=svg.viewBox.baseVal,w=vb.width,h=vb.height;
    copy.setAttribute('xmlns',ns);copy.setAttribute('viewBox',`0 0 ${w} ${h+82}`);
    copy.setAttribute('width',w);copy.setAttribute('height',h+82);
    const group=document.createElementNS(ns,'g');group.setAttribute('transform','translate(0,52)');
    while(copy.firstChild)group.appendChild(copy.firstChild);copy.appendChild(group);
    const background=document.createElementNS(ns,'rect');background.setAttribute('width','100%');background.setAttribute('height','100%');background.setAttribute('fill','white');copy.insertBefore(background,group);
    const style=document.createElementNS(ns,'style');style.textContent='text{font-family:Arial,"PingFang SC",sans-serif;font-size:11px;fill:#53664e}';copy.insertBefore(style,background);
    const line=(y,text,size=11)=>{const t=document.createElementNS(ns,'text');t.setAttribute('x','14');t.setAttribute('y',y);t.setAttribute('style',`font-size:${size}px`);t.textContent=text;copy.appendChild(t);};
    line(21,(current.config.query||'全部文献')+' · '+current.stats.hits+' 条匹配记录',13);
    line(41,meta.periods[current.config.from]+' — '+meta.periods[current.config.to]+' · '+(current.config.dedup?'保守去重':'保留重复')+' · '+(current.config.expand?'扩展同义词':'字面匹配'));
    line(h+73,'岐研 · 本批期刊样本 · '+(id==='trendSvg'?'月份由刊期推算；趋势比较集 '+current.trendCohortJournals+' 刊':'术语共现不表示因果或证据质量'),10);
    const metadata=document.createElementNS(ns,'metadata');metadata.textContent=JSON.stringify({corpus_sha256:meta.corpus_sha256,parameters:current.config,chart:id});copy.appendChild(metadata);
    download(filename(id)+'.svg',new XMLSerializer().serializeToString(copy),'image/svg+xml');
  }
  document.addEventListener('click',event=>{const target=event.target.closest('[data-term],[data-pair],[data-journal],[data-export],[data-svg]');if(!target)return;if(target.dataset.term)addTerm(target.dataset.term);else if(target.dataset.pair){const [a,b]=target.dataset.pair.split('|');showEvidencePair(a,b);}else if(target.dataset.journal!==undefined){$('journal').value=target.dataset.journal;analyze();}else if(target.dataset.export)exportTable(target.dataset.export);else if(target.dataset.svg)exportSvg(target.dataset.svg);});
  document.addEventListener('keydown',event=>{const node=event.target.closest('.network-node,.matrix-cell');if(node&&['Enter',' '].includes(event.key)){event.preventDefault();node.dispatchEvent(new MouseEvent('click',{bubbles:true}));}});
  const tip=$('tooltip');document.addEventListener('pointermove',event=>{const target=event.target.closest('[data-tip]');if(!target){tip.hidden=true;return;}tip.textContent=target.dataset.tip;tip.hidden=false;const r=tip.getBoundingClientRect();tip.style.left=Math.max(8,Math.min(innerWidth-r.width-8,event.clientX+15))+'px';tip.style.top=Math.max(8,Math.min(innerHeight-r.height-8,event.clientY+15))+'px';});document.addEventListener('pointerleave',()=>tip.hidden=true);
  function methods(){
    $('methodBody').innerHTML=`<p><b>${num(meta.records)} 条记录，${meta.journals} 刊，${meta.scope}。</b>仅描述这批样本，不代表所有中医药文献。原快照 37 个计划期次尚无接口记录；18 条当时提前上线的目录和 73 条月份待核的增刊没有混入本分析。</p><h3>计数与去重</h3><ul><li>每篇每个关键词只计一次；占比使用当前有关键词记录数作分母。</li><li>默认合并“同 DOI 且规范化标题相同”的重复记录，共 ${meta.duplicate_records} 条，可随时取消。缺 DOI 或同 DOI 不同标题不会自动合并。</li><li>默认保留全部目录，疑似稿约、名单、证书等可选择排除；这个规则不是人工研究设计分类。</li><li>作者单位未经完整消歧，本版不生成作者合作或机构影响力排名。</li></ul><h3>图谱与趋势</h3><ul><li>共词网络按同一篇关键词的共现建边；余弦关联＝共现篇数 / √(两词各自篇数之积)。可调整节点数、共现门槛和排序；最多显示 100 条边。</li><li>矩阵按标题＋关键词＋可用摘要中的词典术语字面提及计数，不能证明实际使用某方法或存在某机制关系。</li><li>月份根据期号与出版周期推算，不使用可能保留网络首发日期的 api_date。</li><li>完整趋势集 ${meta.complete_journals} 本，要求原一年范围所有计划常规期次都有记录。切换筛选条件会继续约束比较集。占比只能降低发文量差异，不能消除所有收录偏差。</li><li>仅近一年，不做可靠的长期增长或突现结论。缺参考文献、被引计数，不做共被引、耦合或高被引排名。</li></ul><h3>词典 ${esc(corpus.lexicon.version)}</h3><p>${esc(corpus.lexicon.note)}</p><table><thead><tr><th>规范词</th><th>扩展形式</th></tr></thead><tbody>${Object.entries(corpus.lexicon.aliases).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v.join('；'))}</td></tr>`).join('')}</tbody></table><h3>隐藏的泛化词</h3><p>${esc(corpus.lexicon.generic_terms.join('、'))}。取消“隐藏泛化词”即可恢复。</p><h3>复现与导出</h3><p>分析快照 JSON 包含参数、检索树、文献 ID、词典版本、原语料 SHA-256 及图表数据。CSV 和 SVG 导出均来自当前筛选结果。没有把语言模型生成的描述用作计量数据。</p><p>原语料 SHA-256：<code>${esc(meta.corpus_sha256)}</code></p>`;
    $('methodDialog').showModal();
  }
  $('methodOpen').onclick=methods;$('methodOpen2').onclick=methods;$('methodClose').onclick=()=>$('methodDialog').close();
  const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(current){drawNetwork();drawMatrix();drawTrend();}},140);});['networkChart','matrixChart','trendChart'].forEach(id=>observer.observe($(id)));
  try{
    const code=$('engine-code').textContent+'\nlet atlas;self.onmessage=function(e){const m=e.data;if(m.type==="init"){atlas=self.createAtlasEngine(m.data);self.postMessage({ready:true});return;}try{self.postMessage({id:m.id,result:atlas.analyze(m.config)});}catch(error){self.postMessage({id:m.id,error:error.message});}};';
    const url=URL.createObjectURL(new Blob([code],{type:'text/javascript'}));worker=new Worker(url);worker.onmessage=e=>{if(e.data.ready){URL.revokeObjectURL(url);analyze();}else receive(e.data);};
    worker.onerror=()=>{worker.terminate();worker=null;const fn=new Function($('engine-code').textContent+';return globalThis.createAtlasEngine;')();fallback=fn(corpus);analyze();};worker.postMessage({type:'init',data:corpus});
  }catch(error){const fn=new Function($('engine-code').textContent+';return globalThis.createAtlasEngine;')();fallback=fn(corpus);analyze();}
  let previewEngine;
  window.atlasApp={getResult:()=>current,getCorpus:()=>corpus,search:(q,field)=>{if(field)$('field').value=field;runQuery(q);},preview:(q,field,parameters)=>{if(!current)throw new Error('语料尚未就绪');if(!previewEngine)previewEngine=new Function($('engine-code').textContent+';return globalThis.createAtlasEngine;')()(corpus);return previewEngine.analyze({...(parameters||current.config),query:q,field:field||(parameters||current.config).field}).stats.hits;},showPaperSubset:(ids,label)=>{const byId=new Map(current.indices.map(i=>[docs[i].id,i]));paperEvidence={label,indices:ids.filter(id=>byId.has(id)).map(id=>byId.get(id))};paperPage=0;renderPapers();$('papers').scrollIntoView({behavior:'smooth',block:'start'});}};
  window.atlasDebug={getResult:()=>current,getConfig:config,query:runQuery,corpusMeta:meta};
})();
