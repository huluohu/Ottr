# 批次一设计规范：AI 备忘注入 · Token 透明化 · known_hosts 导入

**日期**：2026-11-02
**分支**：`feat/ai-notes-token-usage-known-hosts-import`
**上一版本**：v1.6.0（tag 已推送，Release 已发布）

## 1. 目标与边界

本批次交付三项彼此独立、直击真实摩擦的能力：

| 项 | 用户可感知的收益 | 明确不做 |
|---|---|---|
| **A. AI 备忘注入** | 用户在主机「备注」里写下系统版本、服务管理方式、日志路径，AI 诊断 / ⌘J 生成命令时自动知道这台机器的「脾气」 | 不做新的数据库列（复用既有 `hosts.notes`）；不做 per-session 记忆 |
| **B. Token 透明化** | AI 响应底部显示「模型 · 输入/输出 token · 耗时」，BYOK 用户对额度消耗有数 | 不做精确成本账单（价格随时间波动，只做可解释的估算） |
| **C. known_hosts 导入** | 从本机 `~/.ssh/known_hosts` 导入信任锚，老机器首次连接不再逐个弹 TOFU 确认 | 不做多密钥型并存（单锚模型，导入择一）；不改 known_hosts 的同步与导出归属 |

**明确排除**（用户裁定批次一到此为止，后续另批）：TOTP 生成器与 keyboard-interactive 接线、AI 多轮追问会话、Ask Ottr 独立入口、MCP 客户端角色、系统 SSH-Agent 桥接。

## 2. 跨平台交付审计表

| 平台 | 本批次行为差异 | 落点 |
|---|---|---|
| **macOS** | 三项均无平台分支；known_hosts 默认路径 `~/.ssh/known_hosts`（HOME 解析） | `desktop/src/ssh_config.rs` 同款路径解析写法 |
| **Windows** | known_hosts 默认路径 `%USERPROFILE%\.ssh\known_hosts`（USERPROFILE 解析，mac/Linux 惯例 HOME 不可用） | 同上，参照 `desktop/src/ssh_config.rs:84-93` 的 HOME/USERPROFILE 兼容写法 |
| **Linux** | 三项均无平台分支；WebKitGTK 渲染差异仅涉及 AI 面板底部信息行的字号回退 | 无需平台门控 |

**共同纪律**：
- 无新增 Rust `#[cfg]` 分支 → 三端编译面一致，不产生平台专属符号 dead-code 警告；
- 无新增原生依赖（base32/hmac 等属下一批）→ 无系统库链接差异；
- 新增 i18n 键必须 **9 语齐备**（`zh-CN` / `zh-Hant` / `lzh` / `en-US` / `ja` / `ko` / `es` / `it`）。

## 3. 项 A：AI 备忘注入

### 3.1 载体裁定

复用既有 `hosts.notes`（`crates/ottr-vault/migrations/0002_entities.sql:58`，Rust 侧 `crates/ottr-vault/src/entities.rs:624`）。理由：

- 零迁移成本（无需 `0025` 迁移，不动 `scan_registry`）；
- 已在主机表单可编辑（`frontend/hosts/HostForm.tsx:404-408`），用户无需学新入口；
- 已进 FTS 索引（`hosts_fts` 覆盖 name + notes），可被主机搜索命中。

**代价（已知并接受）**：`notes` 会随 SSH Config / CSV / Tabby 导出流到外部工具。缓解：`entities.rs:880-893` 的 `reject_control_chars` 已在导出面拒绝控制字符，AI 备忘本身不应含控制字符。

### 3.2 注入点

新增 `frontend/ai/hostContext.ts`：

```ts
/** 注入 AI 上下文的备忘长度上限（字符）。超出截断——备忘进 prompt 直接
 *  抬高 token 成本，无上限等于让用户用备注页烧自己的额度。 */
export const HOST_CONTEXT_MAX_CHARS = 2048;

/** 备忘 → 注入块（纯函数；脱敏 + 长度裁剪 + 空值剔除）。 */
export function buildHostContextBlock(
  notes: string | null | undefined,
  redactOpts: { hostname: boolean; custom: RedactRule[] },
): { text: string; findings: RedactFinding[] };

/** 按 hostId 取备注（IPC + 进程内缓存；失败一律回落 null，不阻断 AI 链）。 */
export async function fetchHostNotes(hostId: number | null): Promise<string | null>;
```

