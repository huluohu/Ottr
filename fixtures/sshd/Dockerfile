FROM debian:bookworm-slim
# 注意：Debian 无独立 iconv 包，/usr/bin/iconv 由 libc6 提供
# zsh：Task 6 spike#11 需要 zsh 注入路径验证（bash 之外的第二 shell）
RUN apt-get update && apt-get install -y openssh-server zsh curl ca-certificates && rm -rf /var/lib/apt/lists/*
# trzsz（Phase 2 Task 4，B10 下半）：真远端 trz/tsz 一轮端到端（trzsz-go 官方
# release 二进制，版本钉死保证可复现）。架构取 dpkg --print-architecture
# （amd64/arm64；TARGETARCH 在部分 builder（OrbStack classic）下不注入）。
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) TRZSZ_ARCH=x86_64 ;; \
      arm64) TRZSZ_ARCH=aarch64 ;; \
      *) echo "unsupported arch" >&2; exit 1 ;; \
    esac; \
    TRZSZ_DIR="trzsz_1.2.0_linux_${TRZSZ_ARCH}"; \
    curl -fsSL "https://github.com/trzsz/trzsz-go/releases/download/v1.2.0/trzsz_1.2.0_linux_${TRZSZ_ARCH}.tar.gz" \
      | tar xz -C /usr/local/bin --strip-components=1 "${TRZSZ_DIR}/trz" "${TRZSZ_DIR}/tsz" "${TRZSZ_DIR}/trzsz"; \
    chmod 755 /usr/local/bin/trz /usr/local/bin/tsz /usr/local/bin/trzsz
RUN mkdir -p /run/sshd /home/spike/.ssh
# spike 用户在启动脚本里创建（需要注入公钥与密码哈希）
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 2222
CMD ["/entrypoint.sh"]
