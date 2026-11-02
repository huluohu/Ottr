-- 0027_mcp_servers（Ottr 作为 **MCP 客户端**——连接外部 MCP server 的配置面）：
-- 外部 MCP server 的清单（命令 / 参数 / 启用位 / 环境变量名）。
--
-- 背景：MCP server 侧配置（mcp_grants，0017）管的是「Ottr 把主机暴露给 AI 客户端」；
-- 本表管的是反方向——「Ottr 作为客户端去连**外部** MCP server」（stdio transport：
-- 起子进程 → initialize → tools/list / tools/call）。
--
-- 列语义：
--   id          稳定标识（TEXT 主键；UUID 形态，由命令面生成——不是自增整数：
--                外部 server 的 id 要跨设备/跨导出保持不变，整数 autoincrement
--                在导入导出场景下会撞号）
--   name        用户可见名（列表展示面）
--   command     可执行文件路径（不经 shell 拼接——无注入面）
--   args        启动参数 JSON 数组（字符串数组；空数组 = 无参数）
--   env_names   环境变量**名**列表 JSON 数组（**只存名字，不存值**——值在
--                secrets 密文面，见下）
--   enabled     启用位（0/1；关 = 不出现在可用列表，配置保留）
--   created_at/updated_at  unix 秒
--
-- **为什么 env 的值不进本表**：环境变量里放的多是 API key / token（外部 MCP
-- server 的鉴权面）——明文落库即破「秘密字段级加密」红线（见 CLAUDE.md 安全边界）。
-- 值一律走 secrets 密封 KV（`Secrets::set`），key 约定 `mcp.env.<server_id>.<VAR>`，
-- 与 `ai.apikey.<id>` 同款加密面（AES-256-GCM + AAD 绑定）。本表只留**变量名**
-- （供 UI 回显「哪些变量有值」+ 删 server 时逐个清密文）。
--
-- 明文面：本表无 *_enc 列（命令/参数/变量名都不是机密），不涉 scan_registry；
-- 锁定语义与 hosts/cron_jobs 同（配置面）：命令层统一 ensure_unlocked 门卫。
-- 无 AUTOINCREMENT（id 由上层生成，非自增序列——避免导入导出撞号）。
CREATE TABLE IF NOT EXISTS mcp_servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    command     TEXT NOT NULL,
    args        TEXT NOT NULL DEFAULT '[]',
    env_names   TEXT NOT NULL DEFAULT '[]',
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
