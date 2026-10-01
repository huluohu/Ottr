-- 0011_session_summaries（Phase 2 Task 7，B1 会话纪要）：
-- 会话断开时由前端异步生成「本会话做了什么」的 AI 单轮摘要，落本表（⌘R
-- 面板「纪要」页签消费）。数据源 = history 表同 session_id 的命令序列，摘要
-- 内容含命令面（潜在敏感）→ **密文面**：summary_enc 走 AES-256-GCM 密封
-- （AAD = "session_summaries:{id}:summary"，唯一构造点 crate::aad），已登记
-- store.rs scan_registry（主密码升级重密封扫描覆盖，守卫测试
-- password_mode_test::reencrypt_scan_covers_all_enc_columns 动态比对）。
-- 锁定语义与 secrets 相同（Vault::cipher() 锁定即拒）：纪要生成是后台尽力而
-- 为任务，锁定时写入被门卫拒绝即静默丢弃；列表读取同样解锁后可用。
--
-- 列：
--   host_id       会话主机（NOT NULL：纪要恒有归属主机）
--   session_id    前端会话 id（标签 uuid，跨重连稳定；自由文本，不做 FK——同 history）
--   summary_enc   摘要密文 blob = nonce(12B) || ct || tag(16B)
--   command_count 摘要覆盖的命令条数（面板徽标 + 溯源面）
--   ts            秒级 Unix 时间（实体表同口径；upsert 时 = 最新一次生成时刻）
--
-- 删除语义：host_id REFERENCES hosts ON DELETE CASCADE——纪要是主机维度的
-- 运行日志（同 history 裁定），删主机即删其痕迹。session_id 刻意无 FK。
--
-- AUTOINCREMENT：承载加密列（summary_enc）经 AAD 绑定 rowid → 按 0002 文件头
-- 纪律强制（删最大 id 行不复用 rowid，防旧密文重注入）。
--
-- upsert 语义：同 (host_id, session_id) 唯一——手动断开后又重连再用再断开的
-- 会话（session_id 跨重连稳定）会多次走到「会话收尾」，后一次纪要覆盖前一次
-- （覆盖会话全程），rowid/AAD 保持稳定（secrets.rs「占位行拿 id + 同事务密封
-- 回填」同款，无半密封窗口）。

CREATE TABLE session_summaries (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id       INTEGER NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    session_id    TEXT NOT NULL,
    summary_enc   BLOB NOT NULL,
    command_count INTEGER NOT NULL,
    ts            INTEGER NOT NULL
);

-- 唯一性（upsert 目标键）+ host 过滤共用本索引（host_id 最左前缀）。
CREATE UNIQUE INDEX idx_session_summaries_session ON session_summaries (host_id, session_id);
