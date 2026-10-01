FROM python:3.12-slim
# FTP/FTPS 夹具（Phase 2 Task 5）：pyftpdlib（纯 python FTP 服务器，支持
# MLSD/REST/SIZE/SITE CHMOD 与显式 FTPS——RFC 4217 AUTH TLS，需 pyopenssl）。
# 版本钉死保证可复现（与 sshd 夹具同纪律）；隐式 FTPS 服务器端 pyftpdlib
# 不支持——隐式路径的验证缺口见 task-5-report（客户端支持、夹具只测显式）。
RUN pip install --no-cache-dir pyftpdlib==2.1.0 pyopenssl==24.3.0
COPY ftpd-entrypoint.py /ftpd-entrypoint.py
RUN chmod +x /ftpd-entrypoint.py
# 2121 = 明文 FTP；990 = FTPS（显式 AUTH TLS）；51000-51099 = 被动模式数据端口段
# （宿主端口映射 + masquerade_address=127.0.0.1，见 scripts/spike-ftpd.sh）。
EXPOSE 2121 990 51000-51099
CMD ["python3", "/ftpd-entrypoint.py"]
