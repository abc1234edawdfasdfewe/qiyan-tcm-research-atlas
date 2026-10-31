/* Local, deterministic journal fit. No network and no manuscript persistence. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.createJournalMatcher=factory().createJournalMatcher;})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  const VERSION='journal-fit-1.0';
  const norm=v=>String(v||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
  const groups=[
    {id:'extract',name:'实体与关系抽取',kind:'method',forms:['命名实体识别','实体识别','关系抽取','实体抽取','知识抽取','信息抽取','结构化提取','联合抽取','联合关系抽取','casrel','ner']},
    {id:'llm',name:'大语言模型',kind:'method',forms:['大语言模型','大模型','llm','chatgpt','chatglm','生成式人工智能']},
    {id:'rag',name:'检索增强',kind:'method',forms:['检索增强','rag','知识增强']},
    {id:'agent',name:'智能体协作',kind:'method',forms:['智能体','多智能体','agent']},
    {id:'semantic',name:'实体知识图谱',kind:'method',forms:['知识图谱','知识表示','知识融合','知识推理','neo4j']},
    {id:'bibliometric',name:'文献计量',kind:'method',forms:['文献计量','citespace','vosviewer','共词分析','计量可视化']},
    {id:'network',name:'网络药理学',kind:'method',forms:['网络药理学','分子对接']},
    {id:'trial',name:'临床试验',kind:'method',forms:['随机对照','临床试验','随机双盲','rct']},
    {id:'meta',name:'系统综述与Meta分析',kind:'method',forms:['meta分析','meta-analysis','系统评价','系统综述','荟萃分析']},
    {id:'cohort',name:'观察性研究',kind:'method',forms:['队列研究','病例对照','横断面研究','真实世界研究']},
    {id:'mining',name:'医案数据挖掘',kind:'method',forms:['数据挖掘','关联规则','聚类分析','用药规律']},
    {id:'classics',name:'古籍与文言',kind:'subject',forms:['古籍','古代','典籍','文言','古医籍']},
    {id:'cases',name:'中医医案',kind:'subject',forms:['医案','病历']},
    {id:'acupuncture',name:'针灸',kind:'subject',forms:['针灸','针刺','电针','穴位','艾灸']}
  ];
  const review=/研究进展|研究综述|应用展望|应用框架与展望|述评|发展现状|机会与挑战|机遇与挑战|思考|探讨/;
  const nonresearch=/征稿|征订|稿约|投稿须知|书评|会议通知|目录索引|勘误|更正声明|编委会名单/;
  function contains(text,form){return /^[a-z0-9-]+$/.test(form)?new RegExp('(^|[^a-z0-9])'+form+'([^a-z0-9]|$)').test(text):text.includes(form);}
  function detect(text){const found=groups.filter(g=>g.forms.some(f=>contains(text,f))).map(g=>g.id);if(found.includes('bibliometric')&&!/实体|关系抽取|知识推理|neo4j/.test(text))return found.filter(x=>x!=='semantic');return found;}
  function grams(text){const out=new Set();for(const span of text.match(/[\u3400-\u9fff]+|[a-z][a-z0-9-]{1,30}/g)||[]){if(/^[a-z]/.test(span)){out.add(span);continue;}for(let i=0;i<span.length-1;i++)out.add(span.slice(i,i+2));}return [...out];}
  function inputValue(value){return {title:String(value.title||'').trim().slice(0,300),abstract:String(value.abstract||'').trim().slice(0,12000),keywords:String(value.keywords||'').trim().slice(0,1200),focus:String(value.focus||'').trim().slice(0,1000),priority:['balanced','method','subject'].includes(value.priority)?value.priority:'balanced',article_type:['original','review','any'].includes(value.article_type)?value.article_type:'original'};}
  function createJournalMatcher(corpus){
    const docs=corpus.docs.filter(d=>d.dup<0&&!d.suspect&&!nonresearch.test(d.title));
    const rows=docs.map(d=>{const tk=norm(d.title+' '+d.keywords),ab=norm(d.abstract);return {d,tk,ab,title:norm(d.title),features:detect(tk),allFeatures:detect(tk+' '+ab),review:review.test(d.title)};});
    const base=corpus.journals.map((j,index)=>({...j,index,total:rows.filter(r=>r.d.j===index).length}));
    function match(raw){
      const input=inputValue(raw),full=norm(input.title+' '+input.abstract+' '+input.keywords+' '+input.focus);
      if(!input.title&&!input.abstract)throw new Error('请至少输入稿件题目或摘要。');
      if(full.length<6)throw new Error('稿件信息过少，请补充题目、摘要或关键词。');
      const qFeatures=detect(full),titleTokens=new Set(grams(norm(input.title))),keyTokens=new Set(grams(norm(input.keywords+' '+input.focus)));
      const allTokens=grams(full),N=rows.length,df=new Map(allTokens.map(t=>[t,0]));
      for(const row of rows)for(const t of allTokens)if(row.tk.includes(t)||row.ab.includes(t))df.set(t,df.get(t)+1);
      let tokens=allTokens.filter(t=>df.get(t)>0&&df.get(t)<N*.32).map(t=>({text:t,idf:Math.log(1+(N-df.get(t)+.5)/(df.get(t)+.5)),weight:keyTokens.has(t)?3:titleTokens.has(t)?2:0.55,df:df.get(t)}));
      tokens.sort((a,b)=>(b.idf*b.weight)-(a.idf*a.weight)||a.text.localeCompare(b.text));tokens=tokens.slice(0,64);
      const phrases=[...new Set((input.keywords+';'+input.focus).split(/[;；,，、\n]+/).map(norm).filter(t=>t.length>=2&&t.length<=50))];
      const weights={balanced:[.5,.5],method:[.75,.25],subject:[.25,.75]}[input.priority];
      const method=qFeatures.filter(id=>groups.find(g=>g.id===id).kind==='method'),subject=qFeatures.filter(id=>groups.find(g=>g.id===id).kind==='subject');
      const mainFeatures=detect(norm(input.title+' '+input.focus)),keywordFeatures=detect(norm(input.keywords));
      const importance=id=>mainFeatures.includes(id)?3:keywordFeatures.includes(id)?2:1;
      const totalWeight=tokens.reduce((s,t)=>s+t.idf*t.weight,0)||1;
      const scored=rows.map(r=>{
        let sum=0;const matches=[];
        for(const t of tokens){const weight=r.tk.includes(t.text)?1:r.ab.includes(t.text)?.3:0;sum+=weight*t.idf*t.weight;}
        const lexical=sum/totalWeight;
        const shared=phrases.filter(t=>r.tk.includes(t)||r.ab.includes(t));
        matches.push(...shared.map(t=>({term:t,field:r.tk.includes(t)?'题名/关键词':'摘要'})));
        const fit=ids=>ids.length?ids.reduce((s,id)=>s+importance(id)*(r.features.includes(id)?1:r.allFeatures.includes(id)?.25:0),0)/ids.reduce((s,id)=>s+importance(id),0):null;
        const mf=fit(method),sf=fit(subject),feature=mf===null?(sf??0):sf===null?mf:mf*weights[0]+sf*weights[1];
        for(const id of qFeatures)if(r.allFeatures.includes(id)){const g=groups.find(g=>g.id===id);matches.push({term:g.name,field:r.features.includes(id)?'题名/关键词':'摘要'});}
        let score=.64*lexical+.28*feature+.08*(phrases.length?shared.length/phrases.length:0);
        // A domain word alone cannot outweigh an unrelated method when methods were specified.
        if(method.length&&mf===0)score*=input.priority==='subject'?.85:.52;
        if(input.article_type==='original'&&r.review)score*=.65;
        if(input.article_type==='review'&&!r.review)score*=.85;
        return {id:r.d.id,j:r.d.j,score,lexical,method_fit:mf,subject_fit:sf,matches,review:r.review,features:r.features};
      });
      const threshold=.16;
      const journals=base.map(j=>{
        const list=scored.filter(p=>p.j===j.index).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
        const relevant=list.filter(p=>p.score>=threshold),top=list.filter(p=>p.score>=.055).slice(0,5),head=top.slice(0,3);
        const mean=head.reduce((s,p)=>s+p.score,0)/3; // pad to three, so a single outlier cannot dominate
        const best=top[0]?.score||0,support=Math.min(1,Math.log1p(relevant.length)/Math.log(11));
        const score=100*(.6*mean+.25*best+.15*support*Math.min(1,best/.3));
        const signals=qFeatures.map(id=>({id,label:groups.find(g=>g.id===id).name,count:list.filter(p=>p.features.includes(id)).length}));
        return {...j,score:Number(score.toFixed(2)),nearby:relevant.length,share:j.total?relevant.length/j.total:0,evidence:top,signals};
      }).sort((a,b)=>b.score-a.score||a.code.localeCompare(b.code));
      return {version:VERSION,created_at:new Date().toISOString(),input,corpus_sha256:corpus.meta.corpus_sha256,scope:corpus.meta.scope,snapshot:corpus.meta.snapshot,total_records:docs.length,journal_count:base.length,threshold,features:qFeatures.map(id=>({id,label:groups.find(g=>g.id===id).name,kind:groups.find(g=>g.id===id).kind})),terms:tokens.map(t=>({term:t.text,document_frequency:t.df})),journals,method:'词项逆文档频率；题名/关键词权重1，摘要0.3；方法与对象概念匹配；原始研究匹配时对疑似综述降权。期刊得分=前三近邻均分×0.6+最佳近邻×0.25+近题数量饱和项×0.15（乘100）。每刊前三不足以零补齐；得分未作概率校准。',limits:['仅比较本批正式刊期数据；缺期可能影响排序。','近题数量为启发式阈值命中，不能解释为所有相关论文。','疑似综述按题名识别，研究类型需人工核对。','未核验最新稿约、栏目、核心目录、费用与审稿周期；不能据此预测录用。']};
    }
    return {match};
  }
  return {createJournalMatcher,detect,groups,inputValue,VERSION};
});
