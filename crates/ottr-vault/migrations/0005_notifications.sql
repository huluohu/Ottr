-- 0005_notifications（Task 12，spec §7 通知管线①应用内通知中心）。
-- 明文表面：通知不含任何敏感材料——title_key 是 i18n 词典键、body 是展示文本、
-- payload 是事件结构化参数（transfer_id 等）——无 *_enc 列，不涉重密封扫描
-- 注册表（scan_registry），亦无 AAD 绑定；AUTOINCREMENT 仍统一带上（实体表
-- 约定，id 永不复用，前端列表 key 稳定）。
-- host_id 引用 hosts：删主机 → SET NULL（裁定 #3 删除语义同构——通知是历史
-- 留痕，不随主机删除消失）；host_id 为 NULL 的通知照样成立（会话/传输事件
-- 未必能反查到主机行）。read：0=未读 1=已读（SQLite 无独立 bool）。
-- 索引：列表按 ts 倒序取最近 N 条 + 未读计数（read 过滤），单列各一。

CREATE TABLE notifications (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT NOT NULL,               -- 事件类别（"transfer" | "session"，Phase 3 起 AI 等）
    severity  TEXT NOT NULL DEFAULT 'info'
              CHECK (severity IN ('info', 'success', 'warning', 'error')),
    host_id   INTEGER REFERENCES hosts (id) ON DELETE SET NULL,
    title_key TEXT NOT NULL,               -- i18n 词典键（UI 渲染时 t(title_key)）
    body      TEXT NOT NULL DEFAULT '',    -- 展示文本（路径/主机名/错误消息，不进词典）
    payload   TEXT,                        -- JSON（可选结构化参数）
    read      INTEGER NOT NULL DEFAULT 0,
    ts        INTEGER NOT NULL             -- 秒级 Unix 时间（实体表同口径）
);

CREATE INDEX idx_notifications_ts ON notifications (ts DESC);
CREATE INDEX idx_notifications_unread ON notifications (read);
