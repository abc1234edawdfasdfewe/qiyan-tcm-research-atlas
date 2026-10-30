/* Finite verification against independently counted source records. */
const fs=require('node:fs'),zlib=require('node:zlib'),assert=require('node:assert/strict');
const {createAtlasEngine,parseQuery}=require('./engine.js');
const data=JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname+'/data/corpus.json.gz')));
const E=createAtlasEngine(data),checks=[];
const base={query:'',field:'all',journal:-1,from:0,to:11,dedup:false,expand:false,abstractOnly:false,excludeSuspect:false,hideGeneric:false,completeTrend:true,nodes:32,minCo:3,edgeWeight:'cosine',matrix:'疾病|方法'};
function test(name,fn){fn();checks.push({name,passed:true});}
test('entire catalogue preserves 21709 record IDs',()=>assert.equal(E.analyze(base).stats.hits,21709));
test('iron-death literal topic matches independent Python count 430',()=>assert.equal(E.analyze({...base,query:'铁死亡'}).stats.hits,430));
test('exact keyword search matches 303 documents',()=>assert.equal(E.analyze({...base,query:'铁死亡',field:'keyword'}).stats.hits,303));
test('AND topic matches independent Python count 14',()=>assert.equal(E.analyze({...base,query:'铁死亡 AND 糖尿病肾病'}).stats.hits,14));
test('implicit AND equals explicit AND',()=>assert.deepEqual(E.analyze({...base,query:'铁死亡 糖尿病肾病'}).indices,E.analyze({...base,query:'铁死亡 AND 糖尿病肾病'}).indices));
test('boolean precedence, parentheses and NOT follow set operations',()=>{
 const r=E.analyze({...base,query:'(铁死亡 OR 肠道菌群) AND NOT 糖尿病肾病'});
 const expected=data.docs.map((d,i)=>[d,i]).filter(([d])=>{const t=(d.title+' '+d.keywords+' '+d.abstract).toLowerCase();return(t.includes('铁死亡')||t.includes('肠道菌群'))&&!t.includes('糖尿病肾病');}).map(x=>x[1]).sort((a,b)=>a-b);
 assert.deepEqual(r.indices.slice().sort((a,b)=>a-b),expected);
});
test('malformed queries fail without returning fake empty results',()=>{for(const q of ['铁死亡 AND','(铁死亡','铁死亡 OR OR 肠道菌群','"铁死亡'])assert.throws(()=>parseQuery(q));});
test('conservative duplicate toggle removes exactly 23 records',()=>assert.equal(E.analyze({...base,dedup:true}).stats.hits,21686));
test('trend complete cohort has 43 journals and counts sum correctly',()=>{
 const r=E.analyze({...base,query:'铁死亡',dedup:true});assert.equal(r.trendCohortJournals,43);
 const expected=r.indices.filter(i=>data.journals[data.docs[i].j].complete).length;
 assert.equal(r.monthly.reduce((n,m)=>n+m.hits,0),expected);
 r.monthly.forEach(m=>assert.equal(m.share,m.base?m.hits/m.base*100:null));
});
test('network edge counts and cosine match direct set counts',()=>{
 const r=E.analyze({...base,query:'铁死亡'});assert.ok(r.network.edges.length);
 for(const edge of r.network.edges.slice(0,15)){
  const a=r.indices.filter(i=>data.docs[i].k.includes(edge.source)).length,b=r.indices.filter(i=>data.docs[i].k.includes(edge.target)).length;
  const count=r.indices.filter(i=>data.docs[i].k.includes(edge.source)&&data.docs[i].k.includes(edge.target)).length;
  assert.equal(edge.count,count);assert.equal(edge.cosine,count/Math.sqrt(a*b));
 }
});
test('entity matrix cells reproduce direct document membership',()=>{
 const r=E.analyze({...base,query:'铁死亡',matrix:'疾病|机制'});
 for(const cell of r.matrix.cells)assert.equal(cell.count,r.indices.filter(i=>data.docs[i].e.includes(cell.a)&&data.docs[i].e.includes(cell.b)).length);
});
test('zero-match, one-record and incomplete-journal filters stay valid',()=>{
 const r=E.analyze({...base,query:'绝不可能存在的研究词abcdefghijklmnop'});assert.equal(r.stats.hits,0);assert.equal(r.network.nodes.length,0);
 const j=data.journals.findIndex(j=>!j.complete);const x=E.analyze({...base,journal:j});assert.equal(x.trendCohortJournals,0);assert.ok(x.monthly.every(m=>m.share===null));
 assert.throws(()=>E.analyze({...base,from:10,to:2}));
});
const report={passed:true,checks,defaults:E.analyze({...base,dedup:true,expand:true,hideGeneric:true}).stats};
fs.writeFileSync(__dirname+'/引擎核验.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
