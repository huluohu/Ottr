-- 0024_alert_rules_host_nullable（2026-10-21 本机告警规则）：alert_rules.host_id
-- 改可空——本地终端会话没有 vault 主机行，本机告警规则（磁盘/CPU/进程/日志）
-- 仍需落库，host_id NULL = 归属「本机」，与 0022（recordings）/0023（history、
-- session_summaries）同一口径。引擎侧（frontend/notify/rules.ts）以 hostId -1
-- 哨兵匹配 NULL 规则，数据通路（ottr://monitor 本机采样、monitor_ps/
-- monitor_log_tail 本机回退）已就绪。
--
-- SQLite 不能 ALTER 列可空性：四步重建（建新表 → 拷贝 → 删旧 → 改名）。
-- 本表无含 host_id 的唯一约束（0013 只有非唯一 idx_alert_rules_host），重建后
-- 按原名重建索引即可；无触发器挂在本表；明文面无 *_enc 列，不动 scan_registry。

CREATE TABLE alert_rules_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id     INTEGER REFERENCES hosts (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('disk', 'cpu', 'process', 'log')),
    params      TEXT NOT NULL,
    channels    TEXT NOT NULL,
    rate_limit  INTEGER NOT NULL DEFAULT 0,
    mute_window TEXT,
    last_fired  INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

INSERT INTO alert_rules_new (id, host_id, kind, params, channels, rate_limit, mute_window, last_fired, created_at, updated_at)
    SELECT id, host_id, kind, params, channels, rate_limit, mute_window, last_fired, created_at, updated_at FROM alert_rules;

DROP TABLE alert_rules;
ALTER TABLE alert_rules_new RENAME TO alert_rules;

CREATE INDEX IF NOT EXISTS idx_alert_rules_host ON alert_rules (host_id);
