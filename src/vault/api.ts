// ottr-vault 前端封装（Task 4）：类型化 invoke 层 + zustand store 的数据层。
//
// 与 Rust 侧的契约（编译期对齐）：
//   * 本文件的接口镜像 crates/ottr-vault/src/entities.rs 的 serde 结构——字段名
//     逐字 snake_case（serde 默认不重命名）、`Option<T>` ↔ `T | null`、i64 ↔ number、
//     bool ↔ boolean。Rust 侧改字段必须同步这里（Task 5 接线后两侧不符会在编译期报错）。
//   * invoke 命令名 = Task 5 在 src-tauri 注册 Tauri 命令时的契约名，逐字对齐：
//       hosts_list hosts_get hosts_create hosts_update hosts_delete
//       hosts_list_by_group hosts_search
//       credentials_list credentials_get credentials_create credentials_update
//       credentials_delete credentials_reveal
//       host_groups_list host_groups_create host_groups_update host_groups_delete
//       snippets_list snippets_get snippets_search snippets_create snippets_update
//       snippets_delete
//       known_hosts_list known_hosts_upsert known_hosts_verify known_hosts_mark_changed
//       known_hosts_delete known_hosts_probe known_hosts_audit_run（B9 生命周期收口）
//       import_ssh_config export_hosts_csv（Task 5 导入/导出）
//       key_generate key_inspect key_export key_deploy（Task 6 密钥管理，src-tauri keys.rs）
//       vault_security_status vault_unlock vault_lock vault_upgrade_to_master_password
//       settings_get settings_set（T11 安全底座 + theme/language 迁 vault）
//       vault_copy_credential_secret（T11 剪贴板，src-tauri security.rs）
//       notify_insert notify_list notify_mark_read notify_clear notify_unread_count
//       （Task 12 通知中心，spec §7①；事件源接线在 src/notify/core.ts）
//       session_tail（Task 13 AI 诊断：会话输出尾部剥 ANSI 纯文本）
//       secret_set secret_get secret_delete secret_contains
//       （Task 13 secrets 密文 KV：AI provider api key，锁定即拒）
//       history_insert history_search
//       （Task 15 统一历史搜索 ⌘R：明文面，锁定可读写——写入源是前端
//       CommandWatch 的命令完成事件，见 src/history/record.ts）
//       history_list_session summary_insert summary_list
//       recording_start recording_stop recording_list recording_search
//       recording_read recording_delete recording_export
//       （Phase 3 Task 5 会话录制 B3：tee 在 Rust flush_batch，明文面同 history）
//       （Phase 2 Task 7 会话纪要：数据源命令序列（明文面）+ 摘要密文面
//       （summary_enc 已登记 scan_registry，summary_insert/list 过锁定门卫））
//       pf_list pf_create pf_update pf_delete pf_set_enabled pf_start pf_stop
//       （Phase 2 Task 1 端口转发中心，B7 上半；配置面过锁定门卫，运行面
//       ForwardManager 在 src-tauri commands/forward.rs）
//       jc_list jc_create jc_update jc_delete jc_test
//       （Phase 2 Task 2 跳板链，B7 下半；配置面过锁定门卫，测试连接面
//       jc_test 在 src-tauri commands/jump.rs）
//   * 顶层 invoke 参数走 Tauri v2 的 camelCase 约定（groupId / hostGroups...）；
//     载荷对象内部（HostInput 等）是 serde 反序列化面，保持 snake_case。
//
// 明文密钥纪律：Credential 类型不含任何密钥字段；明文只能经 credentials.reveal
// 单点取回（对应 Rust Credentials::reveal），列表/详情永不携带密钥材料。
// 检索语义由 Rust 层保证：≥3 字符走 FTS5 trigram MATCH，超短查询 LIKE 兜底
// （task-3 实测：trigram 对 <3 字符的 MATCH 恒 0 行），前端无需分派。

import { invoke } from "@tauri-apps/api/core";

/** 凭据类型（Rust CredentialKind 同构；ftp/ftps = FTP 密码型凭据，Phase 2 Task 5）。 */
export type CredentialKind = "password" | "key" | "totp" | "ftp" | "ftps";
/** 主机协议（Rust HostProtocol 同构；ftp/ftps = 文件传输会话，无 PTY 终端）。 */
export type HostProtocol = "ssh" | "ftp" | "ftps";
export type KnownHostState = "ok" | "changed" | "pending";
/** credentials.reveal 的字段选择（Rust SecretField 同构，serde snake_case）。
 * 注：此处 totp_secret 为用户原样输入，不做 normalize（去空格/大写化）——
 * normalize 挂账 TOTP 生成器任务（消费 totp_secret 时统一处理），UI 只做字符集粗检。 */
export type SecretField = "secret" | "passphrase" | "totp_secret";

