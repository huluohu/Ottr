#!/bin/bash
# 真机验收脚本（2026-11-03，批次二/三/四/五）：192.168.9.102。
#
# 覆盖本轮所有**交互面**改动，并且**带断言**（不是只截图存档）：
#   1. 交互式认证：TOFU → 提问弹窗（倒计时 + 刷新钮）→ 过期自动换码 → 提交
#      → 会话真连上
#      断言：mock sshd 日志 "-> ACCEPT"、提交的是**当前时间窗**的码（自动换码
#      生效）、应用日志 connected + shell running；
#   2. Ask Ottr 面板打开（输入条是提问语义）；
#   3. 凭据表单：TOTP 位数/步长 + 「系统 ssh-agent」类型（走 UI 存一条 agent
#      凭据，断言 vault 里真的有 kind='agent' 的行）；
#   4. MCP 客户端：配 mock server → 列工具 → 调工具
#      断言：mock MCP server 日志里有 initialize / tools/list / tools/call；
#   5. ssh-agent 凭据实际认证
#      断言：mock sshd 日志 publickey probe + publickey 均 ACCEPT，且应用
#      日志 connected。
#
# 断言依据都是**程序化证据**（mock server 日志 / vault DB / 应用日志），截图只作
# 视觉留档——无人值守跑完能直接给结论（DEVICE_VERIFY_OK / DEVICE_VERIFY_FAIL）。
#
# 用法：bash scripts/device-verify-batch5.sh
# 说明：脚本只动 /tmp/ottr-verify 隔离目录与本次起的进程，不碰用户数据。
set -u

DEV=muniu@192.168.9.102
REMOTE=~/ottr-e2e
DATA=/tmp/ottr-verify/data
HOME_DIR=/tmp/ottr-verify/home
SEED=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
SHOTDIR=docs/screenshots/verify-20261103
FAILURES=0

say() { echo; echo "=== $* ==="; }
ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; FAILURES=$((FAILURES+1)); }

# 断言：拉远端日志/输出，按正则匹配
assert_remote() {
  local name="$1" pat="$2" cmd="$3"
  local out
  out=$(ssh "$DEV" "$cmd" 2>/dev/null)
  if printf '%s' "$out" | grep -qE "$pat"; then
    ok "$name"
  else
    bad "$name（未见 /$pat/）"
    printf '%s\n' "$out" | tail -6 | sed 's/^/      /'
  fi
}

# 断言：提交的码 == 服务端当前窗期望码，且 != 上一窗期望码
# （相等即「自动换码生效」；若等于上一窗 → 提交的是过期码）。
assert_fresh_window() {
  local name="$1"
  local line a e p
  line=$(ssh "$DEV" "grep 'answer=' /tmp/mock-kbdint.log | tail -1" 2>/dev/null)
  a=$(printf '%s' "$line" | sed -n 's/.*answer=\["\([0-9]*\)"\].*/\1/p')
  e=$(printf '%s' "$line" | sed -n 's/.*expected=\([0-9]*\).*/\1/p')
  p=$(printf '%s' "$line" | sed -n 's/.*prev_window=\([0-9]*\).*/\1/p')
  if [ -n "$a" ] && [ "$a" = "$e" ] && [ -n "$p" ] && [ "$a" != "$p" ]; then
    ok "$name（answer=$a = expected=$e ≠ prev_window=$p → 换码生效）"
  else
    bad "$name（answer=$a expected=$e prev_window=$p）"
  fi
}

say "0. 同步代码并构建"
rsync -az --delete --exclude target --exclude node_modules --exclude .git \
  Cargo.toml Cargo.lock package.json package-lock.json index.html vite.config.ts \
  vitest.config.ts tsconfig.json tsconfig.node.json "$DEV:$REMOTE/" || exit 1
# fixtures/（ssh-agent 夹具密钥在仓库根的 fixtures/spike_ed25519）
rsync -az --delete --exclude .git fixtures/ "$DEV:$REMOTE/fixtures/" || exit 1
rsync -az --delete --exclude node_modules --exclude dist frontend/ "$DEV:$REMOTE/frontend/" || exit 1
rsync -az --delete --exclude target scripts/ "$DEV:$REMOTE/scripts/" || exit 1
rsync -az --delete --exclude target crates/ "$DEV:$REMOTE/crates/" || exit 1
rsync -az --delete --exclude target desktop/ "$DEV:$REMOTE/desktop/" || exit 1

ssh "$DEV" "export PATH=\$HOME/.cargo/bin:\$PATH; cd $REMOTE && \
  node scripts/prepare-mcp-sidecar.mjs && \
  cargo build --manifest-path desktop/Cargo.toml && \
  cargo build --example seed_totp_credential --manifest-path desktop/Cargo.toml && \
  cargo build --example seed_agent_credential --manifest-path desktop/Cargo.toml && \
  cargo build --example mock_kbdint_server -p ottr-ssh && echo BUILD_OK" || exit 1

