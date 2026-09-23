#!/usr/bin/env bash
# 启动 syncx 生产形态 Web 预览(控制端口 8384)。
#
# 为什么需要这个脚本,而不是直接 `node dist/syncx.js start --expose-control`:
# 沙箱里后台任务会被周期回收,被回收的进程有时会变成孤儿继续占端口。
# dev(npm run dev)与生产各占一套端口:dev 用 peer 23000 / 控制 9384 / vite 5173,
# 生产默认 peer 22000 / 控制 8384。本脚本启动前把两套端口全部释放,
# 保证 prod 干净地由 8384 直供页面(返回 200 + 完整 HTML,而非 302)。
#
# 注意:此脚本用于沙箱预览,会杀掉占用上述端口的进程。若本机另有正在运行的
# 真实 syncx 守护进程,请勿直接跑本脚本。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONTROL_PORT="${SYNCX_CONTROL_PORT:-8384}"

echo "[start-prod] freeing stale ports (8384/9384/5173/22000/23000)..."
for p in 8384 9384 5173 22000 23000; do
  pid="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
  if [ -n "$pid" ]; then
    echo "[start-prod] killing orphan pid $pid on :$p"
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 2

cd "$ROOT"
echo "[start-prod] launching prod control server on :$CONTROL_PORT (http://127.0.0.1:$CONTROL_PORT)"
exec node dist/syncx.js start --expose-control "$@"
