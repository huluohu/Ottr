#!/usr/bin/env bash
# scripts/spike-desktop-api.sh — Task 11 (Spike #7/#8) keyring 读写 + 系统通知驱动。
#
# 取数机制（无人值守，同 task-4-report.md §5 的 T4 模式，两处环境适配见下）：
#   1. 本脚本先 `cargo build`（脚本自身 = arm64 进程链，链接正常），再后台起 vite
#      （npm run dev），最后直接运行 target/debug/ottr —— Rust setup() 检测
#      OTTR_SPIKE=keyring|notify 后把主窗口导航到 http://localhost:1420/?spike=<mode>。
#      【不再走 `npx tauri dev`】本机 /usr/local/bin/node 是 x86_64（Rosetta），
#      npm 装的 @tauri-apps/cli 也是 cli-darwin-x64：Rosetta 进程链里 `cc` shim 选中
#      x86_64 切片，而新版 CommandLineTools 的 libxcrun 只有 arm64 —— 链接必败
#      （复现：node-x64 内 execSync('cc -shared …') 必失败；bash 内同命令成功）。
#      vite 仅服务静态页面不参与链接，Rosetta 下可正常工作。
#   2. 前端自动执行并把报告 JSON POST 给 `spike_report_file` 落盘：
#      keyring 页  set→get→del→assert → /tmp/ottr-keyring.json
#      notify 页   spike_notify 调用   → /tmp/ottr-notify.json（API 层；弹窗需人工确认）
#   3. 本脚本轮询报告文件，拿到后打印并清理 vite 与 app 全家（EXIT trap 兜底）。
#
# 用法：scripts/spike-desktop-api.sh keyring|notify [等待报告超时秒数，默认 120]
# 注意：macOS 首次 keyring/通知访问可能弹系统授权框，会阻塞自动化——超时即按
# 简报裁定降级（keyring mock 单测 / 通知记人工验证项），见 task-11-report.md。
set -euo pipefail

MODE="${1:?usage: spike-desktop-api.sh keyring|notify [timeout]}"
case "$MODE" in
  keyring) REPORT=/tmp/ottr-keyring.json ;;
  notify) REPORT=/tmp/ottr-notify.json ;;
  *) echo "FAIL: mode 必须是 keyring 或 notify" >&2; exit 1 ;;
esac
DEVLOG="/tmp/ottr-tauri-dev-$MODE.log"
TIMEOUT="${2:-120}"

export PATH="$HOME/.cargo/bin:$PATH"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="$ROOT/target/debug/ottr"

# 预清理：遗留 ottr 实例会共用 :1420 的 vite 页面、往同一报告文件写数
pkill -f "$APP_BIN" 2>/dev/null || true
sleep 1
pkill -9 -f "$APP_BIN" 2>/dev/null || true

rm -f "$REPORT" "$DEVLOG"

cleanup() {
  pkill -f "$APP_BIN" 2>/dev/null || true
  lsof -ti tcp:1420 2>/dev/null | xargs kill 2>/dev/null || true
  sleep 1
  pkill -9 -f "$APP_BIN" 2>/dev/null || true
  lsof -ti tcp:1420 2>/dev/null | xargs kill -9 2>/dev/null || true
}
trap cleanup EXIT

# 1. 预构建（arm64 进程链完成链接；二进制为 dev 形态：debug 无 custom-protocol → devUrl :1420）
cd "$ROOT/src-tauri"
cargo build >>"$DEVLOG" 2>&1

# 2. vite dev server（:1420；node x64/Rosetta 仅服务页面）
cd "$ROOT"
npm run dev >>"$DEVLOG" 2>&1 &
VITE_PID=$!

echo "vite pid=$VITE_PID log=$DEVLOG mode=$MODE"
echo "waiting for dev server :1420 ..."
up=0
for _ in $(seq 1 120); do
  # vite（Node >=17）把 localhost 绑在 IPv6 ::1 上，127.0.0.1 探测不到
  if nc -z ::1 1420 2>/dev/null; then up=1; break; fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "FAIL: vite 提前退出"
    tail -40 "$DEVLOG"
    exit 1
  fi
  sleep 1
done
if [ "$up" != 1 ]; then
  echo "FAIL: dev server 120s 未就绪"
  tail -40 "$DEVLOG"
  exit 1
fi

# 3. 直接运行 app 二进制（等价于 tauri dev 的 exec 形态）
OTTR_SPIKE="$MODE" "$APP_BIN" >>"$DEVLOG" 2>&1 &
APP_PID=$!
echo "app pid=$APP_PID; waiting for report $REPORT (timeout ${TIMEOUT}s) ..."

deadline=$((SECONDS + TIMEOUT))
while [ "$SECONDS" -lt "$deadline" ]; do
  if [ -s "$REPORT" ]; then
    echo "=== REPORT ($REPORT) ==="
    cat "$REPORT"
    echo "=== END REPORT ==="
    exit 0
  fi
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "FAIL: app 退出但未产出报告"
    tail -60 "$DEVLOG"
    exit 1
  fi
  sleep 2
done

echo "FAIL: ${TIMEOUT}s 内未拿到报告（若钥匙链/通知授权框阻塞了自动化，见 task-11-report.md 降级路径）"
tail -60 "$DEVLOG"
exit 1
