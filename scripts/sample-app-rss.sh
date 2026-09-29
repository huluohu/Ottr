#!/usr/bin/env bash
# scripts/sample-app-rss.sh — Task 13 补充测量：macOS 完整 App 口径（含 webview）RSS。
# 用法: sample-app-rss.sh <idle|render> [采样秒数=20]
# idle   → 直接启动 app（主页面，无会话）
# render → OTTR_SPIKE=render 启动（?spike=render 测量页跑完保持窗口）
# 采样: 每 0.5s 记 ottr 主进程 + 全部子进程（WebKit WebContent/GPU/Networking）RSS 之和。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="$ROOT/target/debug/ottr"
MODE="${1:?usage: sample-app-rss.sh idle|render [secs]}"
SECS="${2:-20}"
LOG="/tmp/ottr-app-rss-$MODE.log"

pkill -f "$APP_BIN" 2>/dev/null || true; sleep 1; pkill -9 -f "$APP_BIN" 2>/dev/null || true

if [ "$MODE" = "render" ]; then
  cd "$ROOT"; npm run dev >/tmp/ottr-vite-rss.log 2>&1 &
  VITE=$!
  for _ in $(seq 1 60); do nc -z ::1 1420 2>/dev/null && break; sleep 1; done
  OTTR_SPIKE=render "$APP_BIN" >/tmp/ottr-app-rss-render-app.log 2>&1 &
else
  "$APP_BIN" >/tmp/ottr-app-rss-idle-app.log 2>&1 &
fi
APP=$!

: > "$LOG"
# 等窗口起来
for _ in $(seq 1 60); do kill -0 "$APP" 2>/dev/null || break; pgrep -q -f "target/debug/ottr$" && break; sleep 0.5; done
PID=$(pgrep -f "target/debug/ottr$" | head -1)
[ -n "$PID" ] || { echo "no app pid"; exit 1; }
echo "# t_s main_kb kids_kb sum_kb kids_list" >> "$LOG"
T0=$(date +%s)
while [ $(( $(date +%s) - T0 )) -lt "$SECS" ]; do
  kill -0 "$APP" 2>/dev/null || break
  MAIN=$(ps -o rss= -p "$PID" 2>/dev/null | tr -d ' ' || echo 0)
  KIDS=""; SUM=${MAIN:-0}
  for c in $(pgrep -P "$PID" 2>/dev/null); do
    R=$(ps -o rss= -p "$c" 2>/dev/null | tr -d ' '); C=$(ps -o comm= -p "$c" 2>/dev/null | head -c 40)
    [ -n "$R" ] && { KIDS="$KIDS $c:$R($C)"; SUM=$((SUM + R)); }
  done
  T=$(( $(date +%s) - T0 ))
  echo "$T ${MAIN:-0} ${KIDS:-none} $SUM" >> "$LOG"
  sleep 0.5
done
kill "$APP" 2>/dev/null || true
[ -n "${VITE:-}" ] && kill "$VITE" 2>/dev/null || true
sleep 1
pkill -9 -f "$APP_BIN" 2>/dev/null || true
awk '/^#/ {next} {if ($4+0 > max) max=$4+0; s+=$4; n++} END {printf "%s samples=%d avg=%dKB max=%dKB\n", FILENAME, n, s/n, max}' "$LOG"
tail -3 "$LOG"
