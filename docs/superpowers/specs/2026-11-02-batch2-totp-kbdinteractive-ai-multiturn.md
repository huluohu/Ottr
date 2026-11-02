# 批次二设计规范：TOTP 生成器 + keyboard-interactive 全链路 + AI 多轮追问会话

**日期**：2026-11-02
**分支**：`feat/batch2-totp-kbdinteractive-ai-multiturn`
**前置**：批次一已合入并发布 v1.6.0

## 1. 目标与三项拍板决定

本批次交付三项能力：**TOTP 验证码生成**、**keyboard-interactive 交互式登录**、**AI 多轮追问会话**。

四项语义岔路用户未作答，按推荐项落地（**均为可裁定的实现决定，若与预期不符请指出**）：

| # | 决定 | 落地形态 | 推翻成本 |
|---|---|---|---|
| D1 | TOTP 认证模型 | 主机绑 TOTP 凭据 → 连接走 keyboard-interactive，多轮提问由 Ottr 弹窗作答，**验证码由 Ottr 自动生成填入**，密码在弹窗手输 | 高（换模型要动 schema） |
| D2 | 多轮 UI 形态 | **诊断面板底部加输入条**，历史消息改气泡流（面板宽 400px 偏窄，但改造量最小、与现有面板一体） | 中（可后换独立面板） |
| D3 | 追问上下文范围 | **只带对话历史**（首轮的命令/输出尾/主机备注已在首轮发过，不重复出网）；对话历史本身脱敏后存储 | 低 |
| D4 | Markdown 渲染 | 引入 **react-markdown + remark-gfm**（**不引入 rehype-raw** → 原始 HTML 一律转义显示，天然无 XSS 面） | 低（可换自研） |

## 2. 跨平台交付审计表

| 平台 | 行为差异 | 落点 | 兜底 |
|---|---|---|---|
| **macOS** | TOTP 生成纯计算无差异；keyboard-interactive 弹窗为应用内模态 | 同三端 | — |
| **Windows** | 同上 | 同三端 | — |
| **Linux** | 同上；WebKitGTK 下模态焦点回收需验证（`useFocusTrap` 已有 WKWebView 吞 focus 的历史坑） | 同三端 | 真机 192.168.9.102 走查 |

**共同纪律**：
- TOTP 生成器为**纯本地计算**，绝不联网；密钥只在 Rust 侧解密，前端只拿到当前 6 位码；
- keyboard-interactive 问答采用 **fail-closed**：超时/取消/槽位缺失一律判认证失败，绝不放行；
- 无新增 `#[cfg]` 分支、无新增系统库链接 → 三端编译面一致。

## 3. 设计

### 3.1 TOTP 生成器（新 crate `crates/ottr-totp`）

RFC 6238 / RFC 4226 标准实现：

```
secret(base32 字符串) → normalize(去空白/大写/补 padding) → base32 解码 → HMAC-SHA1
  → 动态截断(6 位) → TOTP(time/30)
```

**依赖选型（关键：零新增 crate）**：`data-encoding = "2"`（base32）、`sha1 = "0.11"`、`hmac = "0.13"`——三者**均已在 `Cargo.lock` 里**（russh / ssh-key 的传递依赖），提为直接依赖**不引入任何新 crate**。

> ⚠️ 依赖版本陷阱：`sha2 = "0.10"`（workspace 现有）走 digest 0.10，与 `hmac 0.13`/`sha1 0.11` 的 digest 0.11 **不兼容**。TOTP 走 HMAC-SHA1（RFC 6238 强制），不碰 sha2，天然避开此分叉。

**公开 API**：
```rust
pub struct TotpSecret { bytes: Vec<u8> }        // 已解码的种子
impl TotpSecret {
    pub fn from_base32(raw: &str) -> Result<Self, TotpError>;  // normalize + 解码
}
pub fn generate(secret: &TotpSecret, unix_time: i64, digits: u32, period: u64) -> Result<String, TotpError>;
pub fn remaining_seconds(unix_time: i64, period: u64) -> u64;
```
- `unix_time` 显式传入 → **可确定性测试**（不依赖系统时钟）；
- digits 默认 6、period 默认 30。

