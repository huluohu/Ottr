#!/usr/bin/env bash
# scripts/spike-latency.sh — Task 4 (Spike #2) 击键延迟自动化测量驱动。
#
# 取数机制（无人值守，不开人工窗口）：
#   1. 本脚本以 OTTR_SPIKE=latency 后台起 `npx tauri dev`（日志重定向 /tmp/ottr-tauri-dev.log）；
#      Rust setup() 检测该环境变量后把主窗口导航到 http://localhost:1420/?spike=latency。
#   2. 前端自动：通道探针 → attach 夹具(127.0.0.1:2222) → `exec cat` → 打 100 字符
#      （间隔 20ms）→ performance.now() 统计 p50/p95 → POST 给 Rust command
#      `spike_report_latency`（合并 Rust 侧字节计数）落盘 $REPORT。
#   3. 本脚本轮询 $REPORT，拿到后打印并 kill dev server 全家。
#
# 用法：scripts/spike-latency.sh [等待报告超时秒数，默认 300]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="${OTTR_SPIKE_REPORT:-/tmp/ottr-latency.json}"
DEVLOG=/tmp/ottr-tauri-dev.log
TIMEOUT="${1:-300}"

export PATH="$HOME/.cargo/bin:$PATH"
export OTTR_SPIKE=latency
# 逐批 flush 大小打点（帧长对账用）
export OTTR_BATCH_DEBUG=1
# 合批窗口实验旋钮（ms；0 = 到即 flush 不合并）。不设置则用 Rust 侧默认（4ms）。
if [ -n "${OTTR_BATCH_WINDOW_MS:-}" ]; then export OTTR_BATCH_WINDOW_MS; fi

# cargo workspace 的 target 在仓库根（tauri dev 运行 $ROOT/target/debug/ottr）
APP_BIN="$ROOT/target/debug/ottr"

if ! nc -z 127.0.0.1 2222 2>/dev/null; then
  echo "FAIL: 夹具 127.0.0.1:2222 不可达（先 scripts/spike-sshd.sh start）"
  exit 1
fi

# 预清理：上次运行或前任遗留的 ottr 实例会共用 :1420 的 vite 页面、
# 往同一报告文件写数，污染测量（教训：曾导致两份报告互相覆盖）
pkill -f "$APP_BIN" 2>/dev/null || true
sleep 1
pkill -9 -f "$APP_BIN" 2>/dev/null || true

rm -f "$REPORT" "$DEVLOG"

cleanup() {
  if [ -n "${TAURI_PID:-}" ]; then
    pkill -TERM -P "$TAURI_PID" 2>/dev/null || true
    kill "$TAURI_PID" 2>/dev/null || true
  fi
  sleep 1
  pkill -f "$APP_BIN" 2>/dev/null || true
  lsof -ti tcp:1420 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1
  pkill -9 -f "$APP_BIN" 2>/dev/null || true
  lsof -ti tcp:1420 2>/dev/null | xargs kill -9 2>/dev/null || true
}
trap cleanup EXIT

cd "$ROOT"
npx tauri dev >"$DEVLOG" 2>&1 &
TAURI_PID=$!

echo "tauri dev pid=$TAURI_PID log=$DEVLOG"
echo "waiting for dev server :1420 ..."
up=0
for _ in $(seq 1 180); do
  # vite（Node >=17）把 localhost 绑在 IPv6 ::1 上，127.0.0.1 探测不到
  if nc -z ::1 1420 2>/dev/null; then up=1; break; fi
  if ! kill -0 "$TAURI_PID" 2>/dev/null; then
    echo "FAIL: tauri dev 提前退出"
    tail -40 "$DEVLOG"
    exit 1
  fi
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "FAIL: dev server 180s 未就绪"
  tail -40 "$DEVLOG"
  exit 1
fi
echo "dev server up; waiting for report $REPORT (timeout ${TIMEOUT}s) ..."

deadline=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ -s "$REPORT" ]; then
    echo "=== REPORT ($REPORT) ==="
    cat "$REPORT"
    echo "=== END REPORT ==="
    exit 0
  fi
  if ! kill -0 "$TAURI_PID" 2>/dev/null; then
    echo "FAIL: tauri dev 退出但未产出报告"
    tail -60 "$DEVLOG"
    exit 1
  fi
  sleep 2
done

echo "FAIL: ${TIMEOUT}s 内未拿到报告"
tail -60 "$DEVLOG"
exit 1
