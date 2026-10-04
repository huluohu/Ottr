-- 0019_fk_child_indexes：FK 子列索引补齐（BL-206，账本清零批次 G2）。
-- 为什么：SQLite 对 FK 的 ON DELETE 动作（本库三处 CASCADE、其余 SET NULL）
-- 在删父行时要扫子表找引用行；子列无索引 = 每删一个父行做一次全表扫。
-- 0002/0005 建表时给 history/recordings/alert_rules/port_forwards/cron 等大
-- 子表都配了索引，但下面 5 列漏配——它们的父行删除（删凭据、删组、删主机）
-- 会随子表规模线性劣化。补齐为普通非唯一索引（引用列可重复、可 NULL），
-- IF NOT EXISTS 幂等；明文面，无 *_enc 列，不动 scan_registry。
-- 已由约束自动覆盖、无需补建的 FK 子列：mcp_grants.host_id（UNIQUE），
-- session_summaries(host_id, session_id)（UNIQUE 复合索引领先列）。

CREATE INDEX IF NOT EXISTS idx_host_groups_parent_id
    ON host_groups (parent_id);        -- host_groups.parent_id → host_groups(id)（SET NULL）

CREATE INDEX IF NOT EXISTS idx_hosts_group_id
    ON hosts (group_id);               -- hosts.group_id → host_groups(id)（SET NULL）

CREATE INDEX IF NOT EXISTS idx_hosts_credential_id
    ON hosts (credential_id);          -- hosts.credential_id → credentials(id)（SET NULL）

CREATE INDEX IF NOT EXISTS idx_snippets_host_scope
    ON snippets (host_scope);          -- snippets.host_scope → hosts(id)（SET NULL）

CREATE INDEX IF NOT EXISTS idx_notifications_host_id
    ON notifications (host_id);        -- notifications.host_id → hosts(id)（SET NULL）
