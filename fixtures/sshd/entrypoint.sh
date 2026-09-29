#!/bin/bash
set -e
useradd -m -s /bin/bash spike
echo "spike:spike-pass" | chpasswd
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
