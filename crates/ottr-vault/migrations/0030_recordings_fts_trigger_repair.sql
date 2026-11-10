-- 0030_recordings_fts_trigger_repair（2026-11-11，P2 recordings FTS 幽灵行修复）：
--
-- 事故：0022 为把 recordings.host_id 改可空而四步重建 recordings 表
-- （DROP TABLE recordings 连带删除了挂在它上面的 0015 的 recordings_fts_ad
-- AFTER DELETE 触发器，且未重建——0022 头注释「无触发器挂在本表」误判：
-- 触发器挂载点是 recordings 表，recordings_fts 只是动作目标）。此后
--
--   * 显式删录制（Recordings::delete）
--   * 删主机 CASCADE（hosts ON DELETE CASCADE 路径，FK 动作删子行同样
--     应触发 AFTER DELETE 触发器——0015 选型注释的承诺）
--
-- 都不再清 recordings_fts：已删录制的终端全文（剥离 ANSI 的纯文本）作为
-- 幽灵行永久残留库文件，删除语义失效且 FTS 无限膨胀。检索 SQL JOIN
-- recordings 对幽灵行不可见，故此前 delete_cleans_fts 回归测试恒过、钉不住。
--
-- 修复两步：
--   1. 按 0015:57 原定义重建触发器（IF NOT EXISTS 幂等形态同 0015:34——
--      迁移器按 schema_version 决定重放窗口，版本被手工拨回时重放安全收敛）；
--   2. 一次性清孤儿：FTS 行 recording_id 不在 recordings 的（0022 以来
--      显式删除/级联删除欠下的账）全部删除——录音文本随删除语义退场。
--
-- recordings_fts 是 contentful 自持 FTS5 表（非 external content），DELETE
-- 直接可执行；孤儿判定 NOT IN (SELECT id FROM recordings) 与删除语义对齐
-- （host_id NULL 的本地录制行同样被保护，不会被误清）。
CREATE TRIGGER IF NOT EXISTS recordings_fts_ad AFTER DELETE ON recordings BEGIN
    DELETE FROM recordings_fts WHERE recording_id = old.id;
END;

DELETE FROM recordings_fts
    WHERE recording_id NOT IN (SELECT id FROM recordings);