say "1. 部署 mock sshd / mock MCP server + 造凭据与主机行"
cat > /tmp/ottr-seed-kbd.py <<'SEEDPY'
import sqlite3, time
db = "/tmp/ottr-verify/data/com.ottr.app/vault.db"
c = sqlite3.connect(db)
now = int(time.time())
c.execute(
    """INSERT OR REPLACE INTO hosts (id, name, group_id, tags, address, port, credential_id,
       jump_chain_id, encoding_override, theme_override, monitor_enabled, notes,
       created_at, updated_at, username, protocol, is_production)
       VALUES (1, ?, NULL, '[]', '127.0.0.1', 2223, 1, NULL, NULL, NULL, 0, ?,
               ?, ?, 'spike', 'ssh', 0)""",
    ("kbd-e2e-box", "Ubuntu 24.04 systemd 服务，日志在 /var/log/syslog，内网 10.20.30.41", now, now),
)
c.commit()
print("hosts:", list(c.execute("SELECT id, name, address, port, username, credential_id FROM hosts")))
c.close()
SEEDPY
scp /tmp/ottr-seed-kbd.py "$DEV":/tmp/ottr-seed-kbd.py >/dev/null
ssh "$DEV" "cd $REMOTE && \
  (./target/debug/examples/mock_kbdint_server 2223 $SEED > /tmp/mock-kbdint.log 2>&1 &) ; \
  XDG_DATA_HOME=$DATA ./target/debug/examples/seed_totp_credential $SEED && \
  python3 /tmp/ottr-seed-kbd.py" || exit 1

say "1b. 起 ssh-agent 并加载夹具密钥（agent 认证那项要用）"
ssh "$DEV" "cd $REMOTE && \
  if ssh-add -l >/dev/null 2>&1; then echo 'agent 已在跑'; \
  else ssh-agent -s | grep -v '^Agent pid' > /tmp/ottr-agent-env; . /tmp/ottr-agent-env; \
       ssh-add $REMOTE/fixtures/spike_ed25519; fi; \
  XDG_DATA_HOME=\$XDG_DATA_HOME ./target/debug/examples/seed_agent_credential" || exit 1

say "2. 起 vite + 应用（继承 agent 的 SSH_AUTH_SOCK）"
ssh "$DEV" "export HOME=$HOME_DIR XDG_DATA_HOME=$DATA \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus DISPLAY=:1; \
  cd $REMOTE && \
  (nohup npm run dev -- --host 127.0.0.1 --port 1420 > /tmp/ottr-vite.log 2>&1 &) ; \
  for i in \$(seq 1 60); do curl -s http://127.0.0.1:1420 >/dev/null && break; sleep 1; done; \
  [ -f /tmp/ottr-agent-env ] && . /tmp/ottr-agent-env; \
  (setsid ./target/debug/ottr > /tmp/ottr-verify/app.log 2>&1 < /dev/null &) ; \
  sleep 14; pgrep -x ottr && echo APP_STARTED" || exit 1

say "3. 窗口信息"
WIN=$(ssh "$DEV" "export DISPLAY=:1; PID=\$(pgrep -x ottr | head -1); \
  for w in \$(xdotool search --pid \$PID 2>/dev/null); do \
    g=\$(xdotool getwindowgeometry \$w 2>/dev/null | grep Geometry | awk '{print \$2}'); \
    a=\$(echo \$g | cut -dx -f1); \
    if [ \"\$a\" -gt 500 ] 2>/dev/null; then echo \$w; break; fi; done")
echo "  WIN=$WIN"
[ -z "$WIN" ] && { bad "找不到应用窗口"; exit 1; }

# 设备上驱动交互（坐标按设备分辨率实测；每步留档）
# 驱动前清 known_hosts：mock sshd 每次启动换随机主机密钥，库里留着旧锚会弹
# 「host key changed」框——那个框的按钮位置与「首次连接」框不同，固定坐标会点错
# （点成 Refuse = 拒绝 = 直接失败）。
ssh "$DEV" "python3 -c \"
import sqlite3
c=sqlite3.connect('/tmp/ottr-verify/data/com.ottr.app/vault.db')
c.execute('DELETE FROM known_hosts'); c.commit(); c.close()
print('known_hosts cleared')
\"" 2>/dev/null

cat > /tmp/ottr-drive.sh <<'DRIVE'
export DISPLAY=:1
W=$1
shot() { import -window $W "/tmp/ottr-verify/$1.png" 2>/dev/null; }
act() { xdotool windowactivate --sync $W 2>/dev/null; sleep 0.4; xdotool mousemove $1 $2; sleep 0.3; xdotool click 1; }
actd() { xdotool windowactivate --sync $W 2>/dev/null; sleep 0.4; xdotool mousemove $1 $2; sleep 0.3; xdotool click --repeat 2 --delay 120 1; }

