-- 0007_history：spec §3 history 表（Task 15 启用，此前挂账不入 0002——见其文件头）。
-- 命令历史 = 本地明文面（spec 定案：脱敏不在历史层做，历史是本地数据）：
-- 无 *_enc 列、不经 AAD 绑定，锁定态照常读写（与 notifications/settings 同一
-- 锁定语义，见 store.rs 模块文档）——锁定时命令照常跑完、照常入库。
--
-- 列（0002 台账裁定的形态 + 本任务补 cwd）：
--   host_id    产生该命令的会话主机（NOT NULL：前端 SessionStore 会话恒有 hostId）
--   command    命令行文本（OSC133 A..C 提取，含提示符原文——文本层已知限制，
--              见 frontend/terminal/CommandWatch.ts 模块文档）
--   cwd        命令运行目录（shell 集成 OSC 7 在提示符时点上报的 PWD；未上报 = NULL）
--   exit_code  退出码（shell 未上报 = NULL；含 0 —— 历史记录全量命令，与 AI
--              诊断「仅失败触发」的门槛不同）
--   session_id 前端会话 id（标签 uuid，跨重连稳定；自由文本，不做 FK）
--   ts         秒级 Unix 时间（实体表同口径）
--
-- 删除语义：host_id REFERENCES hosts ON DELETE CASCADE——history 是主机维度的
-- 运行日志（非 0002 裁定 #3 的「可复用实体」），删主机即删其痕迹，不产生
-- host_id 悬空行（⌘R 结果永不出现「未知主机」死条目）。session_id 刻意无 FK。
--
-- AUTOINCREMENT：history 无加密列、不经 AAD 绑定，严格递增非必需；但清理策略
-- 按 id 倒序取最近 N 条（id 单调 ≈ 时间序），AUTOINCREMENT 保证 id 永不复用，
-- 「更新的 id」语义不会被删除扰动，故沿用（与实体表惯例一致，零成本）。
CREATE TABLE history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id    INTEGER NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    command    TEXT NOT NULL,
    cwd        TEXT,
    exit_code  INTEGER,
    session_id TEXT,
    ts         INTEGER NOT NULL
);

-- ⌘R 面板主查询 = 按主机过滤 + 时间倒序（insert/search 主路径；FTS 命中后
-- 也要按 id 倒序回表）。单列 id 上有隐式 rowid 索引，host_id 过滤靠本索引。
CREATE INDEX idx_history_host_id ON history (host_id);

-- FTS5 trigram（spec §3 CJK 检索，与 hosts_fts/snippets_fts 同款）：外部内容表
-- + 触发器同步。history 只插入与整行删除（清理策略），无 UPDATE 路径——
-- 不建 au 触发器（若未来加更新路径必须补，防索引漂移）。
CREATE VIRTUAL TABLE history_fts USING fts5(
    command,
    content = 'history',
    content_rowid = 'id',
    tokenize = 'trigram'
);

CREATE TRIGGER history_fts_ai AFTER INSERT ON history BEGIN
    INSERT INTO history_fts (rowid, command) VALUES (new.id, new.command);
END;

CREATE TRIGGER history_fts_ad AFTER DELETE ON history BEGIN
    INSERT INTO history_fts (history_fts, rowid, command)
    VALUES ('delete', old.id, old.command);
END;
