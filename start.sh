#!/usr/bin/env bash
# BiliPure 启动脚本（macOS / Linux）
# 启动本地代理（server.mjs），并在默认浏览器打开应用。
# 用法：  ./start.sh
set -e

cd "$(dirname "$0")"

# 若未安装 Node 给出友好提示
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先到 https://nodejs.org 安装（需 18 及以上），再运行本脚本。"
  exit 1
fi

node server.mjs &
SERVER_PID=$!
# 等代理起来再开浏览器
sleep 1.5

URL="http://127.0.0.1:4173"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true
else
  echo "请手动在浏览器打开 $URL"
fi

echo "BiliPure 本地服务已启动（PID $SERVER_PID）。按 Ctrl+C 停止。"
wait "$SERVER_PID"