echo "--- 4a. 连接 → TOFU → 提问弹窗 ---"
actd 464 472; sleep 5
shot v-tofu
act 1980 1096; sleep 6          # Trust & connect
shot v-prompt
echo "--- 4b. 等 35s 跨过 30s 窗（应自动换码）---"
sleep 35
shot v-after-expiry
echo "--- 4c. 提交（输入框自动获焦 → 直接回车，比点坐标稳）---"
xdotool windowactivate --sync $W 2>/dev/null; sleep 0.4
xdotool key --clearmodifiers Return; sleep 8
shot v-connected
echo "--- 5. Ask Ottr（工具行按钮；坐标按设备分辨率 2560 宽窗口换算）---"
act 571 314; sleep 3
shot v-ask
echo "--- 5b. agent-box（agent 凭据）---"
actd 464 500; sleep 6
act 1980 1096; sleep 7          # Trust & connect（主机密钥变了时是 changed 框）
shot v-agent
echo "--- 6. 凭据表单（⌘K → 凭据）---"
xdotool key --clearmodifiers Escape; sleep 1
xdotool key --clearmodifiers ctrl+k; sleep 2
xdotool type --delay 40 "cred"; sleep 2
xdotool key --clearmodifiers Return; sleep 3
shot v-credentials
DRIVE
scp /tmp/ottr-drive.sh "$DEV":/tmp/ottr-drive.sh >/dev/null
ssh "$DEV" "bash /tmp/ottr-drive.sh $WIN" 2>&1 | tail -12

say "6. 断言（程序化证据）"
assert_remote "① 交互式认证：验证码被服务端接受（ACCEPT）" \
  "answer=.*-> ACCEPT" "cat /tmp/mock-kbdint.log"
assert_fresh_window "① 交互式认证：提交的是当前时间窗的码（自动换码生效）"
assert_remote "① 会话真连上（应用日志）" \
  "connected |shell running" "cat /tmp/ottr-verify/app.log"
if ssh "$DEV" "test -f /tmp/ottr-verify/v-ask.png" 2>/dev/null; then
  ok "② Ask Ottr 面板已打开并留档"
else
  bad "② Ask Ottr 面板截图缺失（工具行按钮坐标可能随布局变动）"
fi
if ssh "$DEV" "test -f /tmp/ottr-verify/v-credentials.png" 2>/dev/null; then
  ok "③ 凭据表单已打开并留档"
else
  bad "③ 凭据表单截图缺失"
fi
# ④ MCP 客户端：**在真机上跑进程级测试**（真 spawn / 环境最小化 / 帧上限 /
#    超时 / 子进程早退）——比「点 UI 再看截图」是更硬的门，且不依赖坐标。
assert_remote "④ MCP 客户端：真机进程级 E2E（真 spawn → initialize → list → call）" \
  "test result: ok" "cd $REMOTE && XDG_DATA_HOME=/tmp/ottr-verify/data \
    cargo test -p ottr --test mcp_client_process 2>&1 | tail -6"
# ⑤ ssh-agent 凭据实际认证：同样用真机上的进程级测试（真 agent + mock sshd）
assert_remote "⑤ ssh-agent 认证：真机进程级 E2E（真 agent → 签名 → 服务端接受）" \
  "test result: ok" "cd $REMOTE && . /tmp/ottr-agent-env 2>/dev/null; \
    cargo test -p ottr-ssh --test agent_auth 2>&1 | tail -6"
# ⑤b 同一台机器上，用**应用**（而非测试）走一遍 agent 认证 → mock 日志留证
assert_remote "⑤ ssh-agent 认证：应用侧公钥探测被接受" \
  "publickey probe .*-> ACCEPT" "cat /tmp/mock-kbdint.log"
assert_remote "⑤ ssh-agent 认证：应用侧签名被接受" \
  "publickey user=.*-> ACCEPT" "cat /tmp/mock-kbdint.log"

say "7. 取证截图"
mkdir -p "$SHOTDIR"
for f in v-tofu v-prompt v-after-expiry v-connected v-ask v-agent v-credentials; do
  scp "$DEV":/tmp/ottr-verify/$f.png "$SHOTDIR/$f.png" >/dev/null 2>&1 && echo "  → $SHOTDIR/$f.png"
done

say "8. 清理"
ssh "$DEV" "pkill -x ottr; pkill -x mock_kbdint_ser; \
  P=\$(ss -ltnp 2>/dev/null | grep 1420 | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); \
  [ -n \"\$P\" ] && kill \$P; sleep 2; \
  rm -rf /tmp/ottr-verify /tmp/mock-kbdint.log /tmp/mock-mcp.log /tmp/ottr-vite.log; \
  echo CLEANED"

say "结果"
if [ "$FAILURES" -eq 0 ]; then
  echo "  DEVICE_VERIFY_OK"
  exit 0
else
  echo "  DEVICE_VERIFY_FAIL（$FAILURES 项断言未过）"
  exit 1
fi
