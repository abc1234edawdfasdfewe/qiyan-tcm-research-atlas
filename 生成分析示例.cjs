/* Generate reproducible baseline tables and topic examples from the prepared corpus. */
const fs=require('node:fs'),zlib=require('node:zlib');
const {createAtlasEngine}=require('./engine.js');
const corpus=JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname+'/data/corpus.json.gz')));
const engine=createAtlasEngine(corpus);
const defaults={query:'',field:'all',journal:-1,from:0,to:11,dedup:true,expand:true,abstractOnly:false,excludeSuspect:false,hideGeneric:true,completeTrend:true,nodes:32,minCo:3,edgeWeight:'cosine',matrix:'疾病|方法',trendMetric:'count'};
const baseline=engine.analyze(defaults),counts=new Map(),journals=new Map();
for(const i of baseline.indices)for(const k of corpus.docs[i].k){
  if(corpus.terms[k].generic)continue;
  counts.set(k,(counts.get(k)||0)+1);if(!journals.has(k))journals.set(k,new Set());journals.get(k).add(corpus.docs[i].j);
}
const rows=[...counts].sort((a,b)=>b[1]-a[1]||a[0]-b[0]).map(([id,count])=>[corpus.terms[id].label,count,count/baseline.stats.withKeywords*100,journals.get(id).size]);
function csv(rows){return '\ufeff'+rows.map(row=>row.map(v=>'"'+String(v).replace(/"/g,'""')+'"').join(',')).join('\r\n');}
fs.writeFileSync(__dirname+'/全库热点基线.csv',csv([['keyword','document_count','percentage_of_keyword_records','journal_count'],...rows]));
const queries=['铁死亡','网络药理学','肠道菌群','铁死亡 AND 糖尿病肾病','肠道菌群 AND 溃疡性结肠炎','针刺 AND 膝骨关节炎'];
const examples=queries.map(query=>{
 const r=engine.analyze({...defaults,query,trendMetric:'share'});
 return {query,stats:r.stats,provenance:r.provenance,keywords:r.keywords,network:r.network,matrix:r.matrix,journals:r.journals,monthly:r.monthly,trend_cohort_journals:r.trendCohortJournals,document_ids:r.indices.map(i=>corpus.docs[i].id)};
});
const report={corpus:corpus.meta,defaults,baseline:{stats:baseline.stats,top_keywords:baseline.keywords,monthly:baseline.monthly},examples};
fs.writeFileSync(__dirname+'/分析示例.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({baseline:baseline.stats,top:rows.slice(0,12),examples:examples.map(x=>({query:x.query,hits:x.stats.hits}))},null,2));
