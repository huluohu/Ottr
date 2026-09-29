FROM debian:bookworm-slim
# 注意：Debian 无独立 iconv 包，/usr/bin/iconv 由 libc6 提供
# zsh：Task 6 spike#11 需要 zsh 注入路径验证（bash 之外的第二 shell）
RUN apt-get update && apt-get install -y openssh-server zsh && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /run/sshd /home/spike/.ssh
# spike 用户在启动脚本里创建（需要注入公钥与密码哈希）
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 2222
CMD ["/entrypoint.sh"]
