#!/bin/zsh
cd "$(dirname "$0")" || exit 1
python3 - <<'PY'
import json,urllib.request,urllib.error,time,socket
base='http://127.0.0.1:8771'
try:
    status=json.load(urllib.request.urlopen(base+'/api/status',timeout=3))
    if status.get('version')!='2.0' or status.get('model')!='gemini-4-argon-high':
        raise ValueError('端口不是岐研 AI 服务，未停止。')
    request=urllib.request.Request(base+'/api/shutdown',data=b'{}',headers={'Content-Type':'application/json','X-Atlas-Session':status['session_token']})
    json.load(urllib.request.urlopen(request,timeout=5))
    for _ in range(40):
        try:
            with socket.create_connection(('127.0.0.1',8771),timeout=0.3):pass
        except OSError:
            break
        time.sleep(0.2)
    else:
        raise RuntimeError('服务仍在退出中，请稍后再启动。')
    print('本地 AI 服务已停止，密钥仍保留在本机钥匙串。')
except urllib.error.URLError:
    print('本地服务未运行。')
except Exception as e:
    print('未能停止：'+str(e))
PY
