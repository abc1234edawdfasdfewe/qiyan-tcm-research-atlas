#!/bin/zsh
set -u
ATLAS_PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ATLAS_PROJECT_DIR" || exit 1
if [ -x /opt/homebrew/bin/python3 ]; then
  ATLAS_PYTHON=/opt/homebrew/bin/python3
elif [ -x /usr/local/bin/python3 ]; then
  ATLAS_PYTHON=/usr/local/bin/python3
else
  ATLAS_PYTHON="$(command -v python3)"
fi
if [ -z "$ATLAS_PYTHON" ]; then
  print '需要 Python 3 才能运行本地 AI 服务。基础 HTML 仍可离线打开。'
  read '?按回车关闭…'
  exit 1
fi
if [ ! -f '中医药热点计量工作台.html' ]; then
  print '首次启动：从仓库数据生成本地界面…'
  if ! "$ATLAS_PYTHON" build.py --prepared data/corpus.json.gz; then
    print '界面构建失败，请检查 data/corpus.json.gz 是否完整。'
    read '?按回车关闭…'
    exit 1
  fi
fi
function atlas_ready() {
  "$ATLAS_PYTHON" -c 'import json,urllib.request; s=json.load(urllib.request.urlopen("http://127.0.0.1:8771/api/status",timeout=2)); assert s.get("version")=="2.0" and s.get("model")=="gemini-4-argon-high"' >/dev/null 2>&1
}
if ! (atlas_ready && sleep 0.3 && atlas_ready); then
  mkdir -p .runtime
  "$ATLAS_PYTHON" - <<'PYLAUNCH'
from pathlib import Path
import subprocess,sys
root=Path.cwd()
with (root/'.runtime/server.log').open('ab') as log:
    process=subprocess.Popen([sys.executable,'-u',str(root/'ai_server.py')],cwd=root,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,close_fds=True)
(root/'.runtime/server.pid').write_text(str(process.pid))
PYLAUNCH
  for ATLAS_ATTEMPT in {1..30}; do
    if atlas_ready; then break; fi
    sleep 0.3
  done
fi
if atlas_ready; then
  if [ "${ATLAS_NO_OPEN:-0}" != '1' ]; then
    open -a 'ego lite' 'http://127.0.0.1:8771/#ai' 2>/dev/null || open 'http://127.0.0.1:8771/#ai'
  fi
  print 'AI 工作台已打开：http://127.0.0.1:8771/'
  print '服务在本机后台运行。关闭此窗口不影响使用；停止服务可双击“停止AI服务.command”。'
else
  print '本地服务启动失败。可查看此目录 .runtime/server.log，或运行 python3 ai_server.py。'
  read '?按回车关闭…'
fi
