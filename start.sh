#!/usr/bin/env bash
# BiliNest 启动脚本（macOS / Linux）
# 启动本地代理（server.mjs），并在默认浏览器打开应用。
# 若默认端口 4173 被占用，server.mjs 会自动顺延端口并写入 bilinest.port，
# 本脚本读取实际端口后再打开浏览器。
# 用法：  ./start.sh
set -e

cd "$(dirname "$0")"

# 若未安装 Node 给出友好提示
if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先到 https://nodejs.org 安装（需 18 及以上），再运行本脚本。"
  exit 1
fi

# 启动前清掉旧的端口文件，避免读到上一次运行残留
PORT_FILE="bilinest.port"
DEF_PORT=4173
URL=""
rm -f "$PORT_FILE"

node server.mjs &
SERVER_PID=$!

# 等待端口文件出现（最多 20 秒），拿到实际端口
for ((i = 0; i < 40; i++)); do
  if [ -s "$PORT_FILE" ]; then
    P=$(tr -d '[:space:]' < "$PORT_FILE")
    case "$P" in
      ''|*[!0-9]*) ;;
      *) URL="http://127.0.0.1:$P"; break ;;
    esac
  fi
  sleep 0.5
done

# 兜底：端口文件未生成时用默认端口（服务可能恰好起在 4173）
if [ -z "$URL" ]; then
  URL="http://127.0.0.1:$DEF_PORT"
fi

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1 || true
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1 || true
else
  echo "请手动在浏览器打开 $URL"
fi

echo "BiliNest 本地服务已启动（$URL，PID $SERVER_PID）。按 Ctrl+C 停止。"
wait "$SERVER_PID"
