FROM debian:bookworm-slim
# 注意：Debian 无独立 iconv 包，/usr/bin/iconv 由 libc6 提供
# zsh：Task 6 spike#11 需要 zsh 注入路径验证（bash 之外的第二 shell）
# sudo：Phase 3 Task 6（B9）sudo 密码自动填充真夹具轮（sudo -S true 场景）
RUN apt-get update && apt-get install -y openssh-server zsh curl ca-certificates sudo && rm -rf /var/lib/apt/lists/*
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
# 只预建 /run/sshd（sshd 运行时必需）。**不预建 /home/spike***（BL-216 根因
# 修复）：镜像里 root 属主的空 home 会让 entrypoint 的 `useradd -m` 只告警不
# 建家目录、也不拷 skel 不改属主——spike 对自家 home 无写权限，login shell 的
# .profile→.bashrc 链缺失（LANG 注入无法落地），entrypoint 只能手动补齐。
# home 与 .ssh/authorized_keys 的创建全部归 entrypoint 首启路径（useradd -m +
# mkdir -p），重启路径由 entrypoint 的 mkdir -p 兜底。
RUN mkdir -p /run/sshd
# spike 用户在启动脚本里创建（需要注入公钥与密码哈希）
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 2222
CMD ["/entrypoint.sh"]
