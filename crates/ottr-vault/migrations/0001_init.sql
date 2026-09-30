-- 0001_init：引导迁移——仅 meta + settings 两表。
-- 台账裁定：实体表按域拆分到后续迁移（Task 4 → 0002 entities、Task 12 → notifications），
-- 避免巨型 migration；本迁移只负责"库能打开、版本可追踪、配置有处放"。
-- settings.value 为 JSON（spec §3：主题/AI Provider 等纯配置存 JSON）。

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL -- JSON
);
