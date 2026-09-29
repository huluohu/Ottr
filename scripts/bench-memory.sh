#!/usr/bin/env bash
# scripts/bench-memory.sh — Task 13 / Spike #10：进程内内存基线驱动。
#
# 跑 ottr-bench 两个模式并用 `ps -o rss=`（KB，macOS/Linux 通行）以 0.5s 周期
# 采样自身 RSS，汇总 max/avg/final：
#   1. idle    —— tokio runtime 空转（零连接），「空闲单进程」对照物（Rust 侧口径）；
#   2. sessions 5 —— 并发 5 条夹具会话（各 PTY + 排空；会话 0 循环 SFTP 分块下
#      big100），保持 60s —— 「5 会话 + 传输中」负载（Rust 侧口径）。
#
# 【口径】这里测的是 Rust 侧进程内基线（无 webview）。spec §9 #10 的红线
# （空闲 <150MB / 5 会话 <250MB）是完整 App 口径，由
# docs/runbooks/spike-win-linux.md 在真实 Win/Linux 机器人工补测，两组数字
# 在 docs/phase0-report.md 分开呈现。
#
# 用法：scripts/bench-memory.sh [输出json=/tmp/ottr-bench-memory.json]
#   PROFILE=release scripts/bench-memory.sh   # 用 target/release/ottr-bench
# 前置：夹具 127.0.0.1:2222 在跑（scripts/spike-sshd.sh），远端 /tmp/big100 存在。
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${PROFILE:-debug}"
BIN="$ROOT/target/$PROFILE/ottr-bench"
LOG="/tmp/ottr-bench-run.log"
OUT="${1:-/tmp/ottr-bench-memory.json}"

[ -x "$BIN" ] || { echo "FAIL: $BIN 不存在（先 cargo build -p ottr-bench）" >&2; exit 1; }
if ! nc -z 127.0.0.1 2222 2>/dev/null; then
  echo "FAIL: 夹具 127.0.0.1:2222 未就绪（先 scripts/spike-sshd.sh）" >&2
  exit 1
fi

# 预清理遗留实例（端口/日志互不干扰，但避免双跑抢夹具）
pkill -f "$BIN" 2>/dev/null || true
sleep 1

# run <mode> <hold> <label> [extra-args...] — 启动 bench、采样 RSS、汇总
# （参数顺序与 ottr-bench usage 一致：`sessions [N] [hold]` / `idle [hold]`）
run() {
  local label="$1"; shift
  : > "$LOG"
  "$BIN" "$@" >"$LOG" 2>&1 &
  local job=$! pid="" rss
  for _ in $(seq 1 100); do
    pid=$(grep -m1 '^PID=' "$LOG" 2>/dev/null | cut -d= -f2 || true)
    [ -n "$pid" ] && break
    sleep 0.2
  done
  if [ -z "$pid" ]; then
    echo "FAIL: 未读到 PID= 行"; tail -5 "$LOG" >&2; exit 1
  fi
  local max=0 sum=0 n=0 final=0
  while kill -0 "$job" 2>/dev/null; do
    rss=$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ' || true)
    if [ -n "$rss" ] && [ "$rss" -gt 0 ] 2>/dev/null; then
      n=$((n + 1)); sum=$((sum + rss)); final=$rss
      [ "$rss" -gt "$max" ] && max=$rss
    fi
    sleep 0.5
  done
  wait "$job" || true
  local avg=0
  [ "$n" -gt 0 ] && avg=$((sum / n))
  echo "$label max=${max}KB avg=${avg}KB final=${final}KB samples=${n}"
  echo "  result: $(grep -m1 '^RESULT ' "$LOG" || echo '(no RESULT line)')"
  echo "${max} ${avg} ${final} ${n}"
}

echo "== ottr-bench ($PROFILE) Spike#10 内存基线 =="
IDLE=$(run "idle(5s)" idle 5)
SESS=$(run "sessions(${BENCH_SESSIONS:-5}N,${BENCH_HOLD:-60}s)" sessions "${BENCH_SESSIONS:-5}" "${BENCH_HOLD:-60}")
echo "$IDLE" | head -1
echo "$SESS" | head -1

IDLE_MAX=$(echo "$IDLE" | tail -1 | awk '{print $1}')
IDLE_AVG=$(echo "$IDLE" | tail -1 | awk '{print $2}')
SESS_MAX=$(echo "$SESS" | tail -1 | awk '{print $1}')
SESS_AVG=$(echo "$SESS" | tail -1 | awk '{print $2}')
SESS_FINAL=$(echo "$SESS" | tail -1 | awk '{print $3}')

cat > "$OUT" <<EOF
{
  "profile": "$PROFILE",
  "method": "ps -o rss= 0.5s 采样；口径=Rust 侧进程内基线（无 webview）",
  "workload": { "idle": "tokio runtime 空转 5s", "sessions": "${BENCH_SESSIONS:-5}N PTY+shell, 会话0 SFTP 循环下 big100(${BENCH_HOLD:-60}s)" },
  "idle_kb": { "max": $IDLE_MAX, "avg": $IDLE_AVG },
  "sessions_kb": { "max": $SESS_MAX, "avg": $SESS_AVG, "final": $SESS_FINAL },
  "bench_result_line": "$(grep -m1 '^RESULT ' "$LOG" 2>/dev/null || echo '')",
  "measured_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(uname -sm)"
}
EOF
echo "report -> $OUT"
