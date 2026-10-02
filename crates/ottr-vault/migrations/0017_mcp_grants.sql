-- 0017_mcp_grants（Phase 4 Task 3，C1 MCP Server 接入——存储侧）：
-- MCP 工具面的主机粒度授权矩阵（安全裁定：**默认全部拒收**——无授权行 =
-- 该主机对 MCP 客户端完全不可见、不可执行、不可读；用户在 UI 逐主机显式
-- 授权后才进入工具面）。
--
-- 授权模型（每主机一行，host_id UNIQUE——授权是主机属性，非多行叠加）：
--   host_id        授权主体（FK ON DELETE CASCADE——删主机即删其授权，
--                  cron_jobs 同款裁定；UNIQUE 防同一主机多行授权叠加）
--   can_list       list_hosts 可见位（0/1）：1 = 主机元数据（名称/地址/端口/
--                  标签/分组）出现在 MCP 工具结果里；0 = 完全不可见。
--                  **永不携带凭据面**（username/credential 不在工具输出，
--                  密钥面永不出 vault——硬约束在引擎层二次收口）。
--   can_exec       exec_command 放行位（0/1）：0 = 该主机 exec 一律拒绝。
--   exec_approval  逐次执行审批门（0/1，缺省 1）：1 = 每次 exec_command 先经
--                  UI 审批框（ottr://mcp-approval → 用户裁定，超时/拒绝 =
--                  不执行）；0 = 授权即放行（用户显式选择的免审批档）。
--   read_paths     read_file 目录白名单 JSON 数组（绝对路径字符串；空数组 =
--                  read_file 一律拒绝）。前缀匹配在引擎层用 SFTP realpath
--                  归一后比对（符号链接/.. 归一在远端做——本地字符串比较
--                  只做预筛，最终判定以远端 canonical 路径为准）。
--
-- 明文面：无 *_enc 列（授权矩阵本身不是机密——机密在凭据表，本表只是
-- 开关面），不涉 scan_registry。锁定语义与 hosts/cron_jobs 同（配置面）：
-- 命令层统一 ensure_unlocked 门卫；引擎读授权走存储层（锁定时引擎对
-- exec/read 另有锁定拒绝门，见 commands/mcp.rs）。
-- AUTOINCREMENT + IF NOT EXISTS：实体表统一纪律（0002/0013/0016 同款）。

CREATE TABLE IF NOT EXISTS mcp_grants (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    host_id       INTEGER NOT NULL UNIQUE REFERENCES hosts (id) ON DELETE CASCADE,
    can_list      INTEGER NOT NULL DEFAULT 0,
    can_exec      INTEGER NOT NULL DEFAULT 0,
    exec_approval INTEGER NOT NULL DEFAULT 1,
    read_paths    TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
