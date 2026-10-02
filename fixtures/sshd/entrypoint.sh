#!/bin/bash
set -e
# T17 幂等化：docker stop/start 复用容器时 entrypoint 会重跑——各步骤加守卫，
# 保证「首建」与「重启」语义一致（T17 稳定性维 5 轮 stop/start 复测的前提）。
useradd -m -s /bin/bash spike 2>/dev/null || true
echo "spike:spike-pass" | chpasswd
# 镜像里 Dockerfile 预建了 root 属主的空 /home/spike → useradd -m 只告警：
# 不拷 skel、不改属主。spike 对自家 home 无写权限且 login shell 的
# .profile→.bashrc 链缺失（LANG 注入无法落地），这里手动补齐。注意顺序：
# `cp -a skel/. dst` 会把 skel 目录自身属性（root:root 755）套到 dst 上，
# 必须先 cp 后 chown -R（home 与 skel 文件一并归 spike，注入才能追加写）。
cp -a /etc/skel/. /home/spike/
chown -R spike:spike /home/spike
# 公钥由启动脚本以 -e PUBKEY 注入（不用 /run/secrets）；幂等：整行去重
touch /home/spike/.ssh/authorized_keys
grep -qxF "$PUBKEY" /home/spike/.ssh/authorized_keys || echo "$PUBKEY" >> /home/spike/.ssh/authorized_keys
chmod 600 /home/spike/.ssh/authorized_keys && chown -R spike:spike /home/spike/.ssh
# GBK 输出命令：UTF-8 文本转 GBK 裸字节
printf '#!/bin/bash\nprintf "中文测试 GBK 输出" | iconv -f UTF-8 -t GBK\n' > /usr/local/bin/gbk-echo
chmod +x /usr/local/bin/gbk-echo
# 预生成 100MB 测试文件（重启时跳过——已存在且属主/大小不变）
if [ ! -f /tmp/big100 ] || [ "$(stat -c%s /tmp/big100)" != "104857600" ]; then
  dd if=/dev/urandom of=/tmp/big100 bs=1048576 count=100 2>/dev/null
fi
# 允许实验性端口转发与多会话（幂等：重复追加会撑爆 config，先判重）
sed -i 's/#AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config
grep -q '^PermitUserEnvironment yes' /etc/ssh/sshd_config || echo "PermitUserEnvironment yes" >> /etc/ssh/sshd_config
# B9（Phase 3 Task 6）：spike 带**密码** sudo（非 NOPASSWD——自动填充场景要的
# 就是「提示出现 → 填 spike-pass」的完整链路；NOPASSWD 不出提示、测不了检测）。
# 幂等：sudoers.d 独立文件 + 固定内容，重跑覆盖自身。
printf 'spike ALL=(ALL:ALL) ALL\n' > /etc/sudoers.d/spike
chmod 440 /etc/sudoers.d/spike
# 固定主机密钥（挂载自 hostkeys/，保证 known_hosts 稳定）
/usr/sbin/sshd -D -e -p 2222 -h /etc/ssh/hostkeys/ssh_host_ed25519_key
