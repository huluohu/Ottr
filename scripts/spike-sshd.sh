#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../fixtures"
[ -f spike_ed25519 ] || ssh-keygen -t ed25519 -N "" -f spike_ed25519 -C spike
mkdir -p hostkeys
[ -f hostkeys/ssh_host_ed25519_key ] || ssh-keygen -t ed25519 -N "" -f hostkeys/ssh_host_ed25519_key
docker build -t ottr-sshd sshd/
docker rm -f ottr-sshd 2>/dev/null || true
docker run -d --name ottr-sshd -p 2222:2222 \
  -v "$PWD/hostkeys:/etc/ssh/hostkeys" \
  -e PUBKEY="$(cat spike_ed25519.pub)" ottr-sshd
# 等 sshd 就绪并以 keyscan 采集主机密钥（容器内 entrypoint 需先建用户/生成 big100），最多 60s
rm -f known_hosts.tmp
for i in $(seq 1 60); do
  ssh-keyscan -p 2222 127.0.0.1 2>/dev/null > known_hosts.tmp && [ -s known_hosts.tmp ] && break
  sleep 1
done
mv known_hosts.tmp known_hosts 2>/dev/null || true
echo "ready: ssh -p 2222 spike@127.0.0.1 (password: spike-pass)"
