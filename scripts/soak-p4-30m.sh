#!/bin/bash
# Phase 4 Task 7 验收 · 稳定性维：30min 长跑驱动（cron + 监控采样并存）
# 负载（target/release/examples/p4_soak，负载构成见该 example 头注释）：
#   2 会话监控采样（真 collect 生产循环 5s+抖动）+ 1 cron 调度器（双任务 * * * * *：
#   host 1 真 exec ok 轮 + host 99 无会话 missed 轮，生产 20s 心跳+错峰）
#
# 用法: scripts/soak-p4-30m.sh [hold_secs] [out_dir]
#   默认 hold=1800, out=/tmp/p4-t7
# 采样: $out/soak-log 每 30s 一行 CSV：
#   unix_ts,elapsed_s,soak_rss_kb,container_mem_mb,samples0,samples1,cron_ok,cron_missed,err_lines
# 汇总: $out/soak-summary.txt（退出码、RESULT 行、样本数）
# 依赖: target/release/examples/p4_soak、夹具 ottr-sshd(2222) 运行中
#
# 后台常驻启动（存活于调用方生命周期之外）:
#   nohup scripts/soak-p4-30m.sh 1800 /tmp/p4-t7 >/tmp/p4-t7/soak-driver.log 2>&1 & disown
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

HOLD=${1:-1800}
OUT=${2:-/tmp/p4-t7}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOAK="$ROOT/target/release/examples/p4_soak"

[ -x "$SOAK" ] || { echo "FATAL: $SOAK 不存在" >&2; exit 1; }
mkdir -p "$OUT"

"$SOAK" "$HOLD" "$OUT" > "$OUT/soak-run.log" 2> "$OUT/soak-progress.log" &
SPID=$!
T0=$(date +%s)

rss_of() { ps -o rss= -p "$1" 2>/dev/null | tr -d ' ' || true; }

: > "$OUT/soak-log"
echo "unix_ts,elapsed_s,soak_rss_kb,container_mem_mb,samples0,samples1,cron_ok,cron_missed,err_lines" >> "$OUT/soak-log"

while kill -0 "$SPID" 2>/dev/null; do
  NOW=$(date +%s)
  EL=$((NOW - T0))
  R=$(rss_of "$SPID"); [ -z "$R" ] && R=0
  CONT=$(docker stats --no-stream --format '{{.MemUsage}}' ottr-sshd 2>/dev/null | awk '{print $1}' || true)
  S0=$(grep -c 'soak-s0 sample #' "$OUT/soak-progress.log" 2>/dev/null)
  S1=$(grep -c 'soak-s1 sample #' "$OUT/soak-progress.log" 2>/dev/null)
  COK=$(grep -c 'cron ok #' "$OUT/soak-progress.log" 2>/dev/null)
  CMS=$(grep -c 'cron missed #' "$OUT/soak-progress.log" 2>/dev/null)
  # 错误行：排除 RESULT 汇总行本身（其 errors=0 字样会被子串误计，Phase 1 教训）
  ERRS=$(cat "$OUT/soak-run.log" "$OUT/soak-progress.log" 2>/dev/null | grep -viE '^RESULT' | grep -ciE 'error|fail|panic')
  echo "$NOW,$EL,$R,$CONT,$S0,$S1,$COK,$CMS,$ERRS" >> "$OUT/soak-log"
  sleep 30
done

wait "$SPID" 2>/dev/null; STILL=$?
RES=$(grep -E '^RESULT' "$OUT/soak-run.log" 2>/dev/null | tail -1)

cat > "$OUT/soak-summary.txt" <<EOF
soak-p4-30m summary  ($(date '+%F %T'))
hold=${HOLD}s  out=$OUT
exit=$STILL  $RES
samples=$(grep -vc '^unix_ts' "$OUT/soak-log")
EOF
echo "soak done" >> "$OUT/soak-summary.txt"
