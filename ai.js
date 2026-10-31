(() => {
  'use strict';
  const $=id=>document.getElementById(id),app=window.atlasApp;
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const modes={plan:{tab:'aiTabPlan',action:'生成检索方案',heading:'检索方案与建议',label:'你想研究什么？',hint:'AI 提出方案，本地核对命中量；由你选择应用。',welcome:'从一个好问题开始',description:'把研究目的说清楚。AI 会拆解核心概念、补充检索词，并给出可以核对命中数的方案。'},analyze:{tab:'aiTabAnalyze',action:'分析当前结果',heading:'基于文献的研究解读',label:'这批结果中，你最想弄清什么？',hint:'统计覆盖全部命中；摘要阅读范围会单独标明。可在报告之后继续追问。',welcome:'让统计回到研究问题',description:'结合本地频次、期刊分布和本轮选取的摘要，梳理研究方向、方法差异与需要核验的线索。'},refine:{tab:'aiTabRefine',action:'精筛这一批文献',heading:'逐篇相关性初筛',label:'用什么研究问题判断相关性？',hint:'分批判断相关性并核对原文片段。子集切换下方论文清单，图表仍保留原检索范围。',welcome:'从命中到相关',description:'明确你的研究对象、干预或机制。AI 按批阅读摘要，给出相关性理由和可核对的原文片段。'}};
  const labels={direct:'直接相关',partial:'部分相关',exclude:'不相关',uncertain:'信息不足'};
  let mode='plan',connection=null,busy=false,abort=null,timer=null,started=0;
  const records={},questions={plan:'',analyze:'请结合当前结果，分析主要研究方向、方法差异和需要进一步核查的选题线索。',refine:''};
  const cacheKey='qiyan-ai-session-v2';let initialMode='plan';
  try{const cache=JSON.parse(sessionStorage.getItem(cacheKey)||'null');if(cache?.corpus===app.getCorpus().meta.corpus_sha256){for(const m of Object.keys(modes)){const r=cache.records?.[m];if(r?.mode===m&&r.result&&Array.isArray(r.evidence)&&typeof r.local_signature==='string'&&(m!=='plan'||Array.isArray(r.result.strategies))&&(m!=='analyze'||Array.isArray(r.result.findings))&&(m!=='refine'||Array.isArray(r.result.papers)))records[m]=r;if(typeof cache.questions?.[m]==='string')questions[m]=cache.questions[m];}if(modes[cache.mode])initialMode=cache.mode;}}catch(e){}
  function persist(){try{questions[mode]=$('aiQuestion').value;sessionStorage.setItem(cacheKey,JSON.stringify({corpus:app.getCorpus().meta.corpus_sha256,records,questions,mode}));}catch(e){}}
  function signature(r=app.getResult()){return r?JSON.stringify(r.config)+'|'+r.indices.join(','):'';}
  function stale(report){return report&&report.local_signature!==signature();}
  function setBusy(value){busy=value;$('aiRun').disabled=value||!connection?.configured;$('aiStop').hidden=!value;$('aiProgress').hidden=!value;document.querySelectorAll('[data-ai-mode]').forEach(b=>b.disabled=value);if(!value){clearInterval(timer);timer=null;}}
  function setError(message){$('aiError').hidden=!message;$('aiError').textContent=message||'';}
  function updateScope(){
    const r=app.getResult();if(!r){$('aiScope').textContent='正在载入本地文献…';return;}
    $('aiScope').textContent=mode==='plan'?`当前检索：${r.config.query||'全库探索'}。新方案沿用当前期刊、月份及去重筛选。`:`当前命中 ${r.stats.hits.toLocaleString('zh-CN')} 条 · ${r.stats.withAbstract.toLocaleString('zh-CN')} 条有可用摘要 · ${r.stats.journals} 刊。`;
    const old=$('aiBatch').value,n=Number($('aiLimit').value),batches=Math.max(1,Math.ceil(r.stats.hits/n));
    $('aiBatch').innerHTML=Array.from({length:batches},(_,i)=>`<option value="${i*n}">第 ${i+1} 批 · ${i*n+1}–${Math.min(r.stats.hits,(i+1)*n)} 篇</option>`).join('');
    if([...$('aiBatch').options].some(o=>o.value===old))$('aiBatch').value=old;
    if(records[mode])$('aiStale').hidden=!stale(records[mode]);
    $('aiRun').disabled=busy||!connection?.configured||!r;
  }
  function switchMode(next){
    if(busy)return;questions[mode]=$('aiQuestion').value;mode=next;
    document.querySelectorAll('[data-ai-mode]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.aiMode===mode)));
    $('aiBody').setAttribute('aria-labelledby',modes[mode].tab);$('aiQuestionLabel').textContent=modes[mode].label;
    if(mode==='refine'&&!questions.refine)questions.refine=questions.plan||app.getResult()?.config.query||'';
    $('aiQuestion').value=questions[mode];$('aiModeHint').textContent=modes[mode].hint;$('aiAnswerLabel').textContent=modes[mode].heading;
    $('aiRun').innerHTML=esc(modes[mode].action)+' <span>✦</span>';$('aiEvidenceOptions').hidden=mode==='plan';$('aiBatchLabel').hidden=mode!=='refine';$('aiPresets').hidden=mode!=='plan';
    setError('');updateScope();renderReport();persist();
  }
  async function handshake(){
    if(location.protocol==='file:'){
      $('aiConnectionText').textContent='离线基础版';$('aiLocalNotice').hidden=false;$('aiCredentialState').textContent='请打开本地 AI 服务版，基础计量功能仍可离线使用。';$('aiSaveKey').disabled=true;$('aiTestConnection').disabled=true;return;
    }
    try{
      const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),5000);
      let response;try{response=await fetch('/api/status',{cache:'no-store',signal:controller.signal});}finally{clearTimeout(deadline);}
      if(!response.ok)throw new Error('status');const value=await response.json();if(value.version!=='2.0')throw new Error('version');connection=value;
      $('aiConnectionText').textContent=value.configured?'模型已配置 · 按需调用':'模型待配置';$('aiSettings').classList.toggle('ready',value.configured);
      $('aiEndpoint').value=value.endpoint;$('aiModel').value=value.model;$('aiCredentialState').textContent=value.configured?`密钥已配置 · 保存位置：${value.storage}。页面不读取或显示密钥。`:'尚未配置密钥。';
      $('aiLocalNotice').hidden=true;updateScope();window.dispatchEvent(new Event('atlas:connection'));
    }catch(error){connection=null;$('aiConnectionText').textContent='本地 AI 服务未连接';$('aiLocalNotice').hidden=false;$('aiRun').disabled=true;$('aiCredentialState').textContent='请启动交付包中的“启动AI工作台.command”，再刷新服务版页面。';}
  }
  async function post(path,data,signal,retry=true){
    if(!connection)throw new Error('请先启动本地 AI 服务。');
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Atlas-Session':connection.session_token},body:JSON.stringify(data),signal});
    let value;try{value=await response.json();}catch(e){throw new Error('本地服务返回格式异常，请刷新页面。');}
    if(response.status===403&&retry&&value.error?.includes('会话已过期')){await handshake();return post(path,data,signal,false);}
    if(!response.ok)throw new Error(value.error||'请求未完成，请重试。');return value;
  }
  function coverage(report){
    const c=report.coverage;if(report.mode==='plan')return `<div class="ai-coverage">本轮：仅发送研究问题、当前检索式和候选词表。下方命中数由本地实测。</div>`;
    return `<div class="ai-coverage"><strong>本轮 ${c.sent_papers} / ${c.matched_total.toLocaleString('zh-CN')} 篇</strong> · ${esc(c.selection)}<br>${c.with_abstract} 篇有摘要${c.truncated_abstracts?'，其中 '+c.truncated_abstracts+' 篇摘要截取前 '+c.abstract_character_limit+' 字符':''}。${c.all_papers_included?'本轮包含全部命中记录。':'文献内容解读限本轮样本；全量频次由本地统计。'}</div>`;
  }
  function refs(items){return (items||[]).map(ref=>`<button class="ai-ref" data-ai-ref="${esc(ref)}" aria-label="查看文献依据 ${esc(ref)}">${esc(ref)}</button>`).join('');}
  function cautions(items,title='阅读边界'){return items?.length?`<div class="ai-cautions"><b>${esc(title)}</b><ul>${items.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></div>`:'';}
  function welcome(){const m=modes[mode];return `<div class="ai-welcome"><span>✦</span><h3>${esc(m.welcome)}</h3><p>${esc(m.description)}</p><div><b>提出问题</b><i>→</i><b>核对检索</b><i>→</i><b>回查论文</b></div></div>`;}
  function renderReport(){
    const report=records[mode];$('aiExportMd').disabled=!report;$('aiExportJson').disabled=!report;$('aiStale').hidden=!stale(report);
    if(!report){$('aiOutput').innerHTML=welcome();return;}
    const r=report.result;let html=coverage(report);
    if(mode==='plan'){
      html+=`<p class="ai-intent">${esc(r.intent)}</p><div class="ai-concepts">${r.concepts.map(c=>`<span class="ai-concept"><b>${esc(c.concept)}</b>${esc(c.terms.join(' / '))}</span>`).join('')}</div>`;
      r.strategies.forEach((s,i)=>{html+=`<div class="ai-strategy"><div class="ai-strategyhead"><b>${esc(s.name)}</b><span class="ai-hitcount">${s.error?'语法待修正':s.hits===null?'待核对':s.hits.toLocaleString('zh-CN')+' 条命中'}</span></div><code class="ai-query">${esc(s.query)}</code><p>${esc(s.rationale)}</p>${s.error?`<p>${esc(s.error)}</p>`:''}<button data-ai-apply="${i}" ${s.error?'disabled':''}>应用并检索 ↗</button></div>`;});
      html+=cautions(r.cautions,'检索取舍与歧义');
    }else if(mode==='analyze'){
      html+=`<p class="ai-summary">${esc(r.summary)}</p>`;
      r.findings.forEach(f=>{html+=`<div class="ai-finding"><h3>${esc(f.title)}<span class="ai-basis">${({statistics:'本地统计',papers:'本轮文献',hypothesis:'待验证假设'})[f.basis]}</span></h3><p>${esc(f.detail)}</p>${refs(f.refs)}${f.basis==='papers'&&!f.refs.length?'<span class="ai-basis">未附本轮文献引用，需核查</span>':''}</div>`;});
      if(r.directions.length)html+='<h3 class="ai-sectiontitle">继续探索的方向</h3>';
      r.directions.forEach((d,i)=>{html+=`<div class="ai-direction"><h3>${esc(d.title)} <span class="ai-basis">待验证方向</span></h3><p>${esc(d.rationale)}</p>${refs(d.refs)}${d.query?`<code class="ai-query">${esc(d.query)}</code><button data-ai-direction="${i}">核对并检索这个方向 ↗</button>`:''}<p>核验：${esc(d.verification)}</p></div>`;});
      html+=cautions(r.limitations);if(r.followups.length)html+='<div class="ai-followups">'+r.followups.map((s,i)=>`<button data-ai-follow="${i}">追问：${esc(s)}</button>`).join('')+'</div>';
    }else{
      const counts=Object.fromEntries(Object.keys(labels).map(k=>[k,r.papers.filter(p=>p.label===k).length]));
      html+=`<p class="ai-summary">${esc(r.summary)}</p><div class="ai-refinecounts">${Object.entries(labels).map(([k,v])=>`<span>${v} ${counts[k]}</span>`).join('')}</div><div class="ai-refine-actions"><button data-ai-subset="direct" ${!counts.direct||stale(report)?'disabled':''}>仅查看直接相关论文</button><button data-ai-subset="related" ${!counts.direct&&!counts.partial||stale(report)?'disabled':''}>查看直接 + 部分相关</button><button id="aiExportRefine">精筛 CSV ↓</button>${report.coverage.next_offset!==null?'<button id="aiNextBatch" '+(stale(report)?'disabled':'')+'>精筛下一批 →</button>':''}</div>`;
      const order={direct:0,partial:1,uncertain:2,exclude:3};
      [...r.papers].sort((a,b)=>order[a.label]-order[b.label]).forEach(p=>{const e=report.evidence.find(x=>x.ref===p.ref);html+=`<article class="ai-paper"><span class="ai-label ${p.label}">${labels[p.label]}</span> ${refs([p.ref])}<h4>${esc(e?.title||p.id)}</h4><p>${esc(p.reason)}</p>${p.quote?`<blockquote>${esc(p.quote)} <span class="ai-basis">已核对原文片段</span></blockquote>`:'<p>没有可核对的原文片段，保留人工判断。</p>'}</article>`;});
      html+=cautions(r.limitations,['摘要相关性初筛，不等于研究质量评价。'].join(''));
    }
    html+=cautions(report.warnings,'自动核验提醒');html+=`<p class="ai-runmeta">${esc(report.model)} · ${esc(report.created_at.replace('T',' ').slice(0,19))} UTC · 用时 ${report.seconds}s${report.usage.total_tokens?' · '+report.usage.total_tokens.toLocaleString('zh-CN')+' tokens':''} · ${esc(report.prompt_version)}</p>`;
    $('aiOutput').innerHTML=html;
  }
  async function run(){
    if(busy)return;setError('');const local=app.getResult();if(!local){setError('请等待本地语料载入。');return;}
    const question=$('aiQuestion').value.trim()||(mode==='plan'?local.config.query:'');if(!question){setError('请先输入研究问题。');$('aiQuestion').focus();return;}
    if(mode!=='plan'&&!local.stats.hits){setError('当前没有命中文献，请先调整检索。');return;}
    if(mode==='refine'&&!local.config.query){setError('请先检索一个具体话题，再分批精筛文献。');return;}
    const requestMode=mode,sig=signature(local),context={parameters:{...local.config},matched_ids:local.indices.map(i=>app.getCorpus().docs[i].id)};
    const data={mode:requestMode,question,context,limit:Number($('aiLimit').value),offset:Number($('aiBatch').value)||0};
    if(records.plan&&!stale(records.plan))data.feedback=records.plan.result.strategies.map(s=>({query:s.query,field:s.field,hits:s.hits,error:s.error}));
    if(mode==='analyze'&&records.analyze&&!stale(records.analyze))data.previous={summary:records.analyze.result.summary,findings:records.analyze.result.findings};
    setBusy(true);abort=new AbortController();started=Date.now();
    const progress=()=>{$('aiProgressText').textContent=`${requestMode==='plan'?'正在设计检索方案':requestMode==='analyze'?'正在结合统计与摘要分析':'正在逐篇核对相关性'} · ${Math.floor((Date.now()-started)/1000)} 秒`;};progress();timer=setInterval(progress,1000);
    const deadline=setTimeout(()=>abort?.abort('timeout'),175000);
    try{
      const report=await post('/api/ai',data,abort.signal);report.local_signature=sig;report.matched_document_ids=context.matched_ids;report.local_checked_at=new Date().toISOString();
      if(requestMode==='plan'){
        report.result.strategies.forEach(s=>{s.hits=null;s.error=null;try{s.hits=app.preview(s.query,s.field,context.parameters);}catch(e){s.error=e.message;}});
      }
      records[requestMode]=report;renderReport();persist();$('live').textContent='AI '+modes[requestMode].heading+'已完成。';
    }catch(error){setError(error.name==='AbortError'?'已停止等待。服务端模型调用可能仍在结束，稍后可重新分析。':error.message);}
    finally{clearTimeout(deadline);abort=null;setBusy(false);updateScope();}
  }
  function openCitation(ref){
    const report=records[mode],e=report?.evidence.find(p=>p.ref===ref);if(!e)return;
    const corpus=app.getCorpus(),d=corpus.docs.find(p=>p.id===e.id);
    $('aiCitationBody').innerHTML=`<div class="ai-citationmeta">${esc(e.ref)} · ${esc(e.journal)} · ${esc(e.year)} 年 ${esc(e.issue)} 期 · ${esc(e.id)}</div><h3>${esc(e.title)}</h3><p>关键词：${esc(e.keywords||'未提供')}</p><p>${esc(d?.abstract||'源数据未提供可用摘要。')}</p>${e.abstract_truncated?'<p class="ai-coverage">上方显示本地完整可用摘要；本轮发送给 AI 的部分为前 '+report.coverage.abstract_character_limit+' 字符。</p>':''}<p class="ai-citationmeta">DOI：${esc(e.doi||'未提供')}</p>${/^https?:\/\//.test(e.url)?`<a class="ai-citationlink" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">打开 DOI / 原始来源 ↗</a>`:''}`;
    $('aiCitationDialog').showModal();
  }
  function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  function reportName(ext){return '岐研_AI_'+mode+'_'+new Date().toISOString().slice(0,10)+'.'+ext;}
  function markdown(report){
    const r=report.result,c=report.coverage,lines=['# 岐研 AI 研究记录','',`- 模型：${report.model}`,`- 时间：${report.created_at}`,`- 检索式：${report.query||'全库'}`,`- 问题：${report.question}`,`- 本轮文献：${c.sent_papers} / ${c.matched_total}；${c.selection}`,`- 语料 SHA-256：${report.corpus_sha256}`,`- 提示词版本：${report.prompt_version}`,''];
    if(report.mode==='plan'){lines.push(r.intent,'');r.strategies.forEach(s=>lines.push('## '+s.name,'','```text',s.query,'```',`本地命中：${s.hits??'无效'}；字段：${s.field}`,s.rationale,''));lines.push(...r.cautions.map(x=>'- '+x));}
    if(report.mode==='analyze'){lines.push(r.summary,'');r.findings.forEach(f=>lines.push('## '+f.title,'',f.detail+' '+f.refs.map(x=>'['+x+']').join(' '),''));r.directions.forEach(d=>lines.push('## 待验证：'+d.title,'',d.rationale+' '+d.refs.map(x=>'['+x+']').join(' '),'```text',d.query,'```','核验：'+d.verification,''));lines.push('## 局限','',...r.limitations.map(x=>'- '+x));}
    if(report.mode==='refine'){lines.push(r.summary,'');r.papers.forEach(p=>{const e=report.evidence.find(x=>x.ref===p.ref);lines.push('## ['+p.ref+'] '+e.title,'',labels[p.label]+'：'+p.reason,p.quote?'> '+p.quote:'没有可核对的原文片段。','');});lines.push(...r.limitations.map(x=>'- '+x));}
    if(report.evidence.length){lines.push('','## 本轮文献','');report.evidence.forEach(e=>lines.push(`[${e.ref}] ${e.title}．${e.journal}，${e.year}(${e.issue})．ID: ${e.id}．${e.url}`));}
    lines.push('','AI 辅助探索结果；计量数字按本地算法，摘要判断需人工回查。',...report.warnings.map(x=>'- '+x));return lines.join('\n');
  }
  function refineCsv(){const r=records.refine;const columns=['id','reference','label','reason','verified_quote','quote_verified','title','journal','doi'];const rows=r.result.papers.map(p=>{const e=r.evidence.find(x=>x.ref===p.ref);return [p.id,p.ref,labels[p.label],p.reason,p.quote,p.quote_verified,e.title,e.journal,e.doi];});return '\ufeff'+[columns,...rows].map(row=>row.map(x=>'"'+String(x??'').replace(/"/g,'""')+'"').join(',')).join('\r\n');}
  document.querySelectorAll('[data-ai-mode]').forEach(b=>b.onclick=()=>switchMode(b.dataset.aiMode));
  document.querySelectorAll('[data-ai-preset]').forEach(b=>b.onclick=()=>{$('aiQuestion').value=b.dataset.aiPreset;$('aiQuestion').focus();});
  $('aiRun').onclick=run;$('aiStop').onclick=()=>abort?.abort();$('aiLimit').onchange=()=>{$('aiBatch').value=0;updateScope();};
  $('aiSettings').onclick=()=>{$('aiSettingsDialog').showModal();};$('aiSettingsClose').onclick=()=>$('aiSettingsDialog').close();$('aiCitationClose').onclick=()=>$('aiCitationDialog').close();
  $('aiSaveKey').onclick=async()=>{const key=$('aiKey').value;const button=$('aiSaveKey');button.disabled=true;$('aiSettingsStatus').textContent='正在保存本机配置…';try{const r=await post('/api/configure',{key,persist:$('aiPersist').checked});$('aiKey').value='';$('aiSettingsStatus').textContent=r.warning||('密钥已保存至'+r.storage+'。');await handshake();}catch(e){$('aiSettingsStatus').textContent=e.message;}finally{button.disabled=false;}};
  $('aiTestConnection').onclick=async()=>{const b=$('aiTestConnection');b.disabled=true;$('aiSettingsStatus').textContent='正在发送最小连接测试请求…';try{const r=await post('/api/test',{});$('aiSettingsStatus').textContent=`连接成功 · ${r.model} · ${r.seconds} 秒。`;$('aiConnectionText').textContent='模型连接已验证';}catch(e){$('aiSettingsStatus').textContent=e.message;}finally{b.disabled=false;}};
  $('aiExportJson').onclick=()=>{if(records[mode]){const copy={...records[mode]};delete copy.local_signature;download(reportName('json'),JSON.stringify(copy,null,2),'application/json');}};
  $('aiExportMd').onclick=()=>{if(records[mode])download(reportName('md'),markdown(records[mode]),'text/markdown;charset=utf-8');};
  $('aiOutput').addEventListener('click',event=>{
    const t=event.target.closest('[data-ai-ref],[data-ai-apply],[data-ai-direction],[data-ai-follow],[data-ai-subset],#aiNextBatch,#aiExportRefine');if(!t)return;
    if(t.dataset.aiRef)return openCitation(t.dataset.aiRef);
    if(t.dataset.aiApply!==undefined){const s=records.plan.result.strategies[Number(t.dataset.aiApply)];app.search(s.query,s.field);return;}
    if(t.dataset.aiDirection!==undefined){const d=records.analyze.result.directions[Number(t.dataset.aiDirection)];try{app.preview(d.query,'all');app.search(d.query,'all');}catch(e){setError('该方向检索式需要修正：'+e.message);}return;}
    if(t.dataset.aiFollow!==undefined){$('aiQuestion').value=records.analyze.result.followups[Number(t.dataset.aiFollow)];$('aiQuestion').focus();return;}
    if(t.dataset.aiSubset){const report=records.refine;if(stale(report)){setError('检索范围已改变，请先重新精筛。');return;}const rows=report.result.papers.filter(p=>p.label==='direct'||t.dataset.aiSubset==='related'&&p.label==='partial');app.showPaperSubset(rows.map(p=>p.id),'AI 相关性子集 · '+(t.dataset.aiSubset==='direct'?'直接相关':'直接 + 部分相关')+' · 本轮 '+report.coverage.sent_papers+' 篇候选');return;}
    if(t.id==='aiExportRefine')return download(reportName('csv'),refineCsv(),'text/csv;charset=utf-8');
    if(t.id==='aiNextBatch'){if(stale(records.refine)){setError('检索范围已改变，请重新选择批次。');return;}$('aiBatch').value=records.refine.coverage.next_offset;run();}
  });
  window.addEventListener('atlas:results',()=>{updateScope();if(records[mode])renderReport();});
  window.atlasAiDebug={mode:()=>mode,report:()=>records[mode]||null,configured:()=>!!connection?.configured,isBusy:()=>busy};
  window.atlasAIClient={post,status:()=>({configured:!!connection?.configured,offline:location.protocol==='file:',model:connection?.model}),settings:()=>$('aiSettingsDialog').showModal()};
  $('aiQuestion').value=questions.plan;switchMode(initialMode);updateScope();handshake();
})();
