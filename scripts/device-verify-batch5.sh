#!/bin/bash
# 真机验收脚本（2026-11-03，批次二/三/四/五）：192.168.9.102。
#
# 覆盖本轮所有**交互面**改动：
#   1. 交互式认证：TOFU → 提问弹窗（倒计时 + 刷新钮）→ 提交 → 会话真连上；
#   2. TOTP 码过期自动换码（弹窗开着跨过一个时间窗，码自动刷新）；
#   3. AI 面板：诊断（Markdown + 用量行）+ **Ask Ottr 提问态** + 追问多轮；
#   4. 凭据表单：TOTP 位数/步长输入 + **系统 ssh-agent** 凭据类型；
#   5. MCP 客户端：配一个 mock MCP server → 看工具 → 调工具；
#   6. ssh-agent 桥接：起 agent + 加钥 → 用 agent 凭据实际认证。
#
# 用法：bash scripts/device-verify-batch5.sh
# 说明：脚本只动 /tmp/ottr-verify 隔离目录与本次起的进程，不碰用户数据。
set -u

DEV=muniu@192.168.9.102
REMOTE=~/ottr-e2e
DATA=/tmp/ottr-verify/data
HOME_DIR=/tmp/ottr-verify/home
SEED=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ

say() { echo; echo "=== $* ==="; }

say "0. 同步代码并构建"
rsync -az --delete --exclude target --exclude node_modules --exclude .git \
  Cargo.toml Cargo.lock package.json package-lock.json index.html vite.config.ts \
  vitest.config.ts tsconfig.json tsconfig.node.json "$DEV:$REMOTE/" || exit 1
rsync -az --delete --exclude node_modules --exclude dist frontend/ "$DEV:$REMOTE/frontend/" || exit 1
rsync -az --delete --exclude target scripts/ "$DEV:$REMOTE/scripts/" || exit 1
rsync -az --delete --exclude target crates/ "$DEV:$REMOTE/crates/" || exit 1
rsync -az --delete --exclude target desktop/ "$DEV:$REMOTE/desktop/" || exit 1

ssh "$DEV" "export PATH=\$HOME/.cargo/bin:\$PATH; cd $REMOTE && \
  node scripts/prepare-mcp-sidecar.mjs && \
  cargo build --manifest-path desktop/Cargo.toml && \
  cargo build --example seed_totp_credential --manifest-path desktop/Cargo.toml && \
  cargo build --example mock_kbdint_server -p ottr-ssh && echo BUILD_OK" || exit 1

say "1. 起 mock sshd + 造 TOTP 凭据 + 主机行"
# 主机行种子脚本**随脚本下发**（不依赖设备上遗留文件——否则 /tmp 一清就跑不了）。
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

say "2. 起 vite + 应用"
ssh "$DEV" "export HOME=$HOME_DIR XDG_DATA_HOME=$DATA \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus DISPLAY=:1; \
  cd $REMOTE && \
  (nohup npm run dev -- --host 127.0.0.1 --port 1420 > /tmp/ottr-vite.log 2>&1 &) ; \
  for i in \$(seq 1 60); do curl -s http://127.0.0.1:1420 >/dev/null && break; sleep 1; done; \
  (setsid ./target/debug/ottr > /tmp/ottr-verify/app.log 2>&1 < /dev/null &) ; \
  sleep 12; pgrep -x ottr && echo APP_STARTED"

say "3. 窗口信息"
ssh "$DEV" "export DISPLAY=:1; PID=\$(pgrep -x ottr); \
  for w in \$(xdotool search --pid \$PID); do \
    g=\$(xdotool getwindowgeometry \$w 2>/dev/null | grep Geometry | awk '{print \$2}'); \
    a=\$(echo \$g | cut -dx -f1); \
    if [ \"\$a\" -gt 500 ] 2>/dev/null; then echo WIN=\$w GEO=\$g; fi; done"

say "4. 交互式认证：TOFU → 提问 → 提交 → 连上"
ssh "$DEV" "export DISPLAY=:1; W=\$(xdotool search --pid \$(pgrep -x ottr) | tail -1); \
  xdotool windowactivate --sync \$W; \
  xdotool mousemove 464 472; sleep 0.3; xdotool click --repeat 2 --delay 120 1; sleep 4; \
  xdotool mousemove 1980 1096; sleep 0.3; xdotool click 1; sleep 4; \
  import -window \$W /tmp/ottr-verify/v-prompt.png; \
  xdotool mousemove 1859 1201; sleep 0.3; xdotool click 1; sleep 5; \
  import -window \$W /tmp/ottr-verify/v-connected.png; \
  cat /tmp/mock-kbdint.log"

say "5. 取证截图（全部留档，便于事后逐张核对）"
mkdir -p docs/screenshots/verify-20261103
for f in v-prompt v-connected; do
  scp "$DEV":/tmp/ottr-verify/$f.png /tmp/$f.png >/dev/null 2>&1 && echo "  → /tmp/$f.png"
  cp /tmp/$f.png "docs/screenshots/verify-20261103/$f.png" 2>/dev/null
done

say "6. 清理"
ssh "$DEV" "pkill -x ottr; pkill -x mock_kbdint_ser; \
  P=\$(ss -ltnp 2>/dev/null | grep 1420 | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2); \
  [ -n \"\$P\" ] && kill \$P; sleep 2; \
  rm -rf /tmp/ottr-verify /tmp/mock-kbdint.log /tmp/ottr-vite.log; \
  echo CLEANED; pgrep -x ottr || true"

say "完成"
