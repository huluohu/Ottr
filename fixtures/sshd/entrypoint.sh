#!/bin/bash
set -e
useradd -m -s /bin/bash spike
echo "spike:spike-pass" | chpasswd
# 镜像里 Dockerfile 预建了 root 属主的空 /home/spike → useradd -m 只告警：
# 不拷 skel、不改属主。spike 对自家 home 无写权限且 login shell 的
# .profile→.bashrc 链缺失（LANG 注入无法落地），这里手动补齐。注意顺序：
# `cp -a skel/. dst` 会把 skel 目录自身属性（root:root 755）套到 dst 上，
# 必须先 cp 后 chown -R（home 与 skel 文件一并归 spike，注入才能追加写）。
cp -a /etc/skel/. /home/spike/
chown -R spike:spike /home/spike
# 公钥由启动脚本以 -e PUBKEY 注入（不用 /run/secrets）
echo "$PUBKEY" >> /home/spike/.ssh/authorized_keys
chmod 600 /home/spike/.ssh/authorized_keys && chown -R spike:spike /home/spike/.ssh
# GBK 输出命令：UTF-8 文本转 GBK 裸字节
printf '#!/bin/bash\nprintf "中文测试 GBK 输出" | iconv -f UTF-8 -t GBK\n' > /usr/local/bin/gbk-echo
chmod +x /usr/local/bin/gbk-echo
# 预生成 100MB 测试文件
dd if=/dev/urandom of=/tmp/big100 bs=1048576 count=100 2>/dev/null
# 允许实验性端口转发与多会话
sed -i 's/#AllowTcpForwarding.*/AllowTcpForwarding yes/' /etc/ssh/sshd_config
echo "PermitUserEnvironment yes" >> /etc/ssh/sshd_config
# 固定主机密钥（挂载自 hostkeys/，保证 known_hosts 稳定）
/usr/sbin/sshd -D -e -p 2222 -h /etc/ssh/hostkeys/ssh_host_ed25519_key
