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
# fail-loud（BL-212）：循环耗尽不再无条件 echo ready——那是说谎就绪，后续依赖
# known_hosts 的测试/脚本（pinned 指纹、e2e）会在更远处以更难排查的方式失败。
# 这里改为 exit 1 + 两条排查提示（docker logs / 重建脚本）。
rm -f known_hosts.tmp
ready=""
for i in $(seq 1 60); do
  if ssh-keyscan -p 2222 127.0.0.1 2>/dev/null > known_hosts.tmp && [ -s known_hosts.tmp ]; then
    ready=1
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  rm -f known_hosts.tmp
  echo "FAIL: ottr-sshd not ready within 60s (keyscan collected no host key)" >&2
  echo "  排查：docker logs ottr-sshd ；重建：scripts/spike-sshd.sh" >&2
  exit 1
fi
mv known_hosts.tmp known_hosts
echo "ready: ssh -p 2222 spike@127.0.0.1 (password: spike-pass)"
