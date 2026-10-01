#!/bin/bash
# T12 Phase 2 验收 · 稳定性维：30min 长跑驱动（2 SSH 会话[会话0 SFTP 循环] + FTP 传输循环）
#
# 用法: scripts/soak-30m.sh [hold_secs] [out_dir]
#   默认 hold=1800, out=/tmp/ottr-t12
# 采样: $out/soak-log 每 30s 一行 CSV：
#   unix_ts,elapsed_s,bench_rss_kb,ftp_rss_kb,container_mem_mb,bench_rounds,ftp_rounds,err_lines
# 汇总: $out/soak-summary.txt（两进程首末/峰值 RSS、完成轮次、错误行数）
# 依赖: target/release/ottr-bench、target/release/examples/ftp_soak、
#       夹具 ottr-sshd(2222) 与 ottr-ftpd(2121) 运行中
#
# 后台常驻启动（存活于调用方生命周期之外）:
#   nohup scripts/soak-30m.sh 1800 /tmp/ottr-t12 >/tmp/ottr-t12/soak-driver.log 2>&1 & disown
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

HOLD=${1:-1800}
OUT=${2:-/tmp/ottr-t12}
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH="$ROOT/target/release/ottr-bench"
FTPSOAK="$ROOT/target/release/examples/ftp_soak"

[ -x "$BENCH" ] || { echo "FATAL: $BENCH 不存在" >&2; exit 1; }
[ -x "$FTPSOAK" ] || { echo "FATAL: $FTPSOAK 不存在" >&2; exit 1; }
mkdir -p "$OUT"

"$BENCH" sessions 2 "$HOLD" > "$OUT/soak-bench.log" 2>&1 &
BPID=$!
"$FTPSOAK" "$HOLD" > "$OUT/soak-ftp.log" 2>&1 &
FPID=$!
T0=$(date +%s)

rss_of() { ps -o rss= -p "$1" 2>/dev/null | tr -d ' ' || true; }

BFIRST=""; FFIRST=""; BMAX=0; FMAX=0
: > "$OUT/soak-log"
echo "unix_ts,elapsed_s,bench_rss_kb,ftp_rss_kb,container_mem_mb,bench_rounds,ftp_rounds,err_lines" >> "$OUT/soak-log"

while kill -0 "$BPID" 2>/dev/null || kill -0 "$FPID" 2>/dev/null; do
  NOW=$(date +%s)
  EL=$((NOW - T0))
  B=$(rss_of "$BPID"); [ -z "$B" ] && B=0
  F=$(rss_of "$FPID"); [ -z "$F" ] && F=0
  [ -z "$BFIRST" ] && [ "$B" -gt 0 ] && BFIRST=$B
  [ -z "$FFIRST" ] && [ "$F" -gt 0 ] && FFIRST=$F
  [ "$B" -gt "$BMAX" ] && BMAX=$B
  [ "$F" -gt "$FMAX" ] && FMAX=$F
  CONT=$(docker stats --no-stream --format '{{.MemUsage}}' ottr-sshd 2>/dev/null | awk '{print $1}' || true)
  BROUNDS=$(grep -c 'sftp round done' "$OUT/soak-bench.log" 2>/dev/null || echo 0)
  FROUNDS=$(grep -c 'ftp-soak] round .* done' "$OUT/soak-ftp.log" 2>/dev/null || echo 0)
  # 错误行：排除 RESULT 汇总行本身（其 errors=0 字样会被子串误计，Phase 1 教训）
  ERRS=$(cat "$OUT/soak-bench.log" "$OUT/soak-ftp.log" 2>/dev/null | grep -viE '^RESULT' | grep -ciE 'error|fail|panic' || true)
  echo "$NOW,$EL,$B,$F,$CONT,$BROUNDS,$FROUNDS,$ERRS" >> "$OUT/soak-log"
  sleep 30
done

wait "$BPID" 2>/dev/null; BSTILL=$?
wait "$FPID" 2>/dev/null; FSTILL=$?
BRES=$(grep -E '^RESULT' "$OUT/soak-bench.log" 2>/dev/null | tail -1)
FRES=$(grep -E '^RESULT' "$OUT/soak-ftp.log" 2>/dev/null | tail -1)

cat > "$OUT/soak-summary.txt" <<EOF
soak-30m summary  ($(date '+%F %T'))
hold=${HOLD}s  out=$OUT
bench:   first=${BFIRST:-0}KB max=${BMAX}KB last_seen=$(grep -v '^unix_ts' "$OUT/soak-log" | tail -1 | cut -d, -f3)KB  exit=$BSTILL  $BRES
ftp:     first=${FFIRST:-0}KB max=${FMAX}KB last_seen=$(grep -v '^unix_ts' "$OUT/soak-log" | tail -1 | cut -d, -f4)KB  exit=$FSTILL  $FRES
samples=$(grep -vc '^unix_ts' "$OUT/soak-log")
EOF
echo "soak done" >> "$OUT/soak-summary.txt"
