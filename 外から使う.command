#!/bin/bash
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' 2>/dev/null; then
  echo 'Node.js 24以降が必要です。https://nodejs.org/ からインストールしてください。'
  read -r -p 'Enterで終了します。'
  exit 1
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  echo '最初にMacのターミナルで brew install cloudflared を実行してください。'
  echo 'Homebrewがない場合: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/'
  read -r -p 'Enterで終了します。'
  exit 1
fi
if [ ! -d node_modules/web-push ]; then npm ci --no-audit --no-fund; fi
node src/public.js || { read -r -p '上のメッセージを確認してEnterで終了してください。'; exit 1; }
