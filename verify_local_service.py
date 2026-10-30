#!/usr/bin/env python3
"""Read-only local HTTP boundary checks; never calls the model provider."""
import json
from pathlib import Path
import urllib.request
import urllib.error

BASE='http://127.0.0.1:8771'
def request(path,headers=None,data=None,method=None):
    req=urllib.request.Request(BASE+path,headers=headers or {},data=data,method=method)
    try:
        with urllib.request.urlopen(req,timeout=5) as response:
            return response.status,dict(response.headers),response.read(2_000_000)
    except urllib.error.HTTPError as response:
        return response.code,dict(response.headers),response.read(2_000_000)
checks=[]
def check(name,condition):
    if not condition:raise AssertionError(name)
    checks.append({'name':name,'passed':True})
code,headers,body=request('/api/status');status=json.loads(body)
check('status responds with configured model and never returns API key',code==200 and status['model']=='gemini-4-argon-high' and not any(k in status for k in ['key','api_key','password']) and b'sk-' not in body)
code,headers,_=request('/api/status',{'Origin':'https://untrusted.example'})
check('foreign origin cannot read status/session',code==403 and 'Access-Control-Allow-Origin' not in headers)
code,_,_=request('/api/status',{'Host':'untrusted.example:8771'})
check('foreign Host is rejected',code==403)
code,_,_=request('/api/ai',{'Content-Type':'application/json'},b'{}')
check('POST requires local session token',code==403)
code,_,_=request('/api/ai',{'Content-Type':'application/json','Origin':'null','X-Atlas-Session':status['session_token']},b'{}')
check('file or opaque origins cannot call model',code==403)
code,_,_=request('/api/ai',{'Content-Type':'text/plain','X-Atlas-Session':status['session_token']},b'{}')
check('simple cross-site form types are not accepted',code==415)
code,_,_=request('/api/ai',{'Content-Type':'application/json','X-Atlas-Session':status['session_token'],'Content-Length':'2000001'},b'{}')
check('oversized requests are rejected before parsing',code==413)
code,_,_=request('/data/corpus.json.gz');check('server does not expose arbitrary files or directory listings',code==404)
code,headers,_=request('/api/status',method='OPTIONS');check('CORS preflight is denied',code==403)
report={'passed':True,'checks':checks,'provider_calls':0}
(Path(__file__).resolve().parent/'本地服务边界核验.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
print(json.dumps(report,ensure_ascii=False,indent=2))
