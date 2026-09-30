#!/bin/bash
# Task 17 稳定性维 T4：1h 长跑驱动（5 夹具会话 + 会话0 SFTP 100MB×N 循环）+ 60s 采样
#
# 用法: scripts/soak-1h.sh [hold_secs] [out_dir]
#   默认 hold=3600, out=/tmp/ottr-t17
# 采样: $out/soak-log 每 60s 一行 CSV：
#   unix_ts,elapsed_s,bench_rss_kb,container_mem_mb,rounds_done,err_lines
# 汇总: $out/soak-summary.txt（首末 RSS/峰值/增长率/完成轮次/错误行数）
# 依赖: target/release/ottr-bench（cargo build --release -p ottr-bench）、
#       夹具容器 ottr-sshd 运行中（127.0.0.1:2222，scripts/spike-sshd.sh）
#
# 后台常驻启动（存活于调用方生命周期之外）:
#   nohup scripts/soak-1h.sh 3600 /tmp/ottr-t17 >/tmp/ottr-t17/soak-driver.log 2>&1 & disown
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

HOLD=${1:-3600}
OUT=${2:-/tmp/ottr-t17}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/release/ottr-bench"

[ -x "$BIN" ] || { echo "FATAL: $BIN 不存在（先 cargo build --release -p ottr-bench）" >&2; exit 1; }
mkdir -p "$OUT"

"$BIN" sessions 5 "$HOLD" > "$OUT/soak-bench.log" 2>&1 &
BPID=$!
T0=$(date +%s)

rss_of() { ps -o rss= -p "$1" 2>/dev/null | tr -d ' ' || true; }

FIRST=""
MAX=0
i=0
while :; do
  NOW=$(date +%s)
  EL=$((NOW - T0))
  R=$(rss_of "$BPID"); [ -z "$R" ] && R=0
  [ -z "$FIRST" ] && FIRST=$R
  [ "$R" -gt "$MAX" ] && MAX=$R
  CONT=$(docker stats --no-stream --format '{{.MemUsage}}' ottr-sshd 2>/dev/null | awk '{print $1}' || true)
  ROUNDS=$(grep -c 'sftp round done' "$OUT/soak-bench.log" 2>/dev/null || true)
  ERRS=$(grep -ciE 'err|fail|panic' "$OUT/soak-bench.log" 2>/dev/null || true)
  echo "$NOW,$EL,$R,${CONT:--},$ROUNDS,${ERRS:-0}" >> "$OUT/soak-log"
  [ "$EL" -ge "$HOLD" ] && break
  sleep 60
done

wait "$BPID" 2>/dev/null
LAST=$(tail -1 "$OUT/soak-log" | cut -d, -f3)
ALIVE="no"; rss_of "$BPID" >/dev/null 2>&1 && [ -n "$(rss_of "$BPID")" ] && ALIVE="yes"
{
  echo "hold_secs=$HOLD"
  echo "first_rss_kb=$FIRST"
  echo "last_rss_kb=$LAST"
  echo "max_rss_kb=$MAX"
  echo "growth_kb=$((LAST - FIRST))"
  echo "growth_pct=$(awk -v a="$FIRST" -v b="$LAST" 'BEGIN{printf "%.1f", (b-a)*100/a}')"
  echo "rounds_done=$(grep -c 'sftp round done' "$OUT/soak-bench.log" 2>/dev/null || echo 0)"
  echo "err_lines=$(grep -ciE 'err|fail|panic' "$OUT/soak-bench.log" 2>/dev/null || echo 0)"
  echo "bench_still_alive_at_summary=$ALIVE"
  echo "bench_log_tail:"
  tail -3 "$OUT/soak-bench.log"
} > "$OUT/soak-summary.txt"
cat "$OUT/soak-summary.txt"
