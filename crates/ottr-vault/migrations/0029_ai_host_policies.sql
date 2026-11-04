-- 0029_ai_host_policies（2026-11-04，Ask Ottr 执行模式第三步：自动档）：
--
-- 主机粒度的「自动执行」授权矩阵（安全裁定：**默认全部拒绝**——无授权行 =
-- 该主机不允许 AI 自动执行任何命令；用户在设置页逐主机显式开启后才进得了
-- 自动档）。范式与 mcp_grants 同款（默认全拒 + 主机粒度单行）。
--
-- 授权模型（每主机一行，host_id UNIQUE——授权是主机属性，非多行叠加）：
--   host_id          授权主体（FK ON DELETE CASCADE——删主机即删其授权；
--                    mcp_grants / cron_jobs 同款裁定；UNIQUE 防多行叠加）
--   auto_enabled     自动档总闸（0/1）：1 = 该主机允许「自动」档；
--                    0 / 缺行 = 自动档不可用（规划档 / 手动档不受影响）
--   write_categories 自动档允许**直接执行**的写操作类别 JSON 数组
--                    （"package" 包管理 / "service" 服务重启 /
--                    "file" 文件编辑 / "git" 版本控制写操作；
--                    空数组 = 只读命令可自动执行，写操作一律降级为逐条确认）
--
-- **与 mcp_grants 不共用**：mcp_grants 管的是「Ottr 作为 MCP server」对外
-- 暴露给**外部 MCP 客户端**的授权；本表管的是「面板内 AI」对**本机连接**
-- 的自动执行授权——两套授权面、两套语义，不互相继承、不互相放宽。
--
-- 明文面：无 *_enc 列（授权矩阵本身不是机密——机密在凭据表；本表只是开关面），
-- 不涉 scan_registry。锁定语义与 hosts / mcp_grants 同（配置面）：命令层统一
-- ensure_unlocked 门卫，存储层不设门卫。
CREATE TABLE IF NOT EXISTS ai_host_policies (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id          INTEGER NOT NULL UNIQUE REFERENCES hosts (id) ON DELETE CASCADE,
    auto_enabled     INTEGER NOT NULL DEFAULT 0,
    write_categories TEXT NOT NULL DEFAULT '[]',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);
