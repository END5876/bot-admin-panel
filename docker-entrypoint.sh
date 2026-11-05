#!/bin/sh
# 容器啟動：以 root 修正資料目錄的擁有者後，改用 node 帳號（uid 1000）執行服務
# （主機上新建的 Volume 目錄屬於 root，直接以 node 執行會寫不進 Session 金鑰與操作紀錄）
set -e

DATA_DIR="${PANEL_DATA_DIR:-/app/data}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  find "$DATA_DIR" -xdev ! -user node -exec chown node:node {} + \
    || echo "[entrypoint] ⚠️ 無法修正 $DATA_DIR 的擁有者，面板可能沒有寫入權限" >&2
  # setpriv 會 exec 成目標程式（PID 不變），node 直接收到 SIGTERM、把操作紀錄寫完再結束
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
