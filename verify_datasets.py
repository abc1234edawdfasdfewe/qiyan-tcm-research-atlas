#!/usr/bin/env python3
"""Verify the uploaded canonical snapshots without network requests."""
from pathlib import Path
import collections,gzip,hashlib,json
ROOT=Path(__file__).resolve().parent

def main():
    ledger=json.loads((ROOT/'datasets/manifest.json').read_text())
    for row in ledger['files']:
        path=ROOT/'datasets'/row['path']
        assert path.stat().st_size==row['bytes'],row['path']
        assert hashlib.sha256(path.read_bytes()).hexdigest()==row['sha256'],row['path']
    with gzip.open(ROOT/'datasets/enriched/全部文献详情.json.gz','rt',encoding='utf-8') as f:raw=json.load(f)
    with gzip.open(ROOT/'data/corpus.json.gz','rt',encoding='utf-8') as f:corpus=json.load(f)
    scopes=dict(collections.Counter(r['collection_scope'] for r in raw))
    assert scopes=={'main':21709,'early':18,'supplement':73},scopes
    assert len({r['id'] for r in raw})==21800
    main={r['id'] for r in raw if r['collection_scope']=='main'}
    assert main=={r['id'] for r in corpus['docs']}
    assert len(corpus['journals'])==67
    assert sum(d['dup']<0 for d in corpus['docs'])==21686
    raw_hash=hashlib.sha256((ROOT/'datasets/enriched/全部文献详情.json.gz').read_bytes()).hexdigest()
    assert raw_hash==corpus['meta']['corpus_sha256']
    report={'passed':True,'raw_records':len(raw),'scopes':scopes,'journals':67,'app_main_records':len(main),'default_deduplicated_records':21686,'input_files_verified':len(ledger['files']),'raw_corpus_sha256':raw_hash}
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':main()
