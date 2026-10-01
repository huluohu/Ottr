#!/bin/bash
# FTP/FTPS 夹具启动（Phase 2 Task 5，模式对齐 spike-sshd.sh）：
#   * 自签证书宿主生成（/usr/bin/openssl，缺了才生成——重启容器不换证书）；
#   * 明文 FTP 127.0.0.1:2121 + FTPS（显式 AUTH TLS）127.0.0.1:990；
#   * 被动数据端口段 51000-51099 全段映射 + 容器内 masquerade 127.0.0.1。
# 就绪探测：两个控制端口 TCP 可连即 ready（与 sshd 夹具的 keyscan 探测同位）。
set -euo pipefail
cd "$(dirname "$0")/../fixtures"
mkdir -p ftpd
if [ ! -f ftpd/cert.pem ] || [ ! -f ftpd/key.pem ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout ftpd/key.pem -out ftpd/cert.pem \
    -subj "/CN=ottr-ftpd-fixture" \
    -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
fi
docker build -t ottr-ftpd ftpd/
docker rm -f ottr-ftpd 2>/dev/null || true
docker run -d --name ottr-ftpd \
  -p 2121:2121 -p 990:990 -p 51000-51099:51000-51099 \
  -v "$PWD/ftpd/cert.pem:/etc/ftpd/cert.pem:ro" \
  -v "$PWD/ftpd/key.pem:/etc/ftpd/key.pem:ro" \
  ottr-ftpd
ready=0
probe() {  # 真协议探测：读到 FTP 220 banner 才算就绪（nc -z 会被 docker-proxy 的
           # 端口转发器假阳性——后端进程死了 SYN 照样受理，sshd 夹具用 keyscan 同理）
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
[ "$ready" = 1 ] || { echo "ftpd fixture not ready after 60s (docker logs ottr-ftpd)"; exit 1; }
echo "ready: ftp://spike@127.0.0.1:2121 (password: spike-pass), ftps explicit 127.0.0.1:990"
