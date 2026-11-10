#!/bin/bash
# FTP/FTPS 夹具启动（Phase 2 Task 5）：
#   * 自签证书宿主生成（/usr/bin/openssl，缺了才生成——重启不换证书）；
#   * 明文 FTP 127.0.0.1:2121 + FTPS（显式 AUTH TLS）127.0.0.1:990；
#   * 被动数据端口段 51000-51099。
# 就绪探测：读到 FTP 220 banner 才算 ready（nc -z 假阳性同款防护不变）。
#
# 宿主进程直跑而非 Docker 容器（2026-11-11 门禁裁定，替代原容器形态）：
# pyftpdlib 的被动数据端口是瞬态监听（每 PASV 临时 bind、传完即关，测试期间
# 每秒数十次 churn）。经 OrbStack 的 Docker 端口发布（-p 范围映射，实测
# --network host 亦同）走 VM 边界动态转发：数据监听关闭后有短暂窗口宿主 SYN
# 被 RST——cargo test 并发下必现数据通道 ECONNREFUSED（服务端只应答已成功
# bind 的端口，refused 只能来自转发层，宿主 loopback 无此层）。测试只关心
# 127.0.0.1:2121/990 上有协议正确的 ftpd，不关心其进程边界。依赖版本与原
# Dockerfile 钉死一致，venv 隔离在 fixtures/ftpd/.venv（不动全局 python）。
set -euo pipefail
cd "$(dirname "$0")/../fixtures"
mkdir -p ftpd
if [ ! -f ftpd/cert.pem ] || [ ! -f ftpd/key.pem ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout ftpd/key.pem -out ftpd/cert.pem \
    -subj "/CN=ottr-ftpd-fixture" \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
fi
# 旧容器形态清理（host 网络容器会在 2121/990/510xx 与宿主进程抢端口）
docker rm -f ottr-ftpd 2>/dev/null || true
# venv 就绪（幂等；依赖钉死与原 Dockerfile 一致）
if [ ! -x ftpd/.venv/bin/python ]; then
  python3 -m venv ftpd/.venv
fi
ftpd/.venv/bin/pip install --quiet --no-input pyftpdlib==2.1.0 pyopenssl==24.3.0 \
  1>&2
# 旧宿主进程清理（pidfile 优先，入口路径兜底——pidfile 丢失时防双进程抢端口）
if [ -f ftpd/ftpd.pid ] && kill -0 "$(cat ftpd/ftpd.pid)" 2>/dev/null; then
  kill "$(cat ftpd/ftpd.pid)" 2>/dev/null || true
  sleep 1
fi
pkill -f "ftpd-entrypoint.py" 2>/dev/null || true
mkdir -p ftpd/home
FTP_HOME="$PWD/ftpd/home" \
FTP_CERT="$PWD/ftpd/cert.pem" \
FTP_KEY="$PWD/ftpd/key.pem" \
  nohup ftpd/.venv/bin/python ftpd/ftpd-entrypoint.py >> ftpd/ftpd.log 2>&1 &
echo $! > ftpd/ftpd.pid
ready=0
probe() {  # 真协议探测：读到 FTP 220 banner 才算就绪
  python3 - "$1" <<'EOF'
import socket, sys
try:
    s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), 2)
    s.settimeout(2)
    banner = s.recv(32)
    s.close()
    sys.exit(0 if banner.startswith(b"220") else 1)
except OSError:
    sys.exit(1)
EOF
}
for i in $(seq 1 60); do
  if probe 2121 && probe 990; then
    ready=1; break
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "ftpd fixture not ready after 60s (see fixtures/ftpd/ftpd.log)"; exit 1; }
echo "ready: ftp://spike@127.0.0.1:2121 (password: spike-pass), ftps explicit 127.0.0.1:990"
