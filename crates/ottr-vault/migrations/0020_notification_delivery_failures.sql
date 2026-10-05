-- 0020_notification_delivery_failures：投递失败标记持久化（BL-530，账本清零批次 G3）。
-- 为什么：渠道投递终败的「投递失败」标记此前是纯前端会话内账本（重启丢失，
-- 重发入口随标记一起消失）；本迁移给 notifications 补 delivery_failures 列，
-- 标记/翻正/清账全部落库（Rust mark/clear 命令面 + 前端写穿，见
-- notifications.rs 与 src/notify/core.ts）。
-- 列形态：JSON 数组（元素 {channel, channel_id, error, ts}——渠道挂载名按
-- 「kind#id」去重键），NULL = 无标记（旧库升级后的默认态，向后兼容）；集合
-- 清空时写回 NULL 而非 '[]'（无标记态恒一形态）。
-- 明文面：失败标记不含密钥材料（渠道名/错误文本/时刻），无 *_enc 列，不动
-- scan_registry；锁定语义同 notifications 本体（投递失败发生在锁定态也要能
-- 落账，不过 ensure_unlocked 门卫）。无索引（标记只在单行读写，无按列检索面）。

ALTER TABLE notifications ADD COLUMN delivery_failures TEXT;
