#!/usr/bin/env python3
"""Finite, offline checks for evidence boundaries and model-output validation."""
import json
from pathlib import Path
import re
import unittest
from ai_server import Corpus, parse_model_json, validate_result

ROOT=Path(__file__).resolve().parent

class EvidenceChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.corpus=Corpus()
        cls.defaults={'query':'铁死亡 AND 糖尿病肾病','field':'all','journal':-1,'from':0,'to':11,'dedup':True,'expand':True,'abstractOnly':False,'excludeSuspect':False,'hideGeneric':True,'completeTrend':True}
        cls.ids=[d['id'] for d in cls.corpus.docs if d['dup']<0 and all(t in d['title']+' '+d['abstract']+' '+d['keywords'] for t in ('铁死亡','糖尿病肾病'))]
        cls.ids.sort(key=lambda id:(-cls.corpus.by_id[id]['p'],id))
    def payload(self,mode='analyze',**extra):
        return {'mode':mode,'question':'糖尿病肾病与铁死亡的研究方向','context':{'parameters':self.defaults,'matched_ids':self.ids},'limit':40,**extra}
    def test_exact_14_corpus_records(self):
        self.assertEqual(len(self.ids),14)
        ctx,e,c=self.corpus.context(self.payload())
        self.assertEqual(ctx['statistics']['matched_records'],14)
        self.assertEqual(ctx['statistics']['with_abstract'],14)
        self.assertTrue(c['all_papers_included'])
        self.assertEqual(len(e),14)
    def test_aggregate_matches_saved_engine_snapshot(self):
        ctx,_,_=self.corpus.context(self.payload())
        example=next(x for x in json.loads((ROOT/'分析示例.json').read_text())['examples'] if x['query']==self.defaults['query'])
        self.assertEqual(ctx['statistics']['trend_journals'],example['trend_cohort_journals'])
        self.assertEqual([x['base'] for x in ctx['statistics']['monthly']],[x['base'] for x in example['monthly']])
        self.assertEqual([x['hits'] for x in ctx['statistics']['monthly']],[x['hits'] for x in example['monthly']])
        frequencies={x['term']:x['records'] for x in ctx['statistics']['keywords']}
        for x in example['keywords']:
            self.assertEqual(frequencies.get(x['label']),x['count'])
    def test_analysis_sampling_and_truncation_are_explicit(self):
        ctx,e,c=self.corpus.context(self.payload(limit=5))
        self.assertEqual(len(e),5)
        self.assertFalse(c['all_papers_included'])
        self.assertEqual(c['selection'],'按刊期排序等距抽样')
        self.assertTrue(all(len(x['abstract'])<=1400 for x in e))
    def test_refine_batches_do_not_skip_or_duplicate(self):
        _,a,ca=self.corpus.context(self.payload('refine',limit=5))
        _,b,cb=self.corpus.context(self.payload('refine',limit=5,offset=5))
        self.assertEqual([x['id'] for x in a+b],self.ids[:10])
        self.assertEqual(ca['next_offset'],5)
        self.assertEqual(cb['next_offset'],10)
    def test_plan_has_no_paper_text(self):
        ctx,e,c=self.corpus.context(self.payload('plan'))
        self.assertEqual(e,[])
        self.assertNotIn('papers',ctx)
        self.assertEqual(c['sent_papers'],0)
    def test_unknown_ids_and_mismatched_filters_are_rejected(self):
        bad=self.payload();bad['context']={'parameters':self.defaults,'matched_ids':['invented']}
        with self.assertRaises(ValueError):self.corpus.context(bad)
        bad=self.payload();bad['context']={'parameters':{**self.defaults,'from':11,'to':11},'matched_ids':self.ids}
        with self.assertRaises(ValueError):self.corpus.context(bad)
    def test_empty_query_cannot_refine_entire_corpus(self):
        bad=self.payload('refine');bad['context']={'parameters':{**self.defaults,'query':''},'matched_ids':self.ids}
        with self.assertRaises(ValueError):self.corpus.context(bad)
    def test_json_fences_and_incomplete_responses(self):
        self.assertEqual(parse_model_json('```json\n{"summary":"ok"}\n```'),{'summary':'ok'})
        with self.assertRaises(ValueError):parse_model_json('{"summary":')
    def test_fabricated_references_are_removed(self):
        e=[{'ref':'P1','id':'doc1','title':'真实文献','abstract':'','keywords':''}]
        r,w=validate_result('analyze',{'findings':[{'title':'find','basis':'papers','refs':['P1','P999']}]},e)
        self.assertEqual(r['findings'][0]['refs'],['P1'])
        self.assertTrue(w)
    def test_unverifiable_relevance_quote_is_downgraded(self):
        e=[{'ref':'P1','id':'doc1','title':'糖尿病肾病研究','abstract':'铁死亡是研究主题。','keywords':'铁死亡'}]
        r,w=validate_result('refine',{'papers':[{'ref':'P1','label':'direct','quote':'凭空编造的动物实验结论'}]},e)
        self.assertEqual(r['papers'][0]['label'],'uncertain')
        self.assertFalse(r['papers'][0]['quote_verified'])
    def test_literal_quote_and_missing_document_handling(self):
        e=[{'ref':'P1','id':'doc1','title':'糖尿病肾病研究','abstract':'铁死亡是研究主题。','keywords':'铁死亡'}, {'ref':'P2','id':'doc2','title':'另一个标题','abstract':'','keywords':''}]
        r,w=validate_result('refine',{'papers':[{'ref':'P1','label':'direct','quote':'铁死亡是研究主题。'}]},e)
        self.assertEqual(r['papers'][0]['label'],'direct')
        self.assertTrue(r['papers'][0]['quote_verified'])
        self.assertEqual(r['papers'][1]['label'],'uncertain')
    def test_api_key_not_in_shipped_source_or_html(self):
        for name in ('ai.js','ai-panel.html','app.js','index.template.html','ai_server.py','中医药热点计量工作台.html'):
            self.assertIsNone(re.search(r'sk-[A-Za-z0-9]{24,}',(ROOT/name).read_text()),name)

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(EvidenceChecks)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    report={'passed':result.wasSuccessful(),'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'checks':[name for name in unittest.defaultTestLoader.getTestCaseNames(EvidenceChecks)]}
    (ROOT/'AI离线核验.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
