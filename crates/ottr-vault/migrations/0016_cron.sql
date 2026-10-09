-- 0016_cron（Phase 4 Task 1，Phase 3 缺口①：cron 定时任务——存储侧）：
-- 任务配置（cron_jobs，spec §3）+ 运行历史（cron_runs，本任务设计）。
--
-- 调度/评估引擎在 Rust 侧（ottr-monitor src/cron.rs + desktop
-- commands/cron.rs——引擎宿主裁定落地：调度脱离 webview 生命周期，
-- 「App 退出即停」语义在模块文档明示，托盘常驻=运行）；本 crate 只供表，
-- 与 alert_rules「评估在 TS、Rust 只供表」同一分工纪律。
--
-- cron_jobs 列（spec §3：id, host_id, schedule, script, keep_output,
-- channels(json)；本任务裁定 keep_output 由 cron_runs 历史表替代——
-- 运行历史统一保留，输出正文走 sidecar 文件不入库）：
--   host_id    任务归属主机（NOT NULL：exec 恒针对具体主机；FK ON DELETE
--              CASCADE——删主机即删其任务，alert_rules 同款裁定）
--   schedule   五段式 cron 表达式（分 时 日 月 周；子集语法与校验在
--              ottr-monitor::cron::CronExpr——存储层只做非空+长度护栏，
--              语义校验在命令层 create/update 前置）
--   script     远端执行的脚本/命令（exec 通道；≤64KB——batch 单命令同款
--              护栏，防误粘超大文本）
--   channels   订阅渠道 id 数组 JSON（notify_channels.id；③外部渠道按此
--              路由，spec §7「alert_rules.channels / cron_jobs.channels 订阅」）
--   enabled    启用位（禁用 = 调度器跳过，配置保留）
--
-- cron_runs 列（运行历史；保留策略 = 每 job 最近 CRON_RUNS_KEEP 条，插入
-- 时裁剪）：status ∈ ok/failed/timeout/missed（missed = 触发时主机无在册
-- 会话，如实记录不自动连接）；exit_code 可空（missed/timeout 无退出码）；
-- output_digest = 输出（截断后）的 sha256 hex——历史完整性对账面；
-- output_path = 输出正文 sidecar 文件路径（非空输出才写，正文不入库）。
--
-- 明文面：无 *_enc 列（script 是用户自己写的明文命令，与 batch/历史同口径；
-- 敏感材料面在 notify_channels.config_enc），不涉 scan_registry。锁定语义
-- 与 hosts/alert_rules 同（配置面命令统一 ensure_unlocked 门卫）。
-- AUTOINCREMENT：实体表统一纪律（0002 文件头）；cron_runs.id 供 UI 排序。
-- IF NOT EXISTS：幂等形态（0013 同款，防版本拨回重放撞表）。

CREATE TABLE IF NOT EXISTS cron_jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id    INTEGER NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    schedule   TEXT NOT NULL,
    script     TEXT NOT NULL,
    channels   TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_host ON cron_jobs (host_id);

CREATE TABLE IF NOT EXISTS cron_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    cron_id       INTEGER NOT NULL REFERENCES cron_jobs (id) ON DELETE CASCADE,
    status        TEXT NOT NULL CHECK (status IN ('ok', 'failed', 'timeout', 'missed')),
    exit_code     INTEGER,
    output_digest TEXT,
    output_path   TEXT,
    duration_ms   INTEGER NOT NULL DEFAULT 0,
    ts            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs (cron_id, ts);