三个注入点：

1. **诊断 / 解释链**：`frontend/ai/aiStore.ts` 的 `buildUserMessage`（`:132`）——在命令与输出尾之后追加备忘段；
2. **⌘J 生成命令链**：`frontend/ai/nl2cmd.ts` 的 `buildNl2cmdPrompt`（`:32`）——需要补 `hostId` 传参（当前链完全不知道主机）；
3. **会话纪要链**：`frontend/ai/summary.ts` 的 `buildSummaryPrompt`（`:53`）——按 `SessionEndInfo` 的 hostId 取。

### 3.3 脱敏纪律

备忘文本**必须过脱敏引擎**（`frontend/ai/redact.ts:145`），与命令/输出尾同规则集。理由：备忘里极易手写内网地址、主机名、密码片段，而诊断链与纪要链的既有纪律是「上下文一律脱敏后出网」。

⌘J 链的既有纪律是「用户输入与 cwd **不脱敏**原样发端点」（`nl2cmd.ts:5`）——但**主机备忘不属于用户当前输入**，它是被持久化到 vault 的另一份数据，注入时应脱敏。这条区分需在代码注释里写明，避免后来者误以为要一并脱敏输入。

### 3.4 失败语义

取备注失败（IPC 错误 / 主机已删 / 无备注）一律回落「无备忘段」，**绝不阻断 AI 请求**。备忘是增强项，不是前置条件。

## 4. 项 B：Token 消耗 / 耗时 / 模型透明化

### 4.1 协议扩展

`frontend/ai/provider.ts` 的 `ChatDelta` 扩展（**可选字段，向后兼容**）：

```ts
export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatDelta {
  text: string;
  /** 累计用量（拿到即最终值；部分端点全程不给 → undefined）。 */
  usage?: ChatUsage;
  /** 端点回传的模型名（缺失时回落到 settings 快照里的 model）。 */
  model?: string;
  /** 停止原因（end_turn / max_tokens / stop_sequence）。 */
  finishReason?: string;
}
```

### 4.2 双 provider 解析

- **OpenAI 兼容**（`frontend/ai/openai.ts:98-131`）：请求体加 `stream_options: { include_usage: true }`；SSE 末帧读 `usage.prompt_tokens` / `usage.completion_tokens`。**部分国产/代理端点不支持该字段**（可能 400 或静默忽略）→ 必须优雅降级。
- **Anthropic**（`frontend/ai/anthropic.ts:19-64`）：`message_start` 事件给 `usage.input_tokens`，`message_delta` 事件给 `usage.output_tokens`。

**降级纪律**：拿不到 usage 时**不显示 token 数**，只显示模型名与耗时。任何情况下不得因 usage 解析失败而中断整个 AI 响应流（`usage` 解析必须是 try/catch 包裹的旁路，不能污染主循环）。

### 4.3 计时

`aiStore.run()` 与 `nl2cmd.submit()` 在请求发起前后打点（`performance.now()`），按会话/轮次存于 store 切片。

### 4.4 UI

`frontend/ai/DiagnosePanel.tsx` 底部新增一行信息（模型 · 输入 tok · 输出 tok · 耗时）；`NLCommandPanel.tsx` 同样一行。样式遵循 CSS 纪律（圆角/字号/时长全走 token）。

### 4.5 模型名来源

优先级：**响应回传的 `model`** > settings 快照里的 `model`（`DiagnosePanel.tsx:115-127` 现为后者）。响应优先是因为用户可能把同一 provider 的模型改过，端点回传才是当次真实模型。

## 5. 项 C：known_hosts 导入

### 5.1 解析层（新增）

`crates/ottr-ssh/src/known_hosts.rs` 新增：

