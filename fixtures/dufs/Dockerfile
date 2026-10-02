# WebDAV 夹具（Phase 5 Task 2）：dufs 单二进制 WebDAV 服务器（同步通道端到端）。
# 版本钉死保证可复现（与 sshd/ftpd 夹具同纪律）：dufs v0.46.0，按镜像摘要
# 固定（:latest 浮动标签不可复现；摘要与 docker.io/sigoden/dufs 官方发布对账）。
# 认证与写权限由 scripts/spike-dufs.sh 的命令行给出（-a "user:pass@/:rw" +
# --allow-upload/--allow-delete，0.46 的 auth 规则必须带路径段）。
FROM sigoden/dufs@sha256:8dd3b750015734703e64b55641fb7d2254c112e0ff3967074766177dc15dc982

# 15773 经 docker run -p 映射宿主；数据目录由运行时挂载（宿主 mktemp）。
EXPOSE 5000
