(function (root) {
  'use strict';
  const normalize = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  function parseQuery(input) {
    const tokens = []; let at = 0;
    const text = String(input || '').trim();
    while (at < text.length) {
      if (/\s/.test(text[at])) { at++; continue; }
      const c = text[at];
      if ('()&|!'.includes(c)) { tokens.push({type: c === '&' ? 'AND' : c === '|' ? 'OR' : c === '!' ? 'NOT' : c}); at++; if (text[at] === c && '&|'.includes(c)) at++; continue; }
      if (c === '"') {
        at++; let value = '', closed = false;
        while (at < text.length) { if (text[at] === '"') { at++; closed = true; break; } if (text[at] === '\\' && at + 1 < text.length) at++; value += text[at++]; }
        if (!closed || !value.trim()) throw new Error('引号没有闭合，或短语为空。');
        tokens.push({type:'TERM', value}); continue;
      }
      let end = at; while (end < text.length && !/[\s()&|!"]/.test(text[end])) end++;
      const word = text.slice(at,end); if (!word) throw new Error('无法解析检索式。');
      tokens.push(['AND','OR','NOT'].includes(word.toUpperCase()) ? {type:word.toUpperCase()} : {type:'TERM',value:word}); at = end;
    }
    if (!tokens.length) return null;
    let position = 0;
    function unary() {
      const t = tokens[position++]; if (!t) throw new Error('运算符后缺少话题。');
      if (t.type === 'NOT') return {op:'not',child:unary()};
      if (t.type === '(') { const node = or(); if (tokens[position++]?.type !== ')') throw new Error('括号没有闭合。'); return node; }
      if (t.type !== 'TERM') throw new Error('检索式位置不正确。'); return {op:'term',value:t.value};
    }
    function and() {
      let node = unary();
      while (position < tokens.length && !['OR',')'].includes(tokens[position].type)) {
        if (tokens[position].type === 'AND') position++;
        node = {op:'and',left:node,right:unary()};
      } return node;
    }
    function or() { let node = and(); while (tokens[position]?.type === 'OR') { position++; node = {op:'or',left:node,right:and()}; } return node; }
    const ast = or(); if (position !== tokens.length) throw new Error('存在多余括号或运算符。'); return ast;
  }
  function createAtlasEngine(data) {
    const docs = data.docs, terms = data.terms, journals = data.journals;
    const text = docs.map(d=>normalize(d.title+' '+d.keywords+' '+d.abstract));
    const titles = docs.map(d=>normalize(d.title)), abstracts = docs.map(d=>normalize(d.abstract));
    const rawKeywords = docs.map(d=>new Set(d.keywords.split(';').map(normalize).filter(Boolean)));
    const aliasMap = new Map(), formsMap = new Map();
    Object.entries(data.lexicon.aliases).forEach(([canonical,variants])=>{
      const forms = [...new Set([canonical,...variants].map(normalize))]; formsMap.set(normalize(canonical),forms);
      forms.forEach(f=>aliasMap.set(f,normalize(canonical)));
    });
    let lastIndices = [], lastConfig = null;
    function compile(ast, config) {
      if (!ast) return ()=>true;
      if (ast.op === 'and' || ast.op === 'or') { const a=compile(ast.left,config),b=compile(ast.right,config);return ast.op==='and'?i=>a(i)&&b(i):i=>a(i)||b(i); }
      if (ast.op === 'not') { const a=compile(ast.child,config);return i=>!a(i); }
      const key = normalize(ast.value), canonical = aliasMap.get(key)||key;
      const forms = config.expand ? formsMap.get(canonical)||[key] : [key];
      if (config.field==='keyword') {
        if (!config.expand) return i=>rawKeywords[i].has(key);
        return i=>docs[i].k.some(k=>terms[k].key===canonical)||forms.some(f=>rawKeywords[i].has(f));
      }
      const collection = config.field==='title'?titles:config.field==='abstract'?abstracts:text;
      return i=>forms.some(f=>collection[i].includes(f));
    }
    function keywordSummary(indices, generic) {
      const count = new Map(); let denominator=0;
      indices.forEach(i=>{ const keys=docs[i].k; if(keys.length)denominator++; keys.forEach(k=>{if(!generic||!terms[k].generic)count.set(k,(count.get(k)||0)+1);}); });
      const sorted=[...count].sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
      const tops = sorted.slice(0,30), topSet=new Set(tops.map(x=>x[0])), spreads=new Map(tops.map(x=>[x[0],new Set()]));
      indices.forEach(i=>docs[i].k.forEach(k=>{if(topSet.has(k))spreads.get(k).add(docs[i].j);}));
      return {count,denominator,sorted,top:tops.map(([id,df])=>({id,label:terms[id].label,count:df,pct:denominator?df/denominator*100:0,journals:spreads.get(id).size}))};
    }
    function network(indices, summary, config) {
      const selected=summary.sorted.filter(x=>x[1]>=2).slice(0,config.nodes||32), keys=new Set(selected.map(x=>x[0])), pairs=new Map();
      indices.forEach(i=>{const ks=docs[i].k.filter(k=>keys.has(k));for(let a=0;a<ks.length;a++)for(let b=a+1;b<ks.length;b++){
        const x=Math.min(ks[a],ks[b]),y=Math.max(ks[a],ks[b]),key=x+':'+y;pairs.set(key,(pairs.get(key)||0)+1);
      }});
      let edges=[...pairs].filter(x=>x[1]>=config.minCo).map(([key,count])=>{const [source,target]=key.split(':').map(Number);return {source,target,count,cosine:count/Math.sqrt(summary.count.get(source)*summary.count.get(target))};});
      edges.sort((a,b)=>config.edgeWeight==='count'?b.count-a.count||b.cosine-a.cosine:b.cosine-a.cosine||b.count-a.count);
      const totalEdges=edges.length;edges=edges.slice(0,100);
      return {nodes:selected.map(([id,count])=>({id,label:terms[id].label,count})),edges,totalEdges,displayLimit:100};
    }
    function matrix(indices, config) {
      const [left,right]=String(config.matrix||'疾病|方法').split('|');
      const df=new Map(),pairs=new Map();
      indices.forEach(i=>{
        const a=docs[i].e.filter(e=>data.entities[e].category===left), b=docs[i].e.filter(e=>data.entities[e].category===right);
        [...a,...b].forEach(e=>df.set(e,(df.get(e)||0)+1));
        a.forEach(x=>b.forEach(y=>{const key=x+':'+y;pairs.set(key,(pairs.get(key)||0)+1);}));
      });
      const ranked=category=>[...df].filter(([id])=>data.entities[id].category===category).sort((a,b)=>b[1]-a[1]||a[0]-b[0]).slice(0,8).map(([id,count])=>({id,label:data.entities[id].label,count}));
      const x=ranked(right),y=ranked(left),cells=[];
      y.forEach((a,yi)=>x.forEach((b,xi)=>cells.push({x:xi,y:yi,a:a.id,b:b.id,count:pairs.get(a.id+':'+b.id)||0})));
      const directions=[...pairs].filter(x=>x[1]>=3).map(([key,count])=>{const [a,b]=key.split(':').map(Number);return {a:data.entities[a].label,b:data.entities[b].label,count,cosine:count/Math.sqrt(df.get(a)*df.get(b))};}).sort((a,b)=>b.count-a.count||b.cosine-a.cosine).slice(0,6);
      return {left,right,x,y,cells,directions};
    }
    function analyze(config) {
      if(config.from>config.to)throw new Error('起始刊期月份不能晚于结束月份。');
      const ast=parseQuery(config.query),match=compile(ast,config);let removed=0;
      const base=[];
      docs.forEach((doc,i)=>{
        if(doc.p<config.from||doc.p>config.to||(config.journal>=0&&doc.j!==config.journal)||(config.abstractOnly&&!doc.abstract)||(config.excludeSuspect&&doc.suspect))return;
        if(config.dedup&&doc.dup>=0){removed++;return;}base.push(i);
      });
      const indices=base.filter(match),summary=keywordSummary(indices,config.hideGeneric);
      const cohort=base.filter(i=>!config.completeTrend||journals[docs[i].j].complete),cohortJournals=new Set(cohort.map(i=>docs[i].j));
      const monthly=Array.from({length:config.to-config.from+1},(_,k)=>({period:data.meta.periods[config.from+k],p:config.from+k,base:0,hits:0,share:null}));
      cohort.forEach(i=>{const row=monthly[docs[i].p-config.from];row.base++;if(match(i))row.hits++;});monthly.forEach(row=>row.share=row.base?row.hits/row.base*100:null);
      const jBase=new Map(),jHits=new Map();base.forEach(i=>jBase.set(docs[i].j,(jBase.get(docs[i].j)||0)+1));indices.forEach(i=>jHits.set(docs[i].j,(jHits.get(docs[i].j)||0)+1));
      const jRows=[...jHits].sort((a,b)=>b[1]-a[1]).map(([id,count])=>({id,label:journals[id].name,count,base:jBase.get(id),share:count/jBase.get(id)*100,complete:journals[id].complete}));
      indices.sort((a,b)=>docs[b].p-docs[a].p||docs[a].id.localeCompare(docs[b].id));
      lastIndices=indices;lastConfig=config;
      return {config,ast,stats:{base:base.length,hits:indices.length,withAbstract:indices.filter(i=>docs[i].abstract).length,withKeywords:summary.denominator,
              journals:jHits.size,removedDuplicates:removed,suspects:indices.filter(i=>docs[i].suspect).length},
              keywords:summary.top,network:network(indices,summary,config),matrix:matrix(indices,config),monthly,
              trendCohortJournals:cohortJournals.size,journals:jRows,indices,
              provenance:{lexiconVersion:data.lexicon.version,corpusSha256:data.meta.corpus_sha256,queryAst:ast,
                termCounting:'document frequency; one term once per record',entityCounting:'literal mentions in title + keywords + usable abstract',
                edgeNormalization:'cooccurrence / sqrt(document_frequency_a * document_frequency_b)',
                monthBasis:'inferred from issue number and publication frequency',parameters:config}};
    }
    return {analyze,parseQuery,normalize,getLast:()=>({indices:lastIndices,config:lastConfig})};
  }
  root.createAtlasEngine=createAtlasEngine;root.parseAtlasQuery=parseQuery;
  if(typeof module!=='undefined')module.exports={createAtlasEngine,parseQuery,normalize};
})(typeof self!=='undefined'?self:globalThis);