```rust
/// 解析整份 known_hosts → (host, port, fingerprint) 列表。
/// 复用 line_fingerprint 的 blob 算法（与 ssh-keygen -lf 逐字一致）。
/// 跳过：注释行、`|1|` hashed 条目（不可反解）、`@cert-authority`/`@revoked`
///       marker 行、多余空白行。
pub fn parse_known_hosts_file(content: &str) -> Vec<(String, u16, String)>;
```

- host 列匹配沿用既有 OpenSSH 惯例（`known_hosts.rs:48-52`）：22 端口裸 hostname，其余 `[host]:port`；
- **hashed 条目（`|1|salt|hash`）无法反解 host** → 跳过并在导入报告里计数告知用户。

### 5.2 多密钥型取舍（用户裁定：择一，优先 ed25519）

OpenSSH 每端点可能并存多枚密钥（rsa / ecdsa / ed25519），而 vault 的 `known_hosts` 是**每端点单锚**（`0004_known_hosts_host_binding.sql:31-38`）。导入时按优先级择一：

**ed25519 > ecdsa-sha2-nistp256 > ecdsa-sha2-nistp384 > ecdsa-sha2-nistp521 > ssh-rsa**

（`ssh-rsa` 垫底：SHA-1 已被现代 OpenSSH 默认关闭。）

**已知局限（须在导入报告与用户文档中明示）**：若目标服务器实际出示的是另一种密钥型（例如服务端只配了 rsa），导入的 ed25519 锚与之不匹配 → 仍会触发 `changed` 强提醒。这是单锚模型的固有代价，非缺陷。

### 5.3 落库语义（关键）

导入必须走 **`verify` 语义**（`entities.rs:1241`，state=ok / verified=1），**不得**走 `upsert`（`entities.rs:1223`，state=pending）——后者会导致首次连接照样弹 TOFU 确认框，等于白做。

### 5.4 端点键映射

vault 用 `address:port`（`entities.rs:1120` 的 `host_endpoint_key`），OpenSSH 22 端口用裸 host → 导入时统一映射为 `address:port`。

### 5.5 命令与 UI

- 新增 vault 方法 `KnownHosts::import(vault, entries) -> ImportReport`（`added` / `skipped_hashed` / `skipped_duplicate` / `errors`）；
- 新增 Tauri 命令 `known_hosts_import(path: Option<String>)`（`path=null` → 默认路径）；注册于 `desktop/src/lib.rs:493-502` 附近；
- 前端 `frontend/vault/api.ts:655-671` 的 knownHosts 段加 `import`；
- `frontend/security/KnownHostsManager.tsx` 工具条（既有「立即巡检」旁）加「导入 known_hosts」按钮 + 文件选择（参照 `frontend/hosts/ImportDialog.tsx:76` 的 plugin-dialog 动态引入写法）；
- i18n `knownHosts.*` 段补 9 语词条。

### 5.6 同步与导出的归属（保持现状，明确记录）

known_hosts **不参与**同步（`crates/ottr-vault/src/sync_snapshot.rs:65-74` 的 `SYNC_CATEGORIES` 未含）也**不参与**导出。本批次**不改变**这一归属——信任锚是设备本地的安全状态，同步到云端等于把信任锚发出去，与本批次目标无关，且属安全边界变更，须另案评估。

## 6. 验收门

| 门 | 内容 |
|---|---|
| 单元测试 | 新增项 A/B/C 的纯函数与链路测试；既有 1649 项全绿 |
| CSS 纪律 | `frontend/styles/css-discipline.test.ts` 10 项全绿（圆角/字号/动效时长零字面值） |
| 类型与构建 | `npm run build`（tsc + vite）零错 |
| Rust | `cargo check` + `cargo test`（含 `password_mode_test` 的 `reencrypt_scan_covers_all_enc_columns` 守护） |
| 三端编译 | CI 矩阵（macOS / Windows / Linux）全绿——本批次无 `#[cfg]` 分支，但**仍须等 CI 绿**（跨平台审计纪律） |
| 真机 | 192.168.9.102（Ubuntu 24.04）实机验证 AI 面板底部信息行与 known_hosts 导入按钮；本机 macOS 眼检视觉 |
| 交互纪律 | 交互类改动**必须真机 E2E 后才发布**（jsdom 绿不等于真机可用） |