**错误类型**：`TotpError::InvalidBase32` / `EmptySecret` / `BadLength`（不足 80 bit 种子）。

### 3.2 keyboard-interactive 全链路

**范式来源**：仓库已有 TOFU 问询全链路（`hostkey.rs`）——事件发出 → 阻塞等待 → 前端裁定 → 命令回传，本功能**逐字同构**。

| 层 | 落点 | 说明 |
|---|---|---|
| Rust 状态 | `desktop/src/commands/state.rs` 新增 `PromptAsks = Arc<Mutex<HashMap<String, Sender<Vec<String>>>>>` + `PROMPT_ASK_TIMEOUT`（**必须 < connect 预算 75s**，取 60s 与 TOFU 对齐） | 与 `HostKeyAsks` 同构 |
| Rust 提问 | 新模块 `desktop/src/commands/session/kbdint.rs`：`keyboard_interactive_responder(vault, app, asks, credential_id, host_id, host_name) -> PromptResponder` | 闭包内：register 槽位 → `app.emit("ottr://kbd-interactive-ask", payload)` → `block_in_place(\|\| rx.recv_timeout(PROMPT_ASK_TIMEOUT))` |
| Rust 接线 | `desktop/src/keys.rs` 的 `CredentialKind::Totp` 分支：reveal `SecretField::TotpSecret` → 构造 `AuthMethod::KeyboardInteractive { responder }`；**签名扩参**（`app` + `asks`） | 现签名 `(vault, credential_id)` 无 AppHandle → 需扩，影响 4 个调用点（`keys.rs` 部署、`attach.rs` 直连/链式、`jump.rs` 跳板） |
| Rust 回传 | 新命令 `kbd_interactive_answer(session_id, answers: Vec<String>)` | 槽位不存在 → 报错不落账（同 TOFU `apply_host_key_decision`） |
| 前端事件 | `frontend/session/events.ts` 监听 `ottr://kbd-interactive-ask` → SessionStore 新增 `promptAsk` 态 | 与 `onHostKeyAsk` 同构 |
| 前端 UI | 新组件 `frontend/session/PromptDialog.tsx`：逐项输入 + **TOTP 码自动填入** | 模态单槽需在 `modalStore.ts` 加 id |
| TOTP 自动填 | 判定 prompt 含「code/verification/验证码/otp」→ 取该主机绑定的 TOTP 凭据 → 调 Rust 命令取当前码 → 填入 | 需新增 Tauri 命令 `credential_totp_code(credential_id)`（Rust 侧解密 + 生成，明文码只回前端一次） |

**多轮问答**：`keyboard_interactive_auth`（`auth.rs:161-190`）本身是 `loop`，支持 N 轮；每轮发一次事件、前端回一组答案。`answers.len()` 必须等于 `prompts.len()`（`auth.rs:178-183`）。

**答案数不匹配的兜底**：服务器下发 2 个 prompt（如「密码:」「验证码:」）→ 前端渲染 2 个输入框。

### 3.3 AI 多轮追问会话

**store 改造**（`frontend/ai/aiStore.ts`）：
```ts
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}
export interface SessionAiState {
  ...              // 既有字段
  messages: ChatTurn[];   // 追加：对话历史（脱敏后）
}
```
- `run()` 改为：`messages = [...既有历史, {role:"user", content: 本轮内容}]` → 送 provider → assistant 回复 append；
- **首轮与追问分流**：首轮走既有 `buildUserMessage`（带命令/输出尾/主机备注）；**追问轮只带历史**，不重复取 tail、不重复注入备注（D3）；
- `EMPTY_SLICE` 同步加 `messages: []`。

**面板改造**（`frontend/ai/DiagnosePanel.tsx`）：
- 消息区：历史气泡流（user 右 / assistant 左）；
- 底部输入条：单行 input + 发送/停止按钮（沿用 `NLCommandPanel` 的 rAF 聚焦与 Enter 提交范式）；
- **自动滚动**：流式追加时滚到底部（现有无滚动逻辑 → 新增）；
- 既有单块 `answer` 展示改为「消息流 + 首轮诊断上下文块」共存。

