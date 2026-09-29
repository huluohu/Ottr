#!/usr/bin/env bash
# scripts/spike-throughput.sh — Task 7 (Spike #3) 100MB 吞吐/背压自动化测量驱动。
#
# 取数机制（无人值守，复用 Task 4 套路，见 scripts/spike-latency.sh）：
#   1. 本脚本以 OTTR_SPIKE=throughput 后台起 `npx tauri dev`（日志 /tmp/ottr-tauri-dev.log）；
#      Rust setup() 检测该环境变量后把主窗口导航到 http://localhost:1420/?spike=throughput
#      （OTTR_SPIKE_INTERRUPT=1 时追加 &interrupt=1 → 页面自动执行 Step 4 中断验证）。
#   2. 前端自动：attach 夹具(127.0.0.1:2222) → `cat /tmp/big100`（104857600 B）→
#      rAF 冻结探测 + 前端字节计数 + 轮询 Rust session_stats → 三方账目 JSON
#      POST 给 `spike_report_latency`（合并 Rust 侧计数）落盘 $REPORT。
#   3. 本脚本轮询 $REPORT，拿到后打印、核对中断日志（interrupt 跑必须出现
#      "session dropped"）并 kill dev server 全家。
#
# 用法：scripts/spike-throughput.sh [等待报告超时秒数，默认 300]
# 环境变量：
#   OTTR_BATCH_WINDOW_MS   合批窗口实验旋钮（不设置 = Rust 默认 4ms）
#   OTTR_SPIKE_INTERRUPT=1 中断验证跑（页面自动 drop session）
#   OTTR_BATCH_DEBUG=1     逐批 flush 打点（100MB 会产生上千行日志，默认关）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT="${OTTR_SPIKE_REPORT:-/tmp/ottr-throughput.json}"
DEVLOG=/tmp/ottr-tauri-dev.log
TIMEOUT="${1:-300}"

export PATH="$HOME/.cargo/bin:$PATH"
export OTTR_SPIKE=throughput
if [ -n "${OTTR_BATCH_WINDOW_MS:-}" ]; then export OTTR_BATCH_WINDOW_MS; fi
if [ -n "${OTTR_SPIKE_INTERRUPT:-}" ]; then export OTTR_SPIKE_INTERRUPT; fi
if [ -n "${OTTR_BATCH_DEBUG:-}" ]; then export OTTR_BATCH_DEBUG; fi

# cargo workspace 的 target 在仓库根（tauri dev 运行 $ROOT/target/debug/ottr）
APP_BIN="$ROOT/target/debug/ottr"

if ! nc -z 127.0.0.1 2222 2>/dev/null; then
  echo "FAIL: 夹具 127.0.0.1:2222 不可达（先 scripts/spike-sshd.sh start）"
  exit 1
fi
if ! docker exec ottr-sshd stat -c %s /tmp/big100 2>/dev/null | grep -q 104857600; then
  echo "FAIL: 夹具内 /tmp/big100 不是 104857600 字节（夹具重建后需重新生成）"
  exit 1
fi

# 预清理：遗留 ottr 实例会共用 :1420 页面、往同一报告文件写数（T4 教训）
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

echo "tauri dev pid=$TAURI_PID log=$DEVLOG window=${OTTR_BATCH_WINDOW_MS:-default}ms interrupt=${OTTR_SPIKE_INTERRUPT:-0}"
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
    # 中断跑的进程端证据：转发循环必须打出 session dropped（简报 Step 4）
    drops=$(grep -c "session dropped" "$DEVLOG" 2>/dev/null || true)
    echo "=== dev log 'session dropped' lines: $drops ==="
    if [ "${OTTR_SPIKE_INTERRUPT:-0}" = "1" ] && [ "$drops" -lt 1 ]; then
      echo "FAIL: 中断跑但 dev log 没有 session dropped"
      tail -60 "$DEVLOG"
      exit 1
    fi
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
