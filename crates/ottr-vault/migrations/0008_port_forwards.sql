-- 0008_port_forwards（Phase 2 Task 1，B7 上半；spec §3 port_forwards 实体）。
-- 明文配置面：地址/端口/开关不含任何密钥材料——无 *_enc 列、不经 AAD 绑定、
-- 不涉 scan_registry（重密封扫描注册表），锁定语义与 hosts 同（实体命令面统一
-- 过 ensure_unlocked 门卫，见 desktop vault.rs）。
--
-- 列（spec 字段 + 本任务的结构化拆分）：
--   host_id        转发挂在哪台主机上（经该主机的 SSH 会话运行）
--   kind           'local'(-L) | 'remote'(-R) | 'dynamic'(-D SOCKS5)
--   bind_addr      监听地址（local/dynamic = 本机侧；remote = 远端 sshd 侧）
--   bind_port      监听端口；0 = local 动态分配 / remote 由服务端选择
--   target_host    目标主机（local = 从服务端视角解析；remote = 从本机视角解析；
--                  dynamic = NULL——目标由每个 SOCKS5 CONNECT 请求现场指定）
--   target_port    目标端口（dynamic = NULL）
--   enabled        开关：会话建立（attach）成功即自动启动 enabled 行
--   auto_reconnect 会话断线重连成功后自动恢复（enabled 且本开关开才恢复）
--   created_at / updated_at  秒级 Unix 时间（实体表同口径）
--
-- 结构化拆分（偏差记录）：spec 写 bind_addr/target 两个文本列；本迁移拆为
-- bind_addr/bind_port + target_host/target_port 四列——端口参与 CHECK 约束
-- （0..=65535）、dynamic 型目标列强制 NULL、UI 表单免字符串拼拆，校验前移到
-- 存储层。语义不变：bind_addr:bind_port = 监听端点，target_host:target_port = 目标。
--
-- CHECK 表级约束：local/remote 必须带目标，dynamic 必须不带（单一事实源，
-- 实体层校验只是更友好的报错面，这里是底线）。
--
-- AUTOINCREMENT：无加密列、不经 AAD 绑定，严格递增非必需；沿用实体表惯例
-- （id 永不复用，前端列表 key 稳定，零成本）。
--
-- 删除语义：port_forward 是主机的附属配置（非可复用实体），host_id
-- REFERENCES hosts ON DELETE CASCADE——删主机即删其转发配置，不产生悬空行
-- （同 history 的裁定；历史留痕类才用 SET NULL）。
CREATE TABLE port_forwards (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id        INTEGER NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
    kind           TEXT NOT NULL CHECK (kind IN ('local', 'remote', 'dynamic')),
    bind_addr      TEXT NOT NULL,
    bind_port      INTEGER NOT NULL CHECK (bind_port BETWEEN 0 AND 65535),
    target_host    TEXT,
    target_port    INTEGER CHECK (target_port IS NULL OR target_port BETWEEN 1 AND 65535),
    enabled        INTEGER NOT NULL DEFAULT 0,
    auto_reconnect INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    CHECK (
        (kind IN ('local', 'remote') AND target_host IS NOT NULL AND target_port IS NOT NULL)
        OR
        (kind = 'dynamic' AND target_host IS NULL AND target_port IS NULL)
    )
);

-- 面板主查询 = 按主机过滤 + 创建序（id 升序，配置列表稳定性优先）。
CREATE INDEX idx_port_forwards_host_id ON port_forwards (host_id);
