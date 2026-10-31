"""Offline import/privacy and AI grounding tests; uses synthetic documents only."""
import base64
import io
import json
from pathlib import Path
import unittest
import zipfile
from ai_server import Corpus
import journal_service as service


def docx(paragraphs):
    from xml.sax.saxutils import escape
    xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+''.join('<w:p><w:r><w:t>'+escape(p)+'</w:t></w:r></w:p>' for p in paragraphs)+'</w:body></w:document>'
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as z:z.writestr('word/document.xml',xml)
    return {'base64':base64.b64encode(buffer.getvalue()).decode()}


class JournalChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.corpus=Corpus()
    def payload(self):
        return {'consent':True,'manuscript':{'title':'面向中医古籍医案的实体关系抽取方法研究'},'candidates':[{'code':'SJKX','ids':['SJKX202604028','SJKX202606030']}]}
    def test_import_returns_summary_without_body(self):
        r=service.import_docx(docx(['古籍医案自动结构化方法研究','作者甲','【摘要】目的：研究文本抽取。','方法：对照评价。','【关键词】医案；实体识别','1 引言','PRIVATE_BODY_SENTINEL']))
        self.assertEqual(r['title'],'古籍医案自动结构化方法研究')
        self.assertIn('对照评价',r['abstract'])
        self.assertEqual(r['keywords'],'医案；实体识别')
        self.assertNotIn('PRIVATE_BODY_SENTINEL',json.dumps(r))
    def test_missing_abstract_does_not_send_full_body(self):
        r=service.import_docx(docx(['古籍医案研究的新方法','PRIVATE_BODY_SENTINEL']))
        self.assertEqual(r['abstract'],'')
        self.assertGreater(len(r['warnings']),1)
    def test_fullwidth_summary_labels(self):
        r=service.import_docx(docx(['古籍文本的实体关系抽取研究','［摘要］ 目的：研究古籍抽取。方法：对照实验。','［关键词］ 古籍；实体识别','ABSTRACT This is not the Chinese abstract.']))
        self.assertIn('对照实验',r['abstract'])
        self.assertEqual(r['keywords'],'古籍；实体识别')
        self.assertNotIn('ABSTRACT',r['abstract'])
    def test_invalid_and_oversized_documents_rejected(self):
        for bad in [{'base64':'!!!!'},{'base64':'x'*(service.MAX_DOCX_BASE64+1)},{'base64':base64.b64encode(b'not a zip').decode()}]:
            with self.assertRaises(ValueError):service.import_docx(bad)
    def test_requires_explicit_ai_consent(self):
        p=self.payload();p['consent']=False
        with self.assertRaises(ValueError):service.context(self.corpus,p)
    def test_rebuilds_evidence_and_counts_from_server_corpus(self):
        p=self.payload();p['candidates'][0]['records']=999999
        ctx,e,c=service.context(self.corpus,p)
        self.assertEqual(len(e),2)
        self.assertEqual(ctx['journals'][0]['comparison_records'],385)
        self.assertEqual(e[0]['title'],self.corpus.by_id[e[0]['id']]['title'])
        self.assertTrue(all(len(p['abstract'])<=1400 for p in e))
        self.assertEqual(c['corpus_journals'],67)
        self.assertNotIn('PRIVATE_BODY_SENTINEL',json.dumps(ctx))
    def test_cross_journal_unknown_and_duplicate_evidence_rejected(self):
        for ids in [['invented'],['ZYHS202601001'],['SJKX202604028','SJKX202604028']]:
            p=self.payload();p['candidates'][0]['ids']=ids
            with self.assertRaises(ValueError):service.context(self.corpus,p)
    def test_invented_journals_and_cross_journal_references_removed(self):
        _,e,_=service.context(self.corpus,self.payload())
        e.append({**e[0],'ref':'P3','journal_code':'ZYHS'})
        raw={'recommendations':[{'journal_code':'INVENTED','refs':['P1']},{'journal_code':'SJKX','fit':'可考虑','refs':['P3','P999']}]}
        r,w=service.validate(raw,e)
        self.assertEqual(len(r['recommendations']),1)
        self.assertEqual(r['recommendations'][0]['refs'],[])
        self.assertEqual(r['recommendations'][0]['position'],'需人工核查')
        self.assertTrue(w)
    def test_context_does_not_accept_body_or_credentials(self):
        p=self.payload();p['manuscript'].update({'full_body':'PRIVATE_BODY_SENTINEL','api_key':'SECRET_SENTINEL'})
        ctx,_,_=service.context(self.corpus,p)
        self.assertNotIn('SENTINEL',json.dumps(ctx))


if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(JournalChecks)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    Path(__file__).with_name('选刊服务核验.json').write_text(json.dumps({'passed':result.wasSuccessful(),'checks':result.testsRun,'provider_calls':0},ensure_ascii=False,indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
