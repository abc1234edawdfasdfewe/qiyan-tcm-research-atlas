/* Evidence/ranking regression checks, no model calls and no unpublished manuscript. */
const assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const {createJournalMatcher,detect}=require('./journal-engine');
const checks=[];function check(name,fn){fn();checks.push({name,passed:true});}
const corpus=JSON.parse(zlib.gunzipSync(fs.readFileSync(__dirname+'/data/corpus.json.gz'))),matcher=createJournalMatcher(corpus);
const input={title:'面向中医古籍医案的实体关系抽取方法研究',abstract:'采用大语言模型和检索增强，通过多智能体审核古籍医案中的实体与关系，并与单轮方法进行对照和消融实验。',keywords:'中医古籍；实体识别；关系抽取',priority:'method',article_type:'original'};
let result;
check('rejects empty manuscript',()=>assert.throws(()=>matcher.match({}),/输入/));
check('separates bibliometric maps from semantic knowledge graphs',()=>{assert(!detect('基于citespace的知识图谱文献计量分析').includes('semantic'));assert(detect('基于实体关系抽取的知识图谱').includes('semantic'));});
check('returns all 67 candidate journals with real evidence',()=>{result=matcher.match(input);assert.equal(result.journals.length,67);assert.equal(new Set(result.journals.map(j=>j.code)).size,67);for(const j of result.journals)for(const e of j.evidence){const d=corpus.docs.find(d=>d.id===e.id);assert(d);assert.equal(corpus.journals[d.j].code,j.code);assert(d.dup<0&&!d.suspect);}});
check('method query retrieves published extraction studies rather than acupuncture name alone',()=>{const first=result.journals[0];assert.equal(first.code,'SJKX');const top=result.journals.slice(0,6).flatMap(j=>j.evidence.map(p=>p.id));assert(top.includes('ZYHS202602036'));assert(top.includes('ZSFX202602023'));assert(!['ZGZJ','ZCYJ','ZJLC'].includes(first.code));});
check('ranking deterministic across runs',()=>{const second=matcher.match(input);assert.deepEqual(result.journals,second.journals);});
check('clinical subject search changes the near-neighbor evidence',()=>{const clinical=matcher.match({title:'针刺治疗膝骨关节炎的随机对照试验',keywords:'针刺；膝骨关节炎；随机对照试验',priority:'subject'});assert.notDeepEqual(clinical.journals.slice(0,3).map(j=>j.code),result.journals.slice(0,3).map(j=>j.code));assert(clinical.journals[0].evidence.some(e=>corpus.docs.find(d=>d.id===e.id).title.includes('膝骨关节炎')));});
check('unseen subject does not produce fabricated articles',()=>{const r=matcher.match({title:'ZXQUNSEEN12345ZXQ'});assert(r.journals.every(j=>j.nearby===0&&j.score===0&&j.evidence.length===0));});
const report={passed:true,provider_calls:0,checks};fs.writeFileSync(__dirname+'/选刊引擎核验.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
