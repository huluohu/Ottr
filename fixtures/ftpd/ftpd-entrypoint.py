#!/usr/bin/env python3
"""ottr FTP/FTPS 夹具服务器（Phase 2 Task 5，镜像 spike-sshd entrypoint 职责）。

一个进程两个端口：
  * 2121        明文 FTP（用户 spike / spike-pass，home=/home/spike 可写）；
  * 990         FTPS 显式（RFC 4217 AUTH TLS + PBSZ/PROT，控制与数据通道都强制 TLS）。

被动模式：数据端口段固定 51000-51099（docker -p 全段映射），PASV 回包地址用
masquerade_address（默认 127.0.0.1——客户端从宿主经端口映射连入，容器内网
地址不可达；suppaftp 侧另有 nat_workaround 兜底，双保险）。

幂等：docker stop/start 重跑本脚本无状态依赖（无落盘身份，证书由宿主挂载）。
"""
import logging
import os

from pyftpdlib import ioloop
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler, TLS_FTPHandler
from pyftpdlib.servers import FTPServer

USER = os.environ.get("FTP_USER", "spike")
PASSWORD = os.environ.get("FTP_PASS", "spike-pass")
HOME = "/home/spike"
PASV_RANGE = (51000, 51099)
PASV_ADDRESS = os.environ.get("PASV_ADDRESS", "127.0.0.1")
CERT = "/etc/ftpd/cert.pem"
KEY = "/etc/ftpd/key.pem"


def base_handler(cls) -> type:
    """明文/FTP 两 handler 的公共配置（同一用户、同一被动段、同限流）。"""
    authorizer = DummyAuthorizer()
    # perm: e=list,l=RETR,r=STOR,a=APPE,d=DELE,f=RNFR/RNTO,m=MKD,w=STOR覆盖,
    #       M=SITE CHMOD,T=SITE CHMOD——FilePanel 全操作面 + 续传（APPE/REST）所需
    authorizer.add_user(USER, PASSWORD, HOME, perm="elradfmwMT")
    cls.authorizer = authorizer
    cls.passive_ports = list(range(PASV_RANGE[0], PASV_RANGE[1] + 1))
    cls.masquerade_address = PASV_ADDRESS
    cls.banner = "ottr-ftpd fixture ready"
    # 集成测试并发连接（传输 + 面板操作）不被默认限流掐断
    cls.max_cons = 64
    cls.max_cons_per_ip = 64
    cls.timeout = None
    return cls


def main() -> None:
    logging.basicConfig(level=logging.WARNING)  # 夹具日志降噪（docker logs 可查）
    os.makedirs(HOME, exist_ok=True)

    plain = base_handler(FTPHandler)

    tls = base_handler(TLS_FTPHandler)
    # pyftpdlib 2.x：certfile/keyfile 为类属性，get_ssl_context() 由握手路径
    # 按这两个属性惰性构建 SSL.Context
    tls.certfile = CERT
    tls.keyfile = KEY
    # 控制/数据通道都强制 TLS：测的就是 FTPS 全加密路径（AUTH TLS 明文通道拒绝）
    tls.tls_control_required = True
    tls.tls_data_required = True

    FTPServer(("0.0.0.0", 2121), plain)
    FTPServer(("0.0.0.0", 990), tls)
    # 两个 server 共享模块级 ioloop 单例：先全部注册监听 socket，再进一次事件
    # 循环（pyftpdlib 2.x：ioloop.IOLoop；serve_forever 只支持单 server 主循环）。
    ioloop.IOLoop.instance().loop()


if __name__ == "__main__":
    main()
