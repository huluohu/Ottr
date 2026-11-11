-- 0022_recordings_host_nullable（2026-10-20 本地终端）：recordings.host_id
-- 改可空——本地终端会话没有 vault 主机行，录制元数据仍需落库（回放/检索
-- 面与主机录制同享），host_id NULL = 归属「本机」。
--
-- SQLite 不能 ALTER 列可空性：标准四步重建（建新表 → 拷贝 → 删旧 → 改名）。
-- recordings_fts 是 contentful 自持表（recording_id UNINDEXED、无 FK），重建
-- 主表不动它的行；idx_recordings_host 随旧表删除，新表按原名重建。
--
-- 【勘误，2026-11-11】本迁移头注释曾断言「无触发器挂在本表」——**误判**：
-- 0015:57 的 recordings_fts_ad（AFTER DELETE ON recordings）正挂在
-- recordings 表上（recordings_fts 只是动作目标）。本迁移的 DROP TABLE 把它
-- 连带删除且未重建，此后删录制/删主机 CASCADE 都在 recordings_fts 留幽灵行
-- （已删录制的终端全文残留库文件）。由 0030 重建触发器并清理孤儿。
CREATE TABLE recordings_new (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id         INTEGER REFERENCES hosts (id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    duration        REAL NOT NULL DEFAULT 0,
    text_index_path TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL
);

INSERT INTO recordings_new (id, host_id, path, duration, text_index_path, created_at)
    SELECT id, host_id, path, duration, text_index_path, created_at FROM recordings;

DROP TABLE recordings;
ALTER TABLE recordings_new RENAME TO recordings;

CREATE INDEX IF NOT EXISTS idx_recordings_host ON recordings (host_id);
