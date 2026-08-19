#!/bin/bash
# 重啟本專案（擁抱心理）的服務。
# 本機同時跑著其他以同一套程式碼部署的諮商所（各自獨立的 pm2 程序與資料庫），
# 因此這裡只認名字 mental-hug，不用 pkill -f 之類會誤傷鄰居的做法。
set -e
APP=mental-hug
PORT=${PORT:-3350}
pm2 restart "$APP" --update-env
for _ in $(seq 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/public/ui-texts"; then
    echo "擁抱心理已啟動（$APP，埠 $PORT）"
    exit 0
  fi
  sleep 1
done
echo "啟動失敗："; pm2 logs "$APP" --lines 20 --nostream; exit 1