**Markdown 渲染**（D4）：
- 新增 `frontend/ai/Markdown.tsx`：基于 `react-markdown` + `remark-gfm`；
- **不引入 `rehype-raw`** → 原始 HTML 一律转义为文本（无 XSS 面）；
- 代码块围栏仍走既有 `CodeBlockRow`（保留插终端三档确认）——即 Markdown 渲染器负责围栏**之外**的部分，围栏代码块沿用现路径。

**脱敏纪律（D3 落地）**：对话历史**脱敏后存储**（`redact` 在 append 时跑一次），避免敏感文本在 store 里长期驻留。

**通知纪律**：追问属「用户注视中」，沿用 ⌘J 口径**不落通知**（仅首轮诊断落通知）。

**i18n**：`ai.send` / `ai.newChat` / `ai.inputPlaceholder` / `ai.empty` / `ai.copyCode` 五个**已预埋未使用**的键正好复用；新增键（如 `ai.prompt.followup`、`ai.followupPlaceholder`、`ai.newChat`）须 **8 语齐备**（仓库实为 8 语，非 9 语）。

## 4. 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `crates/ottr-totp/Cargo.toml` + `src/lib.rs` | 新增 | RFC 6238 TOTP 生成器（纯计算，可确定性测试） |
| `crates/ottr-totp/tests/totp_test.rs` | 新增 | RFC 6238 官方测试向量 + normalize 边界测试 |
| `Cargo.toml`（根） | 修改 | workspace members 加 `crates/ottr-totp`；workspace.dependencies 加 `data-encoding`/`sha1`/`hmac` |
| `desktop/Cargo.toml` | 修改 | 加 `ottr-totp` 依赖 |
| `desktop/src/commands/state.rs` | 修改 | `PromptAsks` 类型 + `PROMPT_ASK_TIMEOUT` |
| `desktop/src/commands/session/kbdint.rs` | 新增 | 提问闭包工厂 + 回传命令 |
| `desktop/src/commands/session/mod.rs` | 修改 | 导出新命令 |
| `desktop/src/keys.rs` | 修改 | Totp 分支接线；`resolve_credential_auth` 扩参 |
| `desktop/src/commands/session/attach.rs` / `jump.rs` | 修改 | 传 app/asks |
| `desktop/src/lib.rs` | 修改 | 注册新命令 |
| `frontend/session/events.ts` / `types.ts` / `SessionStore.ts` | 修改 | 事件监听 + `promptAsk` 态 + 回传 |
| `frontend/session/PromptDialog.tsx` | 新增 | 交互式提问弹窗 |
| `frontend/ui/modalStore.ts` | 修改 | 新增模态 id |
| `frontend/ai/aiStore.ts` | 修改 | `messages` 字段 + 多轮 `run()` |
| `frontend/ai/DiagnosePanel.tsx` | 修改 | 气泡流 + 输入条 + 自动滚动 |
| `frontend/ai/Markdown.tsx` | 新增 | Markdown 渲染 |
| `frontend/i18n/*.json`（8 语） | 修改 | 新增/复用文案键 |

## 5. 验收门

| 门 | 内容 |
|---|---|
| 单元测试 | TOTP RFC 向量测试；多轮 store 测试；面板输入条测试；Markdown 转义测试 |
| CSS 纪律 | `css-discipline.test.ts` 10 项全绿（圆角/字号/动效零字面值） |
| 构建 | `npm run build` + `cargo check` + `cargo clippy` 零告警 |
| 绑定契约 | `cargo test --test ts_bindings` 绿（新增命令须进 specta 采集表） |
| 三端编译 | CI 矩阵全绿 |
| 真机 | 192.168.9.102 实机走查：TOTP 码生成、keyboard-interactive 弹窗、多轮追问 |
| 交互纪律 | 交互类改动**必须真机 E2E 后才发布** |
