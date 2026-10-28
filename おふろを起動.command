#!/bin/bash
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! node -e 'if(Number(process.versions.node.split(".")[0])<24)process.exit(1)' 2>/dev/null; then
  echo 'Node.js 24以降が必要です。https://nodejs.org/ からインストールしてください。'
  read -r -p 'Enterで終了します。'
  exit 1
fi
if [ ! -d node_modules/web-push ]; then npm ci --no-audit --no-fund; fi
node --input-type=module -e 'import {openApplication} from "./src/runtime.js"; import {configureFamily} from "./src/family-password.js"; const app=openApplication(); try {if(!app.familyConfigured())await configureFamily(app);} finally{app.close();}'
node src/server.js &
bathjun_pid=$!
trap 'kill "$bathjun_pid" 2>/dev/null || true' EXIT
trap 'exit 0' INT TERM
bathjun_port="${PORT:-3000}"
for ((attempt=0;attempt<50;attempt++)); do
  if ! kill -0 "$bathjun_pid" 2>/dev/null; then
    wait "$bathjun_pid" || true
    read -r -p '起動できませんでした。上のエラーを確認してEnterで終了してください。'
    exit 1
  fi
  if curl --silent --fail "http://localhost:${bathjun_port}/api/members" >/dev/null; then
    open "http://localhost:${bathjun_port}"
    break
  fi
  sleep 0.1
done
wait "$bathjun_pid"
