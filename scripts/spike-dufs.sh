#!/bin/bash
# WebDAV 夹具启动（Phase 5 Task 2，spike-sshd.sh 同纪律）：dufs 容器
# （fixtures/dufs/Dockerfile，v0.46.0 摘要钉版）供 frontend/sync/webdav.dufs.test.ts
# 端到端 roundtrip。凭据钉死 user:pass（测试常量对齐）。
#
# --enable-cors 仅为测试夹具使能（webview 直连 fetch 的手工调试/dev 场景要
# Access-Control-Allow-Origin）；生产同步网络路径不经 webview fetch——跨源
# 缺口已由 Rust HTTP 代理 sync_http_fetch（desktop commands/sync_http.rs，
# product-ready T4 / BL-524 清偿）收口，代理侧按端点白名单放行、无 CORS 概念。
set -euo pipefail
cd "$(dirname "$0")/../fixtures"

docker build --quiet -t ottr-dufs dufs/
docker rm -f ottr-dufs 2>/dev/null || true
# 数据目录：临时卷（容器生命周期内持久；脚本重跑即换新，测试文件名按轮随机化不依赖旧态）
DUFS_DATA="$(mktemp -d /tmp/ottr-dufs-data-XXXX)"
docker run -d --name ottr-dufs -p 15773:5000 \
  -v "$DUFS_DATA:/data" ottr-dufs \
  /data -b 0.0.0.0 -a "user:pass@/:rw" --allow-upload --allow-delete --enable-cors

# 等就绪（未授权探针 401 = 服务活了；最多 30s）
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:15773/ 2>/dev/null || true)
  [ "$code" = "401" ] && break
  sleep 1
done
[ "$code" = "401" ] || { echo "dufs fixture failed to start (last status: ${code:-none})"; docker logs ottr-dufs | tail -5; exit 1; }
echo "ready: WebDAV http://127.0.0.1:15773 (Basic user:pass, data dir $DUFS_DATA)"
