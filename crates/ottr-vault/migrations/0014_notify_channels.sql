-- 0014_notify_channels（Phase 3 Task 3，B5 渠道全矩阵——存储侧）：
-- 外部通知渠道配置（spec §3：钉钉/飞书/企微/Bark/Server酱/Telegram/Discord/
-- Slack/SMTP/Pushover/ntfy/自定义 webhook 共 12 种）。适配器实现在 TS
-- （src/notify/channels/*，统一 fetch），SMTP 经 Rust lettre 命令
-- （smtp_send/smtp_test，commands/notify.rs）。
--
-- 【密文面裁定】（task-3 简报裁定 #2）：渠道配置含 webhook URL / bot token /
-- 加签 secret / SMTP 密码等敏感材料——spec §3 「AI 的 BYOK API Key、TOTP
-- secret、通知渠道 config 一律走 *_enc 密文，不落明文」。整个 config 对象
-- JSON 序列化后密封进 config_enc（AES-256-GCM，AAD =
-- "notify_channels:{id}:config"，唯一构造点 crate::aad），**已登记
-- store.rs scan_registry**（主密码升级重密封扫描覆盖；守卫测试
-- password_mode_test::reencrypt_scan_covers_all_enc_columns 动态比对强制）。
-- 锁定语义与 secrets/summaries 相同（Vault::cipher() 锁定即拒）。
--
-- 列：
--   kind               渠道类别（spec §3 同集 12 种；DB CHECK 约束）
--   config_enc         渠道配置密文 blob = nonce(12B) || ct || tag(16B)
--                      （各 kind 字段面见 src/notify/channels/types.ts）
--   template_overrides 渠道级文案覆写 JSON（可空；title/body 模板，MVP 仅
--                      webhook 的 body 模板变量 {{host}} {{rule}} {{value}}）
--   enabled            渠道启用位（禁用 = 挂载层跳过挂载；删除前先禁用的软开关）
--   created_at/updated_at 秒级 Unix（实体表同口径）
--
-- AUTOINCREMENT：承载加密列（config_enc）经 AAD 绑定 rowid → 按 0002 文件头
-- 纪律强制（删最大 id 行不复用 rowid，防旧密文重注入）。

-- IF NOT EXISTS：版本被手工拨回（0012 旧库模拟同款）时重放安全收敛（0001 同款）。
CREATE TABLE IF NOT EXISTS notify_channels (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    kind               TEXT NOT NULL CHECK (kind IN (
                           'dingtalk', 'feishu', 'wecom', 'bark', 'serverchan',
                           'telegram', 'discord', 'slack', 'smtp', 'pushover',
                           'ntfy', 'webhook')),
    config_enc         BLOB NOT NULL,
    template_overrides TEXT,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
);
