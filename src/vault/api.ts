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
//       import_ssh_config export_hosts_csv（Task 5 导入/导出）
//       key_generate key_inspect key_export key_deploy（Task 6 密钥管理，src-tauri keys.rs）
//   * 顶层 invoke 参数走 Tauri v2 的 camelCase 约定（groupId / hostGroups...）；
//     载荷对象内部（HostInput 等）是 serde 反序列化面，保持 snake_case。
//
// 明文密钥纪律：Credential 类型不含任何密钥字段；明文只能经 credentials.reveal
// 单点取回（对应 Rust Credentials::reveal），列表/详情永不携带密钥材料。
// 检索语义由 Rust 层保证：≥3 字符走 FTS5 trigram MATCH，超短查询 LIKE 兜底
// （task-3 实测：trigram 对 <3 字符的 MATCH 恒 0 行），前端无需分派。

import { invoke } from "@tauri-apps/api/core";

export type CredentialKind = "password" | "key" | "totp";
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
  credential_id: number | null;
  jump_chain_id: number | null;
  encoding_override: string | null;
  theme_override: string | null;
  monitor_enabled: boolean;
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
  credential_id: number | null;
  jump_chain_id: number | null;
  encoding_override: string | null;
  theme_override: string | null;
  monitor_enabled: boolean;
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

/** Rust `entities::KnownHost` 同构（以 fingerprint 为主键）。 */
export interface KnownHost {
  fingerprint: string;
  first_seen: number;
  verified: boolean;
  changed_at: number | null;
  state: KnownHostState;
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
    upsert: (fingerprint: string) => invoke<KnownHost>("known_hosts_upsert", { fingerprint }),
    verify: (fingerprint: string) => invoke<KnownHost>("known_hosts_verify", { fingerprint }),
    markChanged: (fingerprint: string) =>
      invoke<KnownHost>("known_hosts_mark_changed", { fingerprint }),
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
};
