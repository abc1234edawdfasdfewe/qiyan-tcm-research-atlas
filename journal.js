(() => {
  'use strict';
  const $=id=>document.getElementById(id),app=window.atlasApp,client=window.atlasAIClient,corpus=app.getCorpus();
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const byId=new Map(corpus.docs.map(d=>[d.id,d]));
  let report=null,worker=null,working=false,aiBusy=false,aiReport=null,aiSignature='',abort=null,selected=null,importGeneration=0;
  const fields=['jfTitle','jfAbstract','jfKeywords','jfFocus','jfPriority','jfType'];
  const input=()=>({title:$('jfTitle').value.trim(),abstract:$('jfAbstract').value.trim(),keywords:$('jfKeywords').value.trim(),focus:$('jfFocus').value.trim(),priority:$('jfPriority').value,article_type:$('jfType').value});
  const signature=()=>JSON.stringify(input());
  const stale=()=>!!report&&JSON.stringify(report.input)!==signature();
  const visible=()=>report?report.journals.filter(j=>(!$('jfComplete').checked||j.complete)&&j.name.includes($('jfJournalSearch').value.trim())):[];
  const candidates=()=>visible().filter(j=>j.nearby>0&&j.evidence.length).slice(0,6).map(j=>({code:j.code,ids:j.evidence.slice(0,3).map(p=>p.id)}));
  const sendSignature=()=>JSON.stringify({input:report?.input,candidates:candidates()});
  function message(id,text){$(id).textContent=text||'';$(id).hidden=!text;}
  function coverage(j){return `${j.available}/${j.expected} 期${j.complete?'':' · 有缺期'}`;}
  function liveControls(){
    $('jfRun').disabled=working||aiBusy;$('jfFile').disabled=working||aiBusy;$('jfExample').disabled=working||aiBusy;
    $('jfAiRun').disabled=working||aiBusy||!report||stale()||!$('jfConsent').checked||!candidates().length||!client.status().configured;
    $('jfAiStop').hidden=!aiBusy;$('jfAiExport').disabled=!aiReport;
    if(report)$('jfStale').hidden=!stale();
    $('jfAiStale').hidden=!aiReport||(!stale()&&aiSignature===sendSignature());
  }
  function updateSend(){
    if(!report)return;
    const list=candidates(),papers=list.reduce((s,j)=>s+j.ids.length,0);
    $('jfSendScope').textContent=`将发送 ${list.length} / ${corpus.journals.length} 刊、${papers} 篇近题论文（每篇摘要最多 1400 字符）及下方稿件字段。候选：${list.map(j=>corpus.journals.find(x=>x.code===j.code).name).join('；')||'当前列表没有可用近邻'}。${client.status().offline?'当前为离线页面，请通过本地服务版调用 AI。':!client.status().configured?'请先配置模型连接。':''}`;
    const p=report.input;$('jfSendPreview').textContent=`题目：${p.title}\n摘要：${p.abstract||'未填写'}\n关键词：${p.keywords||'未填写'}\n突出内容：${p.focus||'未填写'}\n匹配侧重：${p.priority}\n稿件类型：${p.article_type}`;
    liveControls();
  }
  function renderDetail(code){
    const j=report?.journals.find(x=>x.code===code);if(!j)return;selected=code;
    document.querySelectorAll('#jfTable tr').forEach(tr=>tr.setAttribute('aria-selected',String(tr.dataset.code===code)));
    $('jfDetail').innerHTML=`<div class="eyebrow">EVIDENCE / ${esc(j.code)}</div><h3>${esc(j.name)}</h3><p>匹配分 <b>${j.score.toFixed(1)}</b> · 近题 ${j.nearby} / 样本 ${j.total} 条（${(j.share*100).toFixed(1)}%）<br>计划刊期收录 ${coverage(j)}${!j.complete?`；缺少：${esc(j.missing||'见覆盖记录')}`:''}</p>${j.signals.length?`<div class="jf-signal">题名 / 关键词中的概念提及（可交叉计数）<br>${j.signals.map(s=>`${esc(s.label)} ${s.count} 篇`).join(' · ')}</div>`:''}<p>下列为该刊最高分近邻，低于近题阈值的记录仅供参考。匹配基于题录与摘要，未读取全文。</p>${j.evidence.length?j.evidence.map((p,i)=>{const d=byId.get(p.id);return `<div class="jf-neighbor"><div class="eyebrow">${String(i+1).padStart(2,'0')} / ${esc(d.year)} 年 ${esc(d.issue)} 期 · 近邻分 ${(p.score*100).toFixed(1)}${p.score<report.threshold?' · 弱线索':''}</div><h4>${esc(d.title)}</h4><p>${p.review?'疑似综述 / 讨论类题名，已按稿件类型调权。':'研究类型需人工核对。'}${!d.abstract?' 原库无可用摘要。':''}</p><div>${p.matches.slice(0,8).map(m=>`<span class="jf-tag">${esc(m.term)} · ${esc(m.field)}</span>`).join('')||'<span class="footnote">词项相似，暂无结构化概念标签</span>'}</div><button data-jf-paper="${esc(d.id)}">查看摘要与原始来源 ↗</button></div>`;}).join(''):'<p>未找到达到展示阈值的近邻，不据此判断该刊不接收此主题。</p>'}`;
  }
  function render(){
    if(!report)return;$('jfResults').hidden=false;
    $('jfSummary').textContent=`${report.scope} · ${report.total_records.toLocaleString('zh-CN')} 条可比较记录 · 独立于话题检索筛选。数据快照：${report.snapshot}。${report.journals[0]?.nearby?'':' 未发现达到阈值的近题记录，请补充摘要或关键词后再判断。'}`;
    $('jfFeatures').innerHTML=report.features.length?report.features.map(g=>`<span class="jf-tag">${g.kind==='method'?'方法':'对象'} / ${esc(g.label)}</span>`).join(''):'<span class="footnote">未触发预设方法 / 对象概念，当前以稿件词项匹配。可补充关键词提高可解释性。</span>';
    const list=visible();$('jfVisibleCount').textContent=`显示 ${list.length} / ${report.journal_count} 刊`;
    $('jfTop').innerHTML=list.slice(0,3).map((j,i)=>`<article class="jf-card"><div class="jf-rank"><span>题材排序 ${String(i+1).padStart(2,'0')}</span><span class="jf-score">${j.score.toFixed(1)}</span></div><h3>${esc(j.name)}</h3><p>近题 ${j.nearby} / ${j.total} 条 · ${(j.share*100).toFixed(1)}%<br>计划刊期收录 ${coverage(j)}</p><ul>${j.evidence.slice(0,2).map(p=>`<li>${esc(byId.get(p.id).title)}</li>`).join('')||'<li>暂无足够强的近题记录</li>'}</ul><button data-jf-journal="${esc(j.code)}">比较这本期刊的依据 ↘</button></article>`).join('')||'<div class="jf-empty">没有符合显示条件的期刊，请调整刊名或完整度筛选。</div>';
    $('jfTable').innerHTML=list.map(j=>`<tr data-code="${esc(j.code)}"><td><button data-jf-journal="${esc(j.code)}">${esc(j.name)}</button></td><td>${j.score.toFixed(1)}</td><td>${j.nearby} / ${j.total}</td><td>${coverage(j)}</td></tr>`).join('');
    if(!list.length)$('jfDetail').innerHTML='<p>调整显示条件后可继续查看论文依据。</p>';else renderDetail(list.some(j=>j.code===selected)?selected:list[0].code);
    updateSend();
  }
  function initWorker(){
    if(worker)return;
    const source=$('journal-engine-code').textContent+`\nlet matcher;self.onmessage=e=>{try{if(e.data.corpus)matcher=createJournalMatcher(e.data.corpus);const report=matcher.match(e.data.input);self.postMessage({report});}catch(error){self.postMessage({error:error.message});}};`;
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));worker=new Worker(url);URL.revokeObjectURL(url);
    worker.onmessage=e=>{working=false;$('jfProgress').hidden=true;if(e.data.error){message('jfError',e.data.error);liveControls();return;}report=e.data.report;aiReport=null;$('jfAiOutput').innerHTML='';$('jfConsent').checked=false;render();$('live').textContent='67 刊选刊匹配已完成。';};
    worker.onerror=()=>{working=false;message('jfError','本地匹配未完成，请缩短摘要后重试。');$('jfProgress').hidden=true;worker?.terminate();worker=null;liveControls();};
  }
  function match(event){
    event?.preventDefault();if(working||aiBusy)return;message('jfError','');
    const p=input();if((p.title+p.abstract).length<6){message('jfError','请补充至少 6 字的稿件题目或摘要。');$('jfTitle').focus();return;}
    if($('jfImportNote').textContent.startsWith('已填入虚构'))message('jfImportNote','当前使用虚构的功能演示摘要，不包含用户原稿数据。');
    working=true;$('jfProgress').hidden=false;const isNew=!worker;initWorker();liveControls();worker.postMessage({input:p,...(isNew?{corpus}:{})});
  }
  function changed(){importGeneration++;$('jfConsent').checked=false;liveControls();}
  fields.forEach(id=>{$(id).addEventListener('input',changed);$(id).addEventListener('change',changed);});
  $('jfForm').onsubmit=match;
  $('jfExample').onclick=()=>{
    const demo={title:'面向中医古籍医案的实体关系抽取与知识组织方法研究',abstract:'目的：探索中医古籍医案的结构化方法。方法：结合大语言模型、检索增强和多智能体审核，识别古籍文本中的实体及关系，并与单轮抽取方法进行对照，通过消融实验评价各模块贡献。结果：报告实体与关系抽取的精确率、召回率和F1，核查错误案例，并展示结构化知识图谱及查询实例。结论：评价该流程在古籍知识整理中的可行性及局限。',keywords:'中医古籍；医案；实体关系抽取；大语言模型；检索增强',focus:'实体识别；关系抽取',priority:'method',article_type:'original'};
    fields.forEach((id,i)=>$(id).value=demo[['title','abstract','keywords','focus','priority','article_type'][i]]);changed();message('jfImportNote','已填入虚构的功能演示摘要，不包含用户原稿数据。点击“匹配”开始。');
  };
  $('jfClear').onclick=()=>{importGeneration++;abort?.abort();worker?.terminate();worker=null;working=false;report=null;aiReport=null;fields.slice(0,4).forEach(id=>$(id).value='');$('jfPriority').value='balanced';$('jfType').value='original';$('jfFile').value='';$('jfConsent').checked=false;$('jfResults').hidden=true;$('jfProgress').hidden=true;$('jfAiOutput').innerHTML='';['jfImportNote','jfError','jfAiStatus','jfAiError'].forEach(id=>message(id,''));liveControls();};
  $('jfFile').onchange=async()=>{
    const file=$('jfFile').files[0];if(!file)return;const generation=++importGeneration;
    message('jfError','');if(!file.name.toLowerCase().endsWith('.docx')||file.size>20*1024*1024){message('jfError','请选择不超过 20 MB 的 DOCX 文件。');$('jfFile').value='';return;}
    message('jfImportNote','正在本机解析 DOCX…');$('jfFile').disabled=true;
    try{
      const bytes=await new Promise((resolve,reject)=>{const reader=new FileReader(),deadline=setTimeout(()=>{reject(new Error('浏览器暂时无法读取此文件。请另存到普通文件夹后重试，或直接粘贴摘要。'));reader.abort();},15000);reader.onload=()=>{clearTimeout(deadline);resolve(new Uint8Array(reader.result));};reader.onerror=()=>{clearTimeout(deadline);reject(new Error('浏览器无法读取此文件，请检查本机文件访问权限或直接粘贴摘要。'));};reader.onabort=()=>clearTimeout(deadline);reader.readAsArrayBuffer(file);});
      if(generation!==importGeneration)return;
      let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
      const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),20000);let data;
      try{data=await client.post('/api/manuscript',{base64:btoa(binary)},controller.signal);}finally{clearTimeout(deadline);}
      if(generation!==importGeneration)return;$('jfTitle').value=data.title;$('jfAbstract').value=data.abstract;$('jfKeywords').value=data.keywords;changed();message('jfImportNote',data.warnings.join(' '));
    }
    catch(e){if(generation===importGeneration){message('jfError',e.name==='AbortError'?'本机导入请求超时，请重试或粘贴摘要。':e.message);message('jfImportNote','');}}finally{$('jfFile').value='';liveControls();}
  };
  ['jfJournalSearch','jfComplete'].forEach(id=>$(id).addEventListener('input',()=>{$('jfConsent').checked=false;render();}));
  $('jfResults').addEventListener('click',event=>{const b=event.target.closest('[data-jf-journal],[data-jf-paper]');if(!b)return;if(b.dataset.jfJournal){renderDetail(b.dataset.jfJournal);$('jfDetail').scrollIntoView({behavior:'smooth',block:'nearest'});}else paper(b.dataset.jfPaper);});
  function paper(id){const d=byId.get(id);if(!d)return;$('jfPaperBody').innerHTML=`<p class="footnote">${esc(corpus.journals[d.j].name)} · ${esc(d.year)} 年 ${esc(d.issue)} 期 · ${esc(d.id)}</p><h3>${esc(d.title)}</h3><p>作者：${esc(d.authors||'未提供')}</p><p>关键词：${esc(d.keywords||'未提供')}</p><div class="jf-fullabstract">${esc(d.abstract||'源库未提供可用摘要；请回查原始来源。')}</div><p>DOI：${esc(d.doi||'未提供')}</p>${/^https?:\/\//.test(d.url)?`<a href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">打开 DOI / 原始来源 ↗</a>`:''}`;$('jfPaperDialog').showModal();}
  $('jfPaperClose').onclick=()=>$('jfPaperDialog').close();
  const download=(ext,content)=>{const url=URL.createObjectURL(new Blob([content],{type:ext==='json'?'application/json':'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=`岐研_选刊${ext==='md'?'报告':'结果'}_${new Date().toISOString().slice(0,10)}.${ext}`;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);};
  function citation(id){const d=byId.get(id);return `${d.title}．${corpus.journals[d.j].name}，${d.year}(${d.issue})．ID: ${d.id}．DOI: ${d.doi||'未提供'}．${d.url||''}`;}
  function markdown(){
    const p=report.input,lines=['# 岐研选刊匹配报告','',`生成时间：${report.created_at}`,`稿件题目：${p.title}`,`摘要：${p.abstract||'未填写'}`,`关键词：${p.keywords}`,`突出内容：${p.focus}`,`匹配侧重：${p.priority}；稿件类型：${p.article_type}`,'',`数据窗口：${report.scope}；快照：${report.snapshot}`,`可比较记录：${report.total_records}；期刊：${report.journal_count}`,`语料 SHA-256：${report.corpus_sha256}`,`算法：${report.version}`,report.method,'','分数仅为本批样本内题材排序，不是录用概率。','',...report.limits.map(x=>'- '+x),''];
    report.journals.forEach((j,i)=>{lines.push(`## ${i+1}. ${j.name}`,'',`匹配分 ${j.score.toFixed(1)}；近题 ${j.nearby}/${j.total}；计划刊期收录 ${coverage(j)}${!j.complete?'；缺期：'+j.missing:''}`,...j.evidence.map(p=>'- '+citation(p.id)+`（近邻分 ${(p.score*100).toFixed(1)}${p.score<report.threshold?'；弱线索':''}）`),'');});return lines.join('\n');
  }
  $('jfExportMd').onclick=()=>{if(report)download('md',markdown());};
  $('jfExportJson').onclick=()=>{if(report)download('json',JSON.stringify({...report,journals:report.journals.map(j=>({...j,evidence:j.evidence.map(p=>({...p,citation:citation(p.id)}))}))},null,2));};
  $('jfSettings').onclick=()=>client.settings();$('jfConsent').onchange=liveControls;window.addEventListener('focus',updateSend);window.addEventListener('atlas:connection',updateSend);
  function renderAi(){
    if(!aiReport)return;const r=aiReport.result,c=aiReport.coverage;
    $('jfAiOutput').innerHTML=`<div class="jf-info">本轮 AI：${c.journals_sent}/${c.corpus_journals} 刊，${c.papers_sent} 篇摘要；${esc(c.selection)}。${c.truncated_abstracts} 篇摘要被截短。</div><p>${esc(r.summary)}</p>${r.recommendations.map((j,i)=>`<article class="jf-ai-rec"><h4>${i+1}. ${esc(corpus.journals.find(x=>x.code===j.journal_code)?.name)}<span class="jf-tag">${esc(j.position)}</span></h4><p><b>题材契合：</b>${esc(j.fit)}</p><p><b>待确认：</b>${esc(j.risks)}</p>${j.changes.length?`<ul>${j.changes.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}${j.refs.map(ref=>{const e=aiReport.evidence.find(p=>p.ref===ref);return `<button class="ai-ref" data-jf-paper="${esc(e.id)}">${esc(ref)} · ${esc(e.title)}</button>`;}).join(' ')}</article>`).join('')}<div class="jf-warning">${[...r.limitations,...aiReport.warnings].map(x=>`<div>${esc(x)}</div>`).join('')}</div><p class="footnote">${esc(aiReport.model)} · ${esc(aiReport.created_at)} · ${aiReport.seconds}s · ${esc(aiReport.prompt_version)}</p>`;
  }
  $('jfAiRun').onclick=async()=>{
    if(aiBusy||!report||stale()||!$('jfConsent').checked)return;const payload={consent:true,manuscript:{...report.input},candidates:candidates()},sig=sendSignature();
    aiBusy=true;abort=new AbortController();message('jfAiError','');message('jfAiStatus','正在比较本轮候选期刊与摘要证据…');liveControls();const controller=abort,deadline=setTimeout(()=>controller.abort(),175000);
    try{const data=await client.post('/api/journal-ai',payload,controller.signal);if(report&&!stale()&&sig===sendSignature()){aiReport={...data,local_manuscript:{...payload.manuscript}};aiSignature=sig;renderAi();}else message('jfAiError','候选或稿件已改变，本轮 AI 结果已丢弃，请重新分析。');}
    catch(e){message('jfAiError',e.name==='AbortError'?'已停止等待。模型服务的请求可能仍在结束，稍后可重试。':e.message);}
    finally{clearTimeout(deadline);abort=null;aiBusy=false;message('jfAiStatus','');liveControls();}
  };
  $('jfAiStop').onclick=()=>abort?.abort();
  $('jfAiExport').onclick=()=>{if(!aiReport)return;const r=aiReport.result,lines=['# 岐研 AI 投稿策略','',`稿件题目：${aiReport.local_manuscript?.title||'见本轮本地报告'}`,`模型：${aiReport.model}；时间：${aiReport.created_at}`,`语料 SHA-256：${aiReport.corpus_sha256}`,'',r.summary,''];r.recommendations.forEach((j,i)=>lines.push(`## ${i+1}. ${corpus.journals.find(x=>x.code===j.journal_code).name} · ${j.position}`,'','题材契合：'+j.fit,'待确认：'+j.risks,...j.changes.map(x=>'- '+x),...j.refs.map(ref=>'['+ref+'] '+citation(aiReport.evidence.find(x=>x.ref===ref).id)),''));lines.push(...r.limitations.map(x=>'- '+x),...aiReport.warnings.map(x=>'- '+x),'',JSON.stringify(aiReport.coverage),'AI 仅作摘要层面的选刊建议，不代表录用概率。');download('md',lines.join('\n'));};
  // Manuscript data intentionally never enters localStorage/sessionStorage or automatic files.
  $('jfCorpusNote').textContent=`${corpus.meta.scope}；采集快照 ${corpus.meta.snapshot}。部分期刊存在缺期，每刊结果单独标明。`;
  window.atlasJournalDebug={report:()=>report,ai:()=>aiReport,busy:()=>working||aiBusy,stale,selected:()=>selected};liveControls();
})();