/** Rust `ssh_config::ImportReport` 同构（Task 5 ssh-config 导入，对话框展示）。 */
export interface ImportReport {
  added: number;
  skipped_wildcards: number;
  skipped_duplicates: number;
  errors: string[];
}

/** Rust `entities::Host`（serde）同构。 */
export interface Host {
  id: number;
  name: string;
  group_id: number | null;
  tags: string[];
  address: string;
  port: number;
  username: string | null;
  protocol: HostProtocol;
  credential_id: number | null;
  jump_chain_id: number | null;
  encoding_override: string | null;
  theme_override: string | null;
  monitor_enabled: boolean;
  /** 生产环境主机标记（B11 防呆）：终端红框 + PROD 徽标 + danger 输入提醒。 */
  is_production: boolean;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

/** Rust `entities::HostInput` 同构（create/update 全量替换式提交）。 */
export interface HostInput {
  name: string;
  group_id: number | null;
  tags: string[];
  address: string;
  port: number;
  username: string | null;
  protocol: HostProtocol;
  credential_id: number | null;
  jump_chain_id: number | null;
  encoding_override: string | null;
  theme_override: string | null;
  monitor_enabled: boolean;
  is_production: boolean;
  notes: string | null;
}

/** Rust `entities::Credential` 同构——不含任何密钥字段。 */
export interface Credential {
  id: number;
  kind: CredentialKind;
  key_pub: string | null;
  created_at: number;
  updated_at: number;
}

/** Rust `entities::CredentialInput`：secret/passphrase/totp_secret 为明文，存储层 seal。 */
export interface CredentialInput {
  kind: CredentialKind;
  secret: string | null;
  key_pub: string | null;
  passphrase: string | null;
  totp_secret: string | null;
}

/** Rust `entities::CredentialPatch`：null = 保留现值（未重输的密钥不重密封）。 */
export interface CredentialPatch {
  kind: CredentialKind | null;
  secret: string | null;
  key_pub: string | null;
  passphrase: string | null;
  totp_secret: string | null;
}

/** Rust `entities::HostGroup` 同构。 */
export interface HostGroup {
  id: number;
  name: string;
  parent_id: number | null;
  color: string | null;
  created_at: number;
  updated_at: number;
}

/** Rust `entities::Snippet` 同构。 */
export interface Snippet {
  id: number;
  name: string;
  body: string;
  variables: string[];
  tags: string[];
  host_scope: number | null;
  created_at: number;
  updated_at: number;
}

/** Rust `entities::SnippetInput` 同构。 */
export interface SnippetInput {
  name: string;
  body: string;
  variables: string[];
  tags: string[];
  host_scope: number | null;
}

/** Rust `entities::KnownHost` 同构（以 host 端点为主键，0004 迁移起）。
 * host_key = "address:port"（IPv6 为 "[addr]:port"）；迁移前的存量行是
 * "legacy:{fingerprint}" 虚拟端点（信任关系待下次连接重建）。 */
export interface KnownHost {
  host_key: string;
  fingerprint: string;
  first_seen: number;
  verified: boolean;
  changed_at: number | null;
  state: KnownHostState;
}

/** `ottr://host-key-changed` 事件载荷（Rust HostKeyChangedPayload 同构，B9
 * 指纹巡检；seen = 本次观测集，锚消失时在场钥匙 = 新锚候选面）。 */
export interface HostKeyChangedPayload {
  host_key: string;
  anchor: string;
  seen: string[];
}

/** `known_hosts_audit_run` 单条 changed 回执（Rust ChangedEntry 同构）。 */
export interface KnownHostChangedEntry {
  row: KnownHost;
  seen: string[];
}

/** `known_hosts_audit_run` 一轮巡检回执（Rust AuditOutcome 同构）。 */
export interface HostKeyAuditOutcome {
  checked: number;
  changed: KnownHostChangedEntry[];
}

/** Rust `keygen::KeyAlgorithm` 同构（serde lowercase）。 */
export type KeyAlgorithm = "ed25519" | "ecdsa-p256" | "rsa";

/** Rust `keygen::KeyMaterial` 同构：私钥 PEM（可能含加密段）/ 公钥行 / SHA256 指纹。 */
export interface KeyMaterial {
  algorithm: KeyAlgorithm;
  private_openssh: string;
  public_openssh: string;
  fingerprint: string;
}

/** Rust `DeployStatus` 同构（serde snake_case）。 */
export type DeployStatus = "added" | "already_present";

/** Rust `keys::KeyDeployReport` 同构（serde snake_case）。 */
export interface KeyDeployReport {
  status: DeployStatus;
  public_key_fingerprint: string;
  host_key_fingerprint: string | null;
  known_hosts_state: KnownHostState;
}

/** Rust `vault::SecurityStatus` 同构（T11 锁定状态机查询）。 */
export interface SecurityStatus {
  /** "keyring"（钥匙链直取，无锁概念）| "password"（Argon2id 主密码派生）。 */
  mode: "keyring" | "password";
  locked: boolean;
}

/** Rust `notifications::Notification` 同构（Task 12，spec §7 通知中心行）。
 * severity ∈ "info" | "success" | "warning" | "error"（DB CHECK 同集）。 */
export interface Notification {
  id: number;
  kind: string;
  severity: "info" | "success" | "warning" | "error";
  host_id: number | null;
  /** i18n 词典键（渲染时 t(title_key)；非明文标题，换语言不失效）。 */
  title_key: string;
  /** 展示文本（路径/主机名/错误消息，事件自带内容）。 */
  body: string;
  payload: unknown;
  read: boolean;
  /** 秒级 Unix 时间。 */
  ts: number;
}

/** Rust `notifications::NotificationInput` 同构（notify_insert 载荷，snake_case）。 */
export interface NotificationInput {
  kind: string;
  severity: Notification["severity"];
  host_id: number | null;
  title_key: string;
  body: string;
  payload: unknown;
}

/** Rust `history::HistoryEntry` 同构（Task 15，⌘R 历史行）。
 * command 存 OSC133 提取的原样文本（含提示符原文——消费侧剥离是保守启发式，
 * 见 src/history/format.ts）；exit_code 可空（shell 未上报）；明文面。 */
export interface HistoryEntry {
  id: number;
  host_id: number;
  command: string;
  cwd: string | null;
  exit_code: number | null;
  session_id: string | null;
  /** 秒级 Unix 时间。 */
  ts: number;
}

/** Rust `history::HistoryInput` 同构（history_insert 载荷，snake_case）。 */
export interface HistoryInput {
  host_id: number;
  command: string;
  cwd: string | null;
  exit_code: number | null;
  session_id: string | null;
}

/** Rust `summaries::SummaryEntry` 同构（Phase 2 Task 7 会话纪要行）。
 * summary 为开封后的明文（密文只在 summary_enc 列，list 单点出库）；明文面
 * 消费方是 ⌘R 纪要页签。 */
export interface SummaryEntry {
  id: number;
  host_id: number;
  session_id: string;
  summary: string;
  /** 摘要覆盖的命令条数（面板徽标 + 溯源面）。 */
  command_count: number;
  /** 秒级 Unix 时间（upsert 时 = 最新一次生成时刻）。 */
  ts: number;
}

/** Rust `summaries::SummaryInput` 同构（summary_insert 载荷，snake_case）。 */
export interface SummaryInput {
  host_id: number;
  session_id: string;
  summary: string;
  command_count: number;
}

// --- 会话录制（Phase 3 Task 5，B3；Rust recordings.rs + commands/recording.rs）---

/** Rust `recordings::RecordingEntry` 同构（录制元数据行；asciinema 原始流在
 * path 指向的 .cast 文件，不入库；明文面）。 */
export interface RecordingEntry {
  id: number;
  host_id: number;
  path: string;
  /** 秒（浮点；空录制 = 0）。 */
  duration: number;
  /** FTS 索引指针 `recordings_fts:{id}`。 */
  text_index_path: string;
  created_at: number;
}

/** Rust `recordings::RecordingHit` 同构（entry 展平 + 命中上下文窗口）。 */
export interface RecordingHit extends RecordingEntry {
  snippet: string;
}

/** Rust `recording_read` 载荷（`commands::recording::RecordingData` 同构）：
 * v2 解析后的 header + 事件流（回放器取数面；事件已过合法性校验）。 */
export interface RecordingData {
  entry: RecordingEntry;
  header: { version: number; width: number; height: number; timestamp: number };
  events: { time: number; data: string }[];
  duration: number;
}

// --- 告警规则（Phase 3 Task 3，B5；Rust alert_rules.rs + commands ar_*）-------

/** 规则类别（Rust RULE_KINDS / DB CHECK 同集）。log = 日志关键字——Phase 3
 * MVP 裁定延后（评估引擎不实现，CRUD 存储面放行），见 task-3 报告。 */
export type AlertRuleKind = "disk" | "cpu" | "process" | "log";

/** 类别参数（JSON 对象，Rust 层只保证是对象；字段面按 kind 归引擎消费）：
 * disk { mount?, threshold }、cpu { threshold, consecutive }、
 * process { comm }。 */
export type AlertRuleParams = Record<string, unknown>;

/** Rust `alert_rules::AlertRule` 同构（serde 面无密钥字段；params/channels
 * 出库即解析后形态）。 */
export interface AlertRule {
  id: number;
  host_id: number;
  kind: AlertRuleKind;
  params: AlertRuleParams;
  /** 订阅渠道 id 数组（notify_channels.id；③外部渠道按此路由）。 */
  channels: number[];
  /** 同规则再次告警最小间隔（秒；0 = 只用管线全局 60s 聚合）。 */
  rate_limit: number;
  /** "HH:MM-HH:MM" 静音窗（本地时区可跨午夜；null = 不静音）。 */
  mute_window: string | null;
  /** 最近触发时刻（秒级 Unix；null = 从未触发）。 */
  last_fired: number | null;
  created_at: number;
  updated_at: number;
}

/** Rust `alert_rules::AlertRuleInput` 同构（create/update 全量替换式提交）。 */
export interface AlertRuleInput {
  host_id: number;
  kind: AlertRuleKind;
  params: AlertRuleParams;
  channels: number[];
  rate_limit: number;
  mute_window: string | null;
}

// --- 通知渠道（Phase 3 Task 3，B5；Rust notify_channels.rs + commands nc_*）---

/** 渠道类别（Rust CHANNEL_KINDS / DB CHECK 同集 12 种，spec §3 全矩阵）。 */
export type ChannelKind =
  | "dingtalk"
  | "feishu"
  | "wecom"
  | "bark"
  | "serverchan"
  | "telegram"
  | "discord"
  | "slack"
  | "smtp"
  | "pushover"
  | "ntfy"
  | "webhook";

/** Rust `notify_channels::NotifyChannel` 同构——不含任何密钥材料
 * （config_enc 不进结构体；明文 config 只经 nc_reveal_config 单点出库）。 */
export interface NotifyChannel {
  id: number;
  kind: ChannelKind;
  /** 渠道级文案覆写（可空 JSON 对象；webhook body 模板等）。 */
  template_overrides: Record<string, unknown> | null;
  /** 启用位（禁用 = 挂载层跳过挂载）。 */
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

/** Rust `notify_channels::NotifyChannelInput` 同构（config 为明文 JSON 对象，
 * 存储层整体密封）。 */
export interface NotifyChannelInput {
  kind: ChannelKind;
  config: Record<string, unknown>;
  template_overrides: Record<string, unknown> | null;
  enabled: boolean;
}

/** Rust `notify_channels::NotifyChannelPatch` 同构：config null = 保留现值
 * （未重输的 token 不重密封）；template_overrides 用嵌套 null 区分
 * 「不改」（undefined 不传）/「清空」（null）。 */
export interface NotifyChannelPatch {
  kind: ChannelKind | null;
  config: Record<string, unknown> | null;
  template_overrides: Record<string, unknown> | null;
  enabled: boolean | null;
}

/** Rust `vault_upgrade_to_master_password` 进度事件载荷（ottr://reencrypt-progress）。 */
export interface ReencryptProgress {
  done: number;
  total: number;
}

// --- 端口转发（Phase 2 Task 1，B7 上半；Rust commands/forward.rs）-------------

export type ForwardKind = "local" | "remote" | "dynamic";

/** 运行态（Rust ForwardRuntimeView 同构）。state：starting/active/error/stopped。 */
export interface ForwardRuntime {
  session_id: string;
  state: "starting" | "active" | "error" | "stopped";
  error: string | null;
  /** 写入 SSH 方向字节（客户端→目标）。 */
  tx_bytes: number;
  /** 读出 SSH 方向字节（目标→客户端）。 */
  rx_bytes: number;
  connections: number;
  conn_errors: number;
  /** 实际绑定端口（bind_port=0 时为分配值）。 */
  bound_port: number;
}

/** Rust `PortForwardView` 同构：配置 + 运行态拼接（runtime=null = 未运行）。 */
export interface PortForwardView {
  id: number;
  host_id: number;
  host_name: string;
  kind: ForwardKind;
  bind_addr: string;
  /** 0 = 本机动态分配（local）/ 服务端选择（remote）。 */
  bind_port: number;
  target_host: string | null;
  target_port: number | null;
  enabled: boolean;
  auto_reconnect: boolean;
  runtime: ForwardRuntime | null;
}

/** Rust `PortForwardInput` 同构（create/update 载荷；dynamic 的 target 传 null）。 */
export interface PortForwardInput {
  host_id: number;
  kind: ForwardKind;
  bind_addr: string;
  bind_port: number;
  target_host: string | null;
  target_port: number | null;
  enabled: boolean;
  auto_reconnect: boolean;
}

// --- 跳板链（Phase 2 Task 2，B7 下半；Rust commands/jump.rs）----------------

/** Rust `entities::JumpChain` 同构：hops = host_id 有序数组（顺序即连接序，
 * 末位之后接 target = 引用本链的 hosts 行）。 */
export interface JumpChain {
  id: number;
  name: string;
  hops: number[];
  created_at: number;
  updated_at: number;
}

/** Rust `entities::JumpChainInput` 同构（create/update 全量替换式提交）。 */
export interface JumpChainInput {
  name: string;
  hops: number[];
}

/** Rust `jump::JumpTestResult` 同构（jc_test 载荷）。hop = 失败跳序号
 * （0 起，末位索引 = target；null = 非跳点失败如超时）。 */
export interface JumpTestResult {
  ok: boolean;
  hop: number | null;
  error: string | null;
  elapsed_ms: number;
}

// --- MCP server（Phase 4 Task 3，C1；Rust commands/mcp.rs）-------------------

/** Rust `commands::mcp::McpGrant` 同构：主机粒度授权矩阵（无授权行 = 默认拒）。 */
export interface McpGrant {
  id: number;
  host_id: number;
  /** list_hosts 可见位（0 = 该主机对 MCP 客户端完全不可见）。 */
  can_list: boolean;
  /** exec_command 放行位。 */
  can_exec: boolean;
  /** 逐次执行审批门（1 = 每次 exec 先弹 UI 审批框，超时/拒绝 = 不执行）。 */
  exec_approval: boolean;
  /** read_file 目录白名单（绝对路径数组；空 = read_file 一律拒绝）。 */
  read_paths: string[];
  created_at: number;
  updated_at: number;
}

/** Rust `mcp_grants::McpGrantInput` 同构（upsert 全量替换式提交）。 */
export interface McpGrantInput {
  host_id: number;
  can_list: boolean;
  can_exec: boolean;
  exec_approval: boolean;
  read_paths: string[];
}

/** Rust `commands::mcp::McpStatus` 同构（设置页首屏快照）。 */
export interface McpStatus {
  enabled: boolean;
  listening: boolean;
  socket_path: string | null;
  approvals_pending: number;
  grants_count: number;
}

/** ottr://mcp-approval 事件载荷（Rust McpApprovalAsk 同构）。 */
export interface McpApprovalAsk {
  request_id: number;
  host_id: number;
  host_name: string;
  command: string;
}

export const vaultApi = {
  hosts: {
    list: () => invoke<Host[]>("hosts_list"),
    get: (id: number) => invoke<Host | null>("hosts_get", { id }),
    create: (input: HostInput) => invoke<Host>("hosts_create", { input }),
    update: (id: number, input: HostInput) => invoke<Host>("hosts_update", { id, input }),
    remove: (id: number) => invoke<void>("hosts_delete", { id }),
    /** groupId=null 查未分组主机。 */
    listByGroup: (groupId: number | null) => invoke<Host[]>("hosts_list_by_group", { groupId }),
    /** 空查询返回全量；≥3 字符 FTS trigram，超短 LIKE 兜底（Rust 层分派）。 */
    search: (query: string) => invoke<Host[]>("hosts_search", { query }),
  },
  /** ssh-config 导入（path=null → ~/.ssh/config）。报告供导入完成对话框展示。 */
  importSshConfig: (path: string | null) =>
    invoke<ImportReport>("import_ssh_config", { path }),
  /** Xshell 会话目录导入（Phase 2 Task 10；path=null → Windows 惯例会话目录，
   * 不存在时命令报错——mac/Linux 需显式传目录）。报告同构 ssh-config。 */
  importXshellSessions: (path: string | null) =>
    invoke<ImportReport>("import_xshell_sessions", { path }),
  /** Tabby 配置 JSON 导入（Phase 2 Task 10；path 必传——文件对话框选定）。 */
  importTabbyConfig: (path: string) =>
    invoke<ImportReport>("import_tabby_config", { path }),
  /** CSV 导出（path=null → 系统下载目录 ottr-hosts.csv），返回落盘路径。 */
  exportHostsCsv: (path: string | null) => invoke<string>("export_hosts_csv", { path }),
  credentials: {
    list: () => invoke<Credential[]>("credentials_list"),
    get: (id: number) => invoke<Credential | null>("credentials_get", { id }),
    create: (input: CredentialInput) => invoke<Credential>("credentials_create", { input }),
    update: (id: number, patch: CredentialPatch) =>
      invoke<Credential>("credentials_update", { id, patch }),
    remove: (id: number) => invoke<void>("credentials_delete", { id }),
    /** 明文单点出库（Rust Credentials::reveal）。 */
    reveal: (id: number, field: SecretField) =>
      invoke<string | null>("credentials_reveal", { id, field }),
  },
  hostGroups: {
    list: () => invoke<HostGroup[]>("host_groups_list"),
    create: (name: string, parentId: number | null, color: string | null) =>
      invoke<HostGroup>("host_groups_create", { name, parentId, color }),
    update: (id: number, name: string, parentId: number | null, color: string | null) =>
      invoke<HostGroup>("host_groups_update", { id, name, parentId, color }),
    remove: (id: number) => invoke<void>("host_groups_delete", { id }),
  },
  snippets: {
    list: () => invoke<Snippet[]>("snippets_list"),
    get: (id: number) => invoke<Snippet | null>("snippets_get", { id }),
    search: (query: string) => invoke<Snippet[]>("snippets_search", { query }),
    create: (input: SnippetInput) => invoke<Snippet>("snippets_create", { input }),
    update: (id: number, input: SnippetInput) => invoke<Snippet>("snippets_update", { id, input }),
    remove: (id: number) => invoke<void>("snippets_delete", { id }),
  },
  knownHosts: {
    list: () => invoke<KnownHost[]>("known_hosts_list"),
    /** hostKey = "address:port"（Rust host_endpoint_key 同口径，见 KnownHost 注）。 */
    upsert: (hostKey: string, fingerprint: string) =>
      invoke<KnownHost>("known_hosts_upsert", { hostKey, fingerprint }),
    verify: (hostKey: string, fingerprint: string) =>
      invoke<KnownHost>("known_hosts_verify", { hostKey, fingerprint }),
    markChanged: (hostKey: string, fingerprint: string) =>
      invoke<KnownHost>("known_hosts_mark_changed", { hostKey, fingerprint }),
    /** 删除 = 忘记该端点（B9 管理页）：下次连接重走 TOFU。返回是否有行被删。 */
    remove: (hostKey: string) => invoke<boolean>("known_hosts_delete", { hostKey }),
    /** 单端点探测（管理页「检查」取证面）：观测到的指纹集；空集 = 不可达。 */
    probe: (hostKey: string) => invoke<string[]>("known_hosts_probe", { hostKey }),
    /** 手动全量巡检一轮（探测 + changed 落账 + 通知事件），返回巡检回执。 */
    auditRun: () => invoke<HostKeyAuditOutcome>("known_hosts_audit_run"),
  },
  /** 密钥管理（Task 6，A4；Rust 侧 src-tauri/src/keys.rs）。
   * 导出调用契约（裁定 #2）：加密私钥必须先经 keyInspect 验证 passphrase
   * 通过后才允许 keyExport——主密码模式 Task 11 落地后在此收口升级。 */
  keys: {
    /** algorithm ∈ KeyAlgorithm；passphrase 空/缺省 = 不加密。RSA-4096 生成耗时秒级～数十秒。 */
    generate: (algorithm: KeyAlgorithm, passphrase: string | null, comment: string | null) =>
      invoke<KeyMaterial>("key_generate", { algorithm, passphrase, comment }),
    /** 解析 openssh 私钥（导入预览 / 导出前 passphrase 校验）。加密钥缺/错口令 → reject。 */
    inspect: (pem: string, passphrase: string | null) =>
      invoke<KeyMaterial>("key_inspect", { pem, passphrase }),
    /** 导出私钥 PEM（0600）。path=null → 下载目录 ottr-key-<ts>.pem，返回落盘路径。 */
    export: (pem: string, path: string | null) => invoke<string>("key_export", { pem, path }),
    /** 部署公钥到主机（幂等 exec 追加 authorized_keys）；认证材料从 vault 服务端取，明文不过前端。 */
    deploy: (authCredentialId: number, address: string, port: number, username: string, publicKey: string) =>
      invoke<KeyDeployReport>("key_deploy", {
        authCredentialId,
        address,
        port,
        username,
        publicKey,
      }),
  },
  /** 安全底座（T11，A7）：锁定状态机 / 主密码升级 / settings / 剪贴板。
   * 事件契约：ottr://vault-locked、ottr://vault-unlocked（Rust 侧统一发）；
   * ottr://reencrypt-progress（升级进度）。命令面锁定时报 "vault is locked..."。 */
  security: {
    status: () => invoke<SecurityStatus>("vault_security_status"),
    unlock: (password: string) => invoke<void>("vault_unlock", { password }),
    lock: () => invoke<void>("vault_lock"),
    /** keyring → password 升级（重加密迁移）；resolve = 完成并返回重密封字段数。 */
    upgradeToMasterPassword: (password: string) =>
      invoke<number>("vault_upgrade_to_master_password", { password }),
    /** 重置应用（product-ready T5，BL-537 清偿）：清本机库 + 清钥匙链条目后
     * 进程重启回首启链。resolve 永不发生（进程重启，invoke 随 webview 销毁）
     * ——reject = 清库失败（钥匙链拒绝/目录删不掉），数据未成功清除可重试。
     * Rust 侧 confirm 门卫：不带显式 confirm=true 一律拒绝，不动任何数据。 */
    reset: () => invoke<void>("vault_reset", { confirm: true }),
  },
  /** settings 表 JSON 读写（明文面：锁定可读——锁定屏要读主题/安全配置）。 */
  settings: {
    get: <T = unknown>(key: string) => invoke<T | null>("settings_get", { key }),
    set: (key: string, value: unknown) => invoke<void>("settings_set", { key, value }),
  },
  /** 通知中心（Task 12，spec §7①）：明文面命令（锁定可读写，Rust 侧不过门卫）。
   * 事件源接线与管线在 src/notify/core.ts；本组只是表的类型化 invoke 面。 */
  notifications: {
    insert: (input: NotificationInput) => invoke<Notification>("notify_insert", { input }),
    /** 最近通知（ts DESC）；limit 缺省 200（Rust 侧 unwrap_or）。 */
    list: (limit?: number) => invoke<Notification[]>("notify_list", { limit: limit ?? null }),
    /** 标记已读；id=null = 全部已读。返回受影响行数。 */
    markRead: (id: number | null) => invoke<number>("notify_mark_read", { id }),
    /** 清空全部，返回删除行数。 */
    clear: () => invoke<number>("notify_clear"),
    unreadCount: () => invoke<number>("notify_unread_count"),
  },
  /** 命令历史（Task 15，spec §5 统一历史搜索 ⌘R）：明文面命令（锁定可读写，
   * 同 notifications 锁定语义）。写入源 = CommandWatch 命令完成事件
   * （src/history/record.ts fire-and-forget）；检索 ≥3 字符 FTS trigram /
   * 超短 LIKE 兜底（Rust 层分派，同 hosts_search 语义）。 */
  history: {
    insert: (input: HistoryInput) => invoke<HistoryEntry>("history_insert", { input }),
    /** query 空白 = 最近记录（面板初始态）；hostId=null 跨主机；limit 缺省 50。 */
    search: (query: string, hostId: number | null, limit?: number) =>
      invoke<HistoryEntry[]>("history_search", {
        query,
        hostId,
        limit: limit ?? null,
      }),
    /** 会话命令序列（Task 7 纪要数据源）：id 升序（≈ts 时序）；limit 缺省 200。 */
    listSession: (hostId: number, sessionId: string, limit?: number) =>
      invoke<HistoryEntry[]>("history_list_session", {
        hostId,
        sessionId,
        limit: limit ?? null,
      }),
  },
  /** 会话纪要（Phase 2 Task 7，B1）：摘要密文面（AES-256-GCM 密封落盘、锁定即
   * 拒，同 secrets）。写入源 = 会话断开时的后台生成链（src/ai/summary.ts
   * fire-and-forget）；读取面 = ⌘R 面板「纪要」页签。 */
  summaries: {
    insert: (input: SummaryInput) => invoke<SummaryEntry>("summary_insert", { input }),
    /** 最近纪要（id DESC）；hostId=null 跨主机；limit 缺省 50。 */
    list: (hostId: number | null, limit?: number) =>
      invoke<SummaryEntry[]>("summary_list", { hostId, limit: limit ?? null }),
  },
  /** secrets 密文 KV（Task 13，AI BYOK）：provider api key 等，AES-256-GCM 密封
   * 落盘、锁定即拒（"vault is locked..."）。key 逻辑名 = `ai.apikey.<providerId>`。
   * 明文只在内存短暂存在（组装请求头），永不落 settings/日志。 */
  secrets: {
    set: (key: string, value: string) => invoke<void>("secret_set", { key, value }),
    get: (key: string) => invoke<string | null>("secret_get", { key }),
    delete: (key: string) => invoke<void>("secret_delete", { key }),
    /** 存在性（不派生明文——设置页「已保存」标记）。 */
    contains: (key: string) => invoke<boolean>("secret_contains", { key }),
  },
  /** 告警规则（Phase 3 Task 3，B5）：vault 配置面（锁定即拒，同 hosts）。
   * 评估引擎在 src/notify/rules.ts（数据源 ottr://monitor + monitor_ps）。 */
  alertRules: {
    list: () => invoke<AlertRule[]>("ar_list"),
    create: (input: AlertRuleInput) => invoke<AlertRule>("ar_create", { input }),
    update: (id: number, input: AlertRuleInput) => invoke<AlertRule>("ar_update", { id, input }),
    remove: (id: number) => invoke<void>("ar_delete", { id }),
    /** 触发水位回写（引擎放行一条告警时调用）。 */
    touchFired: (id: number, ts: number) => invoke<void>("ar_touch_fired", { id, ts }),
  },
  /** 通知渠道（Phase 3 Task 3，B5）：vault 密文面（config_enc 已登记
   * scan_registry，锁定即拒）。reveal 后的明文 config 只在内存短暂存在
   * （适配器组装请求），永不落日志/明文存储。 */
  notifyChannels: {
    list: () => invoke<NotifyChannel[]>("nc_list"),
    create: (input: NotifyChannelInput) => invoke<NotifyChannel>("nc_create", { input }),
    update: (id: number, patch: NotifyChannelPatch) =>
      invoke<NotifyChannel>("nc_update", { id, patch }),
    remove: (id: number) => invoke<void>("nc_delete", { id }),
    /** 明文 config 单点出库（测试发送/管线挂载取一次）。 */
    revealConfig: (id: number) => invoke<Record<string, unknown>>("nc_reveal_config", { id }),
  },
  /** 会话录制（Phase 3 Task 5，B3）：start/stop = 运行面（会话表槽位 tee），
   * list/search/read/delete/export = vault 明文面 + .cast 文件面（同 history
   * 锁定语义）。导出经前端 redact（T13），原文导出需二次确认。 */
  recordings: {
    start: (rustId: string, hostId: number) => invoke<string>("recording_start", { rustId, hostId }),
    stop: (rustId: string) => invoke<RecordingEntry>("recording_stop", { rustId }),
    list: (hostId: number | null, limit?: number) =>
      invoke<RecordingEntry[]>("recording_list", { hostId, limit: limit ?? null }),
    search: (query: string, hostId: number | null, limit?: number) =>
      invoke<RecordingHit[]>("recording_search", { query, hostId, limit: limit ?? null }),
    read: (id: number) => invoke<RecordingData>("recording_read", { id }),
    remove: (id: number) => invoke<void>("recording_delete", { id }),
    /** 导出（events 已按需脱敏；path=null = 下载目录默认名）。返回落盘路径。 */
    export: (id: number, events: { time: number; data: string }[], path: string | null) =>
      invoke<string>("recording_export", { id, events, path }),
  },
  /** SMTP 渠道发送（Phase 3 Task 3，B5；Rust lettre，commands/notify.rs）：
   * 分发与「发送测试」共用（测试 = 固定测试主题正文真发）。 */
  smtpSend: (config: unknown, to: string, subject: string, body: string) =>
    invoke<void>("smtp_send", { config, to, subject, body }),
  /** 端口转发（Phase 2 Task 1，B7 上半；Rust commands/forward.rs）。
   * list/create/update/delete/setEnabled = vault 配置面（锁定即拒，同 hosts）；
   * start/stop = 运行面（ForwardManager；start 需 rustId 会话在线）。 */
  portForwards: {
    list: (hostId: number | null) => invoke<PortForwardView[]>("pf_list", { hostId }),
    create: (input: PortForwardInput) => invoke<PortForwardView>("pf_create", { input }),
    update: (id: number, input: PortForwardInput) =>
      invoke<PortForwardView>("pf_update", { id, input }),
    remove: (id: number) => invoke<void>("pf_delete", { id }),
    setEnabled: (id: number, enabled: boolean) =>
      invoke<void>("pf_set_enabled", { id, enabled }),
    /** 在指定会话上启动；未知会话/配置缺失 → reject（前端提示先连接主机）。 */
    start: (id: number, sessionId: string) =>
      invoke<ForwardRuntime>("pf_start", { id, sessionId }),
    stop: (id: number) => invoke<boolean>("pf_stop", { id }),
  },
  /** 跳板链（Phase 2 Task 2，B7 下半；Rust commands/jump.rs）。
   * list/create/update/remove = vault 配置面（锁定即拒，同 hosts）；
   * test = 连接面（jc_test：按传入 hop 序列建真实链，末位当 target，
   * 逐跳 TOFU 会弹确认框；成功即拆不留连接）。 */
  jumpChains: {
    list: () => invoke<JumpChain[]>("jc_list"),
    create: (input: JumpChainInput) => invoke<JumpChain>("jc_create", { input }),
    update: (id: number, input: JumpChainInput) =>
      invoke<JumpChain>("jc_update", { id, input }),
    remove: (id: number) => invoke<void>("jc_delete", { id }),
    test: (hops: number[]) => invoke<JumpTestResult>("jc_test", { hops }),
  },
  /** 会话输出尾部（Task 13，AI 诊断取数面）：最后 bytes 字节的剥 ANSI 纯文本。
   * 未知会话（已关/重连中）显式报错——调用方 catch 降级（空输出照发诊断）。 */
  sessionTail: (id: string, bytes: number) => invoke<string>("session_tail", { id, bytes }),
  /** MCP server（Phase 4 Task 3，C1；commands/mcp.rs）。status/setEnabled =
   * 运行面（锁定可读——listener 生命周期独立于锁定）；grants = 配置面
   * （过锁定门卫，同 hosts）；approvalDecision = 审批框裁定回传。 */
  mcp: {
    status: () => invoke<McpStatus>("mcp_status"),
    setEnabled: (enabled: boolean) => invoke<McpStatus>("mcp_set_enabled", { enabled }),
    grantsList: () => invoke<McpGrant[]>("mcp_grants_list"),
    grantsUpsert: (input: McpGrantInput) => invoke<McpGrant>("mcp_grants_upsert", { input }),
    grantsDelete: (id: number) => invoke<void>("mcp_grants_delete", { id }),
    approvalDecision: (requestId: number, allow: boolean) =>
      invoke<boolean>("mcp_approval_decision", { requestId, allow }),
  },
  /** 凭据密文复制（Rust 侧解密写剪贴板 + 定时清空；明文不回前端）。 */
  copyCredentialSecret: (id: number, field: SecretField) =>
    invoke<void>("vault_copy_credential_secret", { id, field }),
};
