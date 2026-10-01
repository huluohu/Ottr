-- 0012_hosts_is_production（Phase 2 Task 11，B11 防呆完善）：
--
-- hosts.is_production：生产环境主机标记（0/1 布尔语义），默认 0——存量行全按
-- 非生产处理（标记是显式动作，导入器/旧库升级不臆测）。消费面：
--   * HostForm 开关（用户显式标记）；
--   * 终端 pane 红色边框 + TabBar PROD 徽标（视觉防呆：在生产机上心手合一前
--     多看一眼）；
--   * danger.ts 输入侧提醒（B11：red/yellow 档命中即行内提示，同类 30s 限频）。
-- ADD COLUMN 带 CHECK + NOT NULL DEFAULT：SQLite 要求现有行满足 CHECK，
-- 默认值 0 天然满足（与 0010 protocol 列同思路的模型缺口补列）。

ALTER TABLE hosts ADD COLUMN is_production INTEGER NOT NULL DEFAULT 0
    CHECK (is_production IN (0, 1));
