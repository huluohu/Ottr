-- 0015_recordings（Phase 3 Task 5，B3 录制审计回放——存储侧）：
-- 会话录制元数据（spec §3 recordings 表：id, host_id, path, duration,
-- text_index_path, created_at）。asciinema v2 原始流**另存文件**（vault 数据
-- 目录 recordings/ 子目录，0600——录制含终端全量输出，敏感面比照库文件收紧），
-- path 入库、文件内容不入库（spec 列名即契约）。
--
-- 【FTS 索引选型】spec §5「文本流写入录制索引（FTS5）」+ 本简报二选一：
-- ① 每录制一张 FTS 影子表（text_index_path 指表名）——上千录制即上千张表，
--   sqlite_master 膨胀 + 迁移/清理面碎片化，否；
-- ② **共享单表 recordings_fts（trigram），content 直接入表、recording_id 作
--   UNINDEXED 列**（本迁移采用）——「录制内容全文可搜」是跨录制检索，单表
--   MATCH 一次命中全部；归属过滤走 recording_id 列；删录制由 AFTER DELETE
--   触发器清 FTS（含 host CASCADE 路径——触发器在 FK 级联删除时同样触发）。
--   spec 列 text_index_path 保留，语义 = 索引指针 `recordings_fts:{id}`
--   （插入后回填；外部工具可据此定位索引面）。
--
-- 索引内容 = 录制器**剥离 ANSI 后的纯文本**（Stripper 副本，录制线程就地
-- 生成）——trigram 对转义序列建索引只会命中垃圾；回放原始流仍走 .cast 文件。
-- 明文面：无 *_enc 列、不经 AAD 绑定、不涉 scan_registry（与 history 同一
-- 裁定：录制/历史是本地审计数据，脱敏只在导出分享时做）。
--
-- 列：
--   host_id         录制所属主机（NOT NULL：录制起点即校验 host 存在）
--   path            .cast 文件绝对路径（文件本体不入库）
--   duration        秒（浮点——asciinema 事件时间精度即浮点；空录制 = 0）
--   text_index_path FTS 索引指针 `recordings_fts:{id}`（见上选型）
--   created_at      秒级 Unix（实体表同口径）
--
-- 删除语义：host_id REFERENCES hosts ON DELETE CASCADE——录制是主机维度的
-- 审计痕迹（同 history 裁定，非「可复用实体」），删主机即删其录制行；.cast
-- 文件的删除在命令层（fs remove best-effort），触发器只管库面一致。
-- AUTOINCREMENT：实体表统一纪律（0002 文件头），本期无加密列亦保留一致形态。

-- IF NOT EXISTS：迁移器按 schema_version 决定重放窗口，版本被手工拨回
-- （0012 旧库模拟同款）时后续 CREATE 会撞已有表——幂等形态让重放安全收敛。
CREATE TABLE IF NOT EXISTS recordings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id         INTEGER NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    path            TEXT NOT NULL,
    duration        REAL NOT NULL DEFAULT 0,
    text_index_path TEXT NOT NULL DEFAULT '',
    created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recordings_host ON recordings (host_id);

-- FTS5 trigram（spec §3 CJK 检索，hosts/history 同款）：contentful 单表
-- （recording_id UNINDEXED 承载归属；content 即剥离后的录制文本）。
CREATE VIRTUAL TABLE IF NOT EXISTS recordings_fts USING fts5(
    content,
    recording_id UNINDEXED,
    tokenize = 'trigram'
);

-- 删录制行（显式 delete / host CASCADE）→ 同步清 FTS 行（防幽灵命中）。
-- recordings 无 UPDATE 路径（元数据不可变）——不建 au 触发器（0007 同款裁定）。
CREATE TRIGGER IF NOT EXISTS recordings_fts_ad AFTER DELETE ON recordings BEGIN
    DELETE FROM recordings_fts WHERE recording_id = old.id;
END;
