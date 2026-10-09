-- 0013_alert_rules（Phase 3 Task 3，B5 告警规则引擎 + 渠道全矩阵——存储侧）：
-- 告警规则配置（spec §3）。评估引擎在 TS（frontend/notify/rules.ts）——数据源是
-- 前端监控事件流（ottr://monitor）与进程采集（monitor_ps），Rust 只供表
-- （与 notifications「事件源接线在前端，Rust 只供表」同一分工纪律）。
--
-- 列：
--   host_id      规则归属主机（NOT NULL：规则恒针对具体主机；spec §3 无 ？标记，
--                与 history 的 host_id? 可空口径相反——NOT NULL 有据）
--   kind         规则类别：disk（磁盘使用率阈值）/ cpu（CPU 使用率持续超阈）/
--                process（进程消失）——log（日志关键字）Phase 3 MVP 裁定延后，
--                DB CHECK 仍放行 "log"（spec §3 同集；引擎侧延后评估）
--   params       类别参数 JSON：disk { mount?, threshold }、cpu { threshold,
--                consecutive }、process { comm }（引擎消费面见 frontend/notify/rules.ts）
--   channels     订阅渠道 id 数组 JSON（notify_channels.id；③外部渠道按此路由）
--   rate_limit   同规则再次告警的最小间隔（秒；0 = 只用管线全局 60s 聚合）
--   mute_window  静音时段 "HH:MM-HH:MM"（本地时区，可跨午夜；NULL = 不静音）
--   last_fired   最近一次触发时刻（秒级 Unix；NULL = 从未触发；引擎回写）
--
-- 明文面：无 *_enc 列（敏感材料在 notify_channels.config_enc，0014），不涉
-- scan_registry。锁定语义与 hosts 同（配置面命令统一 ensure_unlocked 门卫）。
--
-- FK：host_id REFERENCES hosts ON DELETE CASCADE——删主机即删其规则（同
-- session_summaries 裁定：主机维度的配置不迁移）。
-- AUTOINCREMENT：实体表统一纪律（0002 文件头），本期无加密列亦保留一致形态。

-- IF NOT EXISTS：迁移器按 schema_version 决定重放窗口，版本被手工拨回
-- （entities_test::migration_0012_legacy_v11_rows_default_to_zero 的旧库模拟）
-- 时后续 CREATE 会撞已有表——幂等形态让重放安全收敛（0001 同款）。
CREATE TABLE IF NOT EXISTS alert_rules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id     INTEGER NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('disk', 'cpu', 'process', 'log')),
    params      TEXT NOT NULL,
    channels    TEXT NOT NULL,
    rate_limit  INTEGER NOT NULL DEFAULT 0,
    mute_window TEXT,
    last_fired  INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_host ON alert_rules (host_id);
