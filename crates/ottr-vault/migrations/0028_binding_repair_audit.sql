-- 0028_binding_repair_audit（2026-11-03，v1.6.2 数据事故修复）：
--
-- 事故：0026 为加 kind='agent' 重建 credentials 表（DROP + RENAME）。而
-- hosts.credential_id 上挂着 `REFERENCES credentials(id) ON DELETE SET NULL`
-- —— SQLite 在 foreign_keys=ON 时 DROP 父表会**立即执行 SET NULL 动作**，
-- 把用户所有主机的凭据绑定静默清空（升级即断连）。
--
-- 本迁移不碰 hosts 的数据（恢复由 Rust 侧的修复器做——名称匹配需要逻辑，
-- 纯 SQL 表达不了），只建一张**审计表**：记录自动恢复过哪些绑定、
-- 依据是什么、什么时候做的。用户可查、可审计、可撤销。
--
-- 为什么单独一张表而不是塞 meta：meta 是键值对，装不下"一条修复一行"的
-- 结构化记录；且审计表不参与同步分类（同步集是白名单，见 sync_snapshot.rs）。
CREATE TABLE IF NOT EXISTS binding_repairs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id       INTEGER NOT NULL,
    credential_id INTEGER NOT NULL,
    method        TEXT NOT NULL,   -- 匹配依据：exact / contains / cjk_substring
    restored_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_binding_repairs_host
    ON binding_repairs (host_id);
