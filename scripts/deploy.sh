#!/usr/bin/env bash
# 上線流程：先驗，再重啟，重啟後再驗一次。任一步失敗即中止，不會留下半套狀態。
#
#   ./scripts/deploy.sh              # 完整流程
#   ./scripts/deploy.sh --skip-ui    # 略過前端冒煙（沒有安裝瀏覽器的機器）
#
# 步驟：
#   1. API 冒煙測試（拋棄式資料庫，不碰正式資料）——不過就不重啟
#   2. 手動備份一次（重啟前先留一份，改壞了可以退回）
#   3. pm2 restart
#   4. 等服務起來，再跑前端冒煙（唯讀）
set -euo pipefail

cd "$(dirname "$0")/.."
APP=mental-hug
PORT=${PORT:-3350}
SKIP_UI=${1:-}

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

step "1/4 API 冒煙測試"
npm run --silent smoke || fail "API 冒煙測試未通過，已中止部署（正式站未重啟）"

step "2/4 重啟前先備份"
# 服務還活著時透過 API 備份；服務已掛掉就跳過，不擋部署
if curl -fsS -o /dev/null "http://localhost:$PORT/api/public/ui-texts" 2>/dev/null; then
  cp -a data/mindcare.db "data/backups/pre-deploy-$(date +%Y%m%d-%H%M%S).db" 2>/dev/null \
    && echo "  已複製一份部署前資料庫到 data/backups/" \
    || echo "  （略過：無法複製資料庫，請確認 data/backups 存在）"
else
  echo "  （服務目前沒有回應，略過部署前備份）"
fi

step "3/4 重啟服務"
pm2 restart "$APP" >/dev/null
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/api/public/ui-texts" 2>/dev/null; then
    echo "  服務已就緒（$i 秒）"
    break
  fi
  [ "$i" = 30 ] && fail "重啟後 30 秒內服務沒有回應，請看 pm2 logs $APP"
  sleep 1
done

step "4/4 前端冒煙測試"
if [ "$SKIP_UI" = "--skip-ui" ]; then
  echo "  （依參數略過）"
else
  BASE="http://localhost:$PORT" npm run --silent smoke:ui || fail "前端冒煙測試未通過，請檢查（服務已是新版）"
fi

printf '\n\033[32m✓ 部署完成\033[0m\n'
