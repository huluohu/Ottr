-- 0003_hosts_username：hosts.username 登录用户名列（Task 5）。
-- 背景：spec §3 主机模型未列 username，但 Task 5 简报的 HostForm 与 ssh-config
-- 导入（User 字段 → 去重键 address+port+username）、Task 7 连接流程（SSH 认证
-- 需要）都依赖它——列在消费面落地时补齐（与 Task 4 报告偏差 #1 同源的模型缺口）。
-- 纯增量列：无加密字段，不涉「AAD 绑定表一律 AUTOINCREMENT」约定；
-- NULL = 未指定（连接时回退当前系统用户）。
ALTER TABLE hosts ADD COLUMN username TEXT;
