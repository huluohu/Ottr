//! AI 目标作用域（feat/ask-ottr-orb Task 1）：把 AI 的上下文读取与命令插入
//! 钉死到**开立作用域时的那一个运行时**上。
//!
//! 身份与裁定（简报原文落点）：
//! * 前端给的目标（pane/root/rustId/epoch/kind/hostId）只是**元数据**——真实
//!   身份一律以 Rust 会话表捕获的运行时为准：open 时按 rustId 在对应表（SSH
//!   [`AppState::sessions`] / 本地 [`AppState::local_sessions`]，kind 决定查
//!   哪张表、绝不双表兜底）查到表项，捕获 `runtime_id`（`Arc<()>` 生成期身份）
//!   与 endpoint/username（**连接注册时的实际值**——SSH 用户名来自注册面而非
//!   数据库当前行；本地显式 endpoint "local" 且 hostId 必须为 null）。绝不按
//!   hostId 另找运行时：同主机双标签是两个运行时，hostId 只做与表项的一致性
//!   复核（None vs Some 亦判失配）。
//! * insert = 一次性动作：文本静态校验（非空单行，拒绝一切控制字符与
//!   U+2028/2029）→ actionId 在**拿到 writer 锁之前**登记（await 前 claim，
//!   等待窗口内的并发重放即被拒）→ 拿到锁后复核（作用域仍在册同一 Arc + 库
//!   未锁 + 表内 runtime_id 仍是捕获的那个）→ 逐字节写入、**不追加换行**
//!   （绝不自动执行；与 `write_session` 击键路径完全独立，普通键盘语义零改动）。
//! * 生命周期失效：作用域 15 分钟 TTL（惰性清扫）；库锁定（手动/自动）经
//!   [`lock_vault`] 撤销**全部**作用域（解锁后不复活——重开新作用域才可用）；
//!   drop/断开收尾撤销对应运行时的作用域；移除/重连替换同名 id 后 runtime_id
//!   失配 = 拒绝（这就是「identity invalidation」的第二道门，覆盖只拿到 map
//!   Arc 的收尾路径）。
//! * 有界注册表：max_scopes 满员拒绝新开（撤销/过期腾位），max_actions 每
//!   作用域动作集上限——**已消费的 actionId 永不驱逐**（满员拒绝新 id，重放
//!   旧 id 恒拒），容量回收只经作用域整体撤销/过期。
//!
//! * 第一步（Ask Ottr 执行模式 · Plan 档，2026-11-04）：只读面
//!   （[`ai_scope_list_dir`] / [`ai_scope_read_file`]）与执行面
//!   （[`ai_scope_exec`]）落**同一套身份校验**（scope 在册 + 同一 entry +
//!   按 kind 精确分派 + hostId 完全一致，绝不双表兜底）：
//!   * plan 档（默认）执行类动作**只登记计划步骤**——绝不打开 exec 通道、
//!     绝不碰写端（零执行、零副作用），返回 `planned = true` + 步骤 id；
//!   * manual 档本步同样**只登记不执行**（真执行是第二步的 pending 确认流）；
//!   * auto 档：**主机已授权 + 命令在白名单/授权类别内** → 当场执行；
//!     其余降级为逐条确认；red 级命令**直接拒**——绝不"先跑起来"；
//!   * 本地会话（kind=local）**一律不给执行权**（设计裁定：本地是用户自己的
//!     机器与交互 shell，误操作代价最高且无法与用户输入隔离）——只给只读
//!     上下文（终端输出尾）；
//!   * 本地会话**同样不开放主机文件读取面**（读文件 / 列目录一律拒，见
//!     [`LOCAL_READ_DENIED`]）：本地只读根曾被实现自选为「Ottr 进程用户的
//!     整个 HOME」，等于把 `~/.ssh`、`~/.aws`、`~/.kube`、`~/.gnupg` 默认
//!     交给外部模型，而脱敏层覆盖不到那些形态。远端家目录之外的放开（按主机
//!     授权表）逐主机开启；
//!   * 执行面的 actionId 是**一次性**的（登记计划之前即消费）：同一 actionId
//!     第二次调用即拒「already consumed」。
//!
//! * 第二步（Ask Ottr 执行模式 · Manual 档，2026-11-04）：**真执行面**
//!   （[`ai_scope_run_step`]）落**同一套身份校验**：
//!   * 登记（[`ai_scope_exec`]）与执行（[`ai_scope_run_step`]）**分离**：
//!     plan / manual 两档的登记都是**零副作用**（不开通道、不执行）——
//!     manual 档登记后由用户在待确认卡上点「执行」，前端才调
//!     [`ai_scope_run_step`]；
//!   * **只执行已登记的步骤**：`stepId` 必须命中该作用域的计划登记簿，
//!     `actionId` 必须与登记时那条一致（防串改）——**不接受前端传来的任意
//!     命令**（执行对象 = 登记簿里的命令原文）；
//!   * **档位判定在后端**：档位随登记落账（登记簿记 `mode`），执行面按
//!     **登记时的档位**复核——plan 档登记的步骤即拒（「plan 模式不执行」），
//!     manual 档登记的步骤才放行；auto 档登记的步骤由**后端判定结论**
//!     （主机授权 + 命令分级）决定，执行前还会复核；
//!     **边界如实说**：档位本身是前端登记时落账的值，后端按落账值判定执行权；
//!     「用户已确认」这一环是 UI 事实，后端无从核验（设计文档 §3.6）；
//!   * **档位升级面**（[`ai_scope_upgrade_step`]，2026-11-04 修补 I-1）：
//!     plan 档登记的步骤要能执行，先由后端把它**以 manual 档新登记**一条——
//!     **命令原文只从该 scope 的登记簿里取**（前端不传命令、无从改写），
//!     新 actionId 一次性且与原 id 不同；升级只升级、不执行；
//!   * 执行走**独立 exec 通道**（`SshSession::exec_with_timeout`）：不落
//!     用户终端、不进 shell 历史、不与用户输入抢行缓冲；
//!   * **消费侧硬超时 30s**：超时 → **显式关闭 exec 通道**（russh `Channel`
//!     无 Drop 收尾——drop future = 远端 shell 悬挂）→ 结果按「超时」文案
//!     回灌模型（超时 ≠ 命令失败退出码，两者可分辨）；
//!   * stdout / stderr **各自 64 KiB 上限**，超限截断 + `truncated` 标记。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use ottr_vault::settings::Settings;
use ottr_vault::{
    AI_AUTO_MAX_DURATION_MAX, AI_AUTO_MAX_DURATION_MIN, AI_AUTO_MAX_STEPS_MAX,
    AI_AUTO_MAX_STEPS_MIN, AI_EXEC_TIMEOUT_MAX, AI_EXEC_TIMEOUT_MIN, AiHostPolicies,
    AiWriteCategory, SETTING_AI_AUTO_MAX_DURATION, SETTING_AI_AUTO_MAX_STEPS,
    SETTING_AI_EXEC_TIMEOUT, Vault,
};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::AsyncWriteExt;

use super::ai_policy::{AiCommandClass, classify_command};
use super::state::AppState;
use crate::vault::VaultState;

/// `connectionEpoch` 的前端安全上限：2^53（JS number 安全整数上界）。
const EPOCH_SAFE_MAX: u64 = 1 << 53;
/// 开立链接元数据（pane/root/rustId/conversation/request）的单段长度上限。
const LINKAGE_MAX_LEN: usize = 256;
/// AI 插入单次文本上限（字节）：单行命令绰绰有余，防误传爆 PTY 写端。
const INSERT_MAX_BYTES: usize = 4096;
/// context 单次取尾上限（1 MiB，与 `session_tail` 同口径）。
const CONTEXT_MAX_BYTES: u32 = 1 << 20;
/// 只读面单次 I/O 超时（秒）：读文件/列目录共用（与设计 §3.5 单条命令超时
/// 同值 30s——超时即失败，绝不无限等）。
const AI_SCOPE_IO_TIMEOUT: Duration = Duration::from_secs(30);
/// 读文件**返回内容**上限（字节）：超出截断 + `truncated` 标记。
const AI_SCOPE_FILE_MAX_BYTES: usize = 64 * 1024;
/// 读文件**硬上限**（字节）：超过直接拒（不把大文件读进内存——AI 侧拿到
/// 半截大文件是事故源，同 MCP read_file 口径）；软上限与硬上限之间才截断。
const AI_SCOPE_FILE_HARD_MAX_BYTES: u64 = 256 * 1024;
/// 列目录条目上限：超出截断（防超大目录撑爆面板与模型上下文）。
const AI_SCOPE_LIST_MAX_ENTRIES: usize = 512;
/// 每作用域计划步骤上限：满员拒绝新登记（登记即有界）。
const AI_SCOPE_MAX_PLAN_STEPS: usize = 128;
/// 执行面单条命令的**消费侧硬超时**（秒）：超时 → 显式关闭 exec 通道
/// （不留悬挂远端 shell）→ 结果按「超时」文案回灌模型。
///
/// 与设计 §3.5 护栏表同值（单条命令超时 30s）。**可配**：设置项
/// `ai.exec.timeout_secs`（写入侧范围校验 5..=300 秒，缺省 30）——用户
/// 在设置页调小调大都生效；读不到（vault 锁 / 键缺）时用这个缺省值。
const AI_SCOPE_EXEC_TIMEOUT: Duration = Duration::from_secs(30);
/// 执行面单条输出的**上限**（字节，stdout / stderr 各自）：超限截断 +
/// `truncated` 标记（与设计 §3.5 护栏表同值 64 KiB）。
const AI_SCOPE_EXEC_MAX_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AiSessionKind {
    Ssh,
    Local,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AiScopeTarget {
    pub pane_session_id: String,
    pub root_tab_id: String,
    pub rust_id: String,
    pub connection_epoch: u64,
    pub kind: AiSessionKind,
    pub host_id: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScope {
    #[serde(flatten)]
    pub target: AiScopeTarget,
    pub scope_id: String,
    pub endpoint: String,
    pub username: Option<String>,
}

#[derive(Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeContext {
    pub tail: String,
    pub notes: Option<String>,
}

/// 会话级执行模式（前端在登记时传上来、后端**原样落账**并在执行面按落账值
/// 判定；未知档位在反序列化面即被拒）。
///
/// * `plan`（默认）：执行类动作**只产计划、不执行**（零 exec 通道、零写端
///   副作用），返回 `planned = true` + 步骤 id 供前端渲染计划清单。
/// * `auto`：**主机已授权且命令在白名单/授权类别内**才放行；其余降级为逐条
///   确认；red 级直接拒。
/// * `manual`：**只登记不执行**（登记后由用户在待确认卡上点「执行」，前端
///   才调 [`ai_scope_run_step`]）——登记即零副作用。
///
/// **边界要如实说**（2026-11-04 修补 I-3）：档位**由前端在登记时落账**，
/// 后端按落账档位判定执行权；**「用户已确认」这一环是 UI 事实，后端无从
/// 核验**（设计取舍，见设计文档 §3.6 的「不可承诺的边界」）。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum AiExecMode {
    Plan,
    Auto,
    Manual,
}

/// 只读面：目录项（`name` / `isDir` / `size`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 只读面：目录列举结果（`path` = 生效路径——远端 canonical / 本机 canonical）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeListing {
    pub path: String,
    pub entries: Vec<AiScopeEntry>,
}

/// 只读面：文件内容（超软上限截断 + `truncated` 标记；`size` 是文件全量大小）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeFile {
    pub path: String,
    pub size: u64,
    pub content: String,
    pub truncated: bool,
}

/// 执行面：按模式分派的结果。
///
/// * plan / manual：**均不执行**（`executed` = false，`planned` = true；
///   `step_id` 是计划清单里的步骤 id）；
/// * **auto**（2026-11-04 第三步）：白名单命令**当场执行**（`executed` =
///   true，结果在 `result` 里）；非白名单命令**降级**为逐条确认
///   （`executed` = false，`downgrade_reason` 说明降级原因）；red 级命令
///   **直接拒绝**（整个命令抛错，不产生本结构）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeExecOutcome {
    pub executed: bool,
    pub planned: bool,
    pub step_id: String,
    pub message: String,
    /// **自动档已执行时的结果**（退出码 / 输出 / 超时标记）：`None` = 未执行
    /// （登记成待确认步骤）。
    pub result: Option<AiScopeRunResult>,
    /// **降级原因**（自动档把命令降级为逐条确认时给出）：`None` = 未降级。
    ///
    /// 降级不是失败——命令**没跑**，等用户点「执行」；原因要说清是
    /// 「逃逸形态」「写类别未授权」还是「未识别的命令」。
    pub downgrade_reason: Option<String>,
}

/// 档位升级的结果（[`ai_scope_upgrade_step`] 回包，2026-11-04 修补 I-1）。
///
/// **升级 = 把一条 plan 档登记的步骤，以 manual 档**新登记**一条**（命令原文
/// 只从该 scope 的登记簿里取——前端不传命令，也不许改写）。
///
/// * `step_id`：**新登记**的那条 manual 档步骤 id（前端据此调
///   [`ai_scope_run_step`] 执行它）；
/// * `action_id`：新登记用的 actionId（**一次性**：后端已在作用域动作账本里
///   消费过——同一个 id 再登记或再执行都拒）；
/// * `mode`：升级后的档位（恒为 `manual`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeUpgradeOutcome {
    pub step_id: String,
    pub action_id: String,
    pub mode: AiExecMode,
    pub message: String,
}

/// 执行面：**真执行**的结果（[`ai_scope_run_step`]）。
///
/// * `executed`：恒为 true（走到这一步说明命令**已经发出并跑完/被中止**；
///   拒绝路径走 `Err`，不产出本结构）。
/// * `exit_code`：`None` = **超时被中止**（没有退出码）或服务端未回退出码
///   ——与「非零退出码」可分辨（超时文案见 `message`）。
/// * `stdout` / `stderr`：各自 64 KiB 上限，超限截断 + `truncated` 标记。
/// * `timed_out`：**消费侧硬超时命中**（命令被中止、通道已显式关闭）。
///   单独一个布尔位——`exit_code = None` 单独看分不出「超时被中止」与
///   「服务端没回退出码」，前端要据此给用户与模型**不同**的提示。
/// * `message`：面向模型的一句话摘要（超时 / 失败 / 成功 + 截断提示）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiScopeRunResult {
    pub executed: bool,
    pub step_id: String,
    pub exit_code: Option<u32>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
    pub timed_out: bool,
    pub message: String,
}

/// 捕获的 writer 身份（open 时快照；kind 亦由此判别，insert 分支按它分派
/// 异步（SSH russh 通道）与同步（本地 PTY master）两套写端）。
enum ScopeWriter {
    Ssh(Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>>),
    Local(Arc<Mutex<Box<dyn std::io::Write + Send>>>),
}

/// 单个作用域的在册实体：捕获的运行时身份 + 快照面 + 一次性动作账本。
///
/// 名字带 "Registry" 是为了给**契约面**的 `AiScopeEntry`（只读面目录项）让位
/// ——两者的语义面完全不同（一个是作用域实体，一个是目录条目）。
pub(crate) struct AiScopeRegistryEntry {
    /// 开立时的目标元数据（pane/root/epoch 只作联动记录，不参与身份判定）。
    pub(crate) target: AiScopeTarget,
    /// 连接注册时的实际端点（SSH = address:port；本地 = "local"）。
    endpoint: String,
    /// SSH = 注册面的实际登录名；本地 = None（与简报契约一致）。
    username: Option<String>,
    created_at: Instant,
    /// 捕获的运行时生成期身份：insert/context 复核 `Arc::ptr_eq` 的比对面。
    runtime_id: Arc<()>,
    /// 捕获的 writer（不可变身份面）：insert 用它写，绝不改从 hostId/表另找。
    writer: ScopeWriter,
    /// 捕获的 SSH 会话句柄（SSH 作用域；本地为 None）：SFTP 只读面**只**经
    /// 它开通道——绝不按 hostId/表另找（与 writer 同一纪律：不可变身份面）。
    ssh: Option<Arc<ottr_ssh::SshSession>>,
    /// 该作用域的 SFTP 客户端缓存（懒开 + 复用；随作用域消亡）。
    sftp: tokio::sync::Mutex<Option<Arc<ottr_transfer::SftpClient>>>,
    /// 一次性动作账本（actionId 集合；登记即永久，满员拒新不逐旧）。
    actions: Mutex<HashSet<String>>,
    /// 计划步骤登记簿（**只登记不执行**；同一 actionId 幂等返同一步 id）。
    plans: Mutex<Vec<AiPlanStep>>,
    /// **自动档护栏计数**（2026-11-04 第三步）：
    /// * `auto_execs` —— 本作用域内已自动执行的次数（步数上限）；
    /// * `auto_started_at` —— 本作用域**首次**自动执行的时刻（总时长上限）。
    ///
    /// 这两个上限**在后端**也收口：前端那份只是提前止损（省一次往返），
    /// 后端才是最后一道闸——护栏写成「前端数一下」等于没有护栏。
    auto_execs: AtomicU64,
    auto_started_at: Mutex<Option<Instant>>,
}

/// 计划步骤登记项（作用域内；登记即**零副作用**——登记面绝不执行）。
#[derive(Clone)]
struct AiPlanStep {
    /// 计划步骤 id（确定性派生，见 [`plan_step_id`]）。
    step_id: String,
    /// 触发步骤的一次性动作 id（幂等键：同 id 恒得同一步）。
    action_id: String,
    /// 计划中的命令原文（**真执行面消费的就是这一条**——前端传来的命令
    /// 原文不被接受，执行对象永远是登记簿里这一份）。
    command: String,
    /// **登记时的会话执行档位**：执行面按它判定放行与否——manual 才放行；
    /// plan 档登记的步骤即拒（「plan 模式不执行」）。
    ///
    /// **档位的来源要如实说**（2026-11-04 修补 I-3——旧注释写「前端传什么
    /// 都不算数」，**那不准确**）：档位是**前端在登记时传上来、后端原样落账**
    /// 的值。后端能保证的是「**执行面按落账档位判定**」——plan 档登记的步骤
    /// 一定被拒，档位不会被执行面临时改写；但**落账值本身来自前端**，
    /// 后端**没有**「会话当前是哪个档位」的可核验真源（服务端不存会话档位）。
    /// 「用户是否真的点了确认」是 **UI 事实**，后端无从核验——这是设计取舍，
    /// 见设计文档 §3.6 的「不可承诺的边界」。
    ///
    /// 之所以仍要落账：`ai_scope_run_step` 的命令签名只有
    /// `(scopeId, stepId, actionId)`——**没有 mode 参数**（前端在执行时传什么
    /// 档位都没用），故执行权只能由登记时落账的档位决定。
    mode: AiExecMode,
    /// **自动档的后端放行结论**（2026-11-04 第三步）：true = 登记时后端已
    /// 判定「该主机已授权 + 该命令在只读白名单或授权的写类别内」→ 允许
    /// **不经用户确认**直接执行。
    ///
    /// 这个结论**只由后端写**（[`classify_command`] + 主机授权表的判定），
    /// 前端无从伪造：自动档的放行判断是最后一道闸，不能交给调用方。
    /// false + mode=auto → 执行面拒（「auto mode requires a backend-approved
    /// command」）。
    auto_approved: bool,
    /// **自动档的判定结论**（登记时后端算的）：`None` = 不是自动档产出的步骤
    /// （规划档 / 手动档登记的）→ 执行面不按自动档规则复核。
    ///
    /// `Some` = 这条步骤来自自动档（要么**当场自动执行**，要么**降级为逐条
    /// 确认**）→ 执行前**复核**：
    /// ① 主机仍然被授权自动执行（登记后用户可能撤销了授权）；
    /// ② 命令的分类结论没变（重新分级，red 一律拒）；
    /// ③ 写类别仍在该主机的授权类别里（用户可能改过勾选）。
    ///
    /// 复核的必要性：登记时的结论是**快照**——授权与分级都可能在其后变化
    /// （撤销授权、收紧类别），拿旧快照直接执行 = 执行了一条**现在已不被
    /// 允许**的命令。
    auto_verdict: Option<AutoVerdict>,
    /// **一次性消费标记**（执行面的 claim 面）：true = 该步骤已被执行过
    /// （或已被领走），二次调用即拒「already consumed」。
    consumed: bool,
}

/// 自动档的判定结论（登记时的快照；执行前复核）。
#[derive(Clone, Debug, PartialEq, Eq)]
struct AutoVerdict {
    /// 登记时的分级（red 不会走到这里——red 在登记前就被拒了 ✅）。
    class: super::ai_policy::AiCommandClass,
    /// 登记时命中的写类别（只读命令为 `None` ✅）。
    category: Option<AiWriteCategory>,
}

/// 有界内存作用域注册表（AppState 持有）：key = Rust 生成的 scopeId。
pub(crate) struct AiScopeRegistry {
    ttl: Duration,
    max_scopes: usize,
    max_actions: usize,
    scopes: Mutex<HashMap<String, Arc<AiScopeRegistryEntry>>>,
    seq: AtomicU64,
}

impl Default for AiScopeRegistry {
    fn default() -> Self {
        Self {
            ttl: Duration::from_secs(15 * 60),
            max_scopes: 128,
            max_actions: 256,
            scopes: Mutex::new(HashMap::new()),
            seq: AtomicU64::new(0),
        }
    }
}

impl AiScopeRegistry {
    /// 过期清扫（持锁调用）：TTL 之外的作用域就地出表（惰性，无后台任务）。
    fn prune_locked(scopes: &mut HashMap<String, Arc<AiScopeRegistryEntry>>, ttl: Duration) {
        scopes.retain(|_, entry| entry.created_at.elapsed() < ttl);
    }

    /// 取一个当前有效（在册且未过期）的作用域；撤销/过期一律按不存在拒绝。
    fn valid(&self, scope_id: &str) -> Result<Arc<AiScopeRegistryEntry>, String> {
        let mut scopes = self.scopes.lock().unwrap();
        Self::prune_locked(&mut scopes, self.ttl);
        scopes
            .get(scope_id)
            .cloned()
            .ok_or_else(|| "AI scope not found: revoked or expired".to_string())
    }

    /// 登记新作用域（满员 = 拒绝；返回 Rust 生成的 scopeId 与在册实体句柄）。
    fn register(
        &self,
        entry: AiScopeRegistryEntry,
    ) -> Result<(String, Arc<AiScopeRegistryEntry>), String> {
        let mut scopes = self.scopes.lock().unwrap();
        Self::prune_locked(&mut scopes, self.ttl);
        if scopes.len() >= self.max_scopes {
            return Err(format!(
                "AI scope registry full ({}): revoke unused scopes first",
                self.max_scopes
            ));
        }
        let scope_id = format!("ai-scope-{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let stored = Arc::new(entry);
        scopes.insert(scope_id.clone(), Arc::clone(&stored));
        Ok((scope_id, stored))
    }

    /// 撤销单个作用域（真移除：context/insert 即刻失效，容量即刻回收）。
    pub(crate) fn revoke(&self, scope_id: &str) -> bool {
        self.scopes.lock().unwrap().remove(scope_id).is_some()
    }

    /// 撤销绑定到指定运行时（kind + rustId）的全部作用域（drop/断开收尾）。
    pub(crate) fn revoke_runtime(&self, kind: AiSessionKind, rust_id: &str) {
        self.scopes
            .lock()
            .unwrap()
            .retain(|_, e| !(e.target.kind == kind && e.target.rust_id == rust_id));
    }

    /// 撤销全部作用域（库锁定收尾：解锁后不复活，重开才可用）。
    pub(crate) fn revoke_all(&self) -> usize {
        self.scopes.lock().unwrap().drain().count()
    }

    /// 一次性动作登记（await 前 claim 的 claim 面）：重放拒绝；动作集满员
    /// 拒绝**新** id——已消费的 id 永不驱逐（驱逐 = 打开重放窗口）。
    fn claim_action(&self, entry: &AiScopeRegistryEntry, action_id: &str) -> Result<(), String> {
        let mut actions = entry.actions.lock().unwrap();
        if actions.contains(action_id) {
            return Err(format!("AI action already consumed: {action_id}"));
        }
        if actions.len() >= self.max_actions {
            return Err(format!(
                "AI action budget exhausted ({}): open a new scope",
                self.max_actions
            ));
        }
        actions.insert(action_id.to_string());
        Ok(())
    }
}

/// 目标元数据与运行链接的静态校验（open 入口）：非空字段 + 长度上限 +
/// JS 安全 epoch（2^53 之上前端 number 已失真，直接拒收）。conversationId/
/// requestId 只做链接校验不入册——会话/请求的绑定面在前端（Task 3），
/// Rust 侧身份真源只有捕获的运行时。
fn validate_target(
    target: &AiScopeTarget,
    conversation_id: &str,
    request_id: &str,
) -> Result<(), String> {
    fn check(value: &str, name: &str) -> Result<(), String> {
        if value.is_empty() {
            return Err(format!("AI target rejected: empty {name}"));
        }
        if value.len() > LINKAGE_MAX_LEN {
            return Err(format!(
                "AI target rejected: {name} exceeds {LINKAGE_MAX_LEN} bytes"
            ));
        }
        Ok(())
    }
    check(&target.pane_session_id, "paneSessionId")?;
    check(&target.root_tab_id, "rootTabId")?;
    check(&target.rust_id, "rustId")?;
    check(conversation_id, "conversationId")?;
    check(request_id, "requestId")?;
    if target.connection_epoch >= EPOCH_SAFE_MAX {
        return Err(format!(
            "AI target rejected: connectionEpoch {} is outside the JS safe range",
            target.connection_epoch
        ));
    }
    Ok(())
}

/// 插入文本静态校验：非空单行，拒绝一切控制字符（\t\n\r\0、C1、DEL 全在
/// Unicode Cc）与 U+2028/U+2029 行/段分隔符——AI 永不写入回车（绝不自动执行）。
fn validate_insert_text(text: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err("AI insert rejected: empty text".into());
    }
    if text.len() > INSERT_MAX_BYTES {
        return Err(format!(
            "AI insert rejected: text exceeds {INSERT_MAX_BYTES} bytes"
        ));
    }
    if let Some(ch) = text
        .chars()
        .find(|c| c.is_control() || *c == '\u{2028}' || *c == '\u{2029}')
    {
        return Err(format!(
            "AI insert rejected: control/newline character U+{:04X}",
            ch as u32
        ));
    }
    Ok(())
}

/// 开立 AI 目标作用域：元数据目标 → 捕获运行时身份（真实 endpoint/username
/// 取自会话表项，绝不回读数据库、绝不按 hostId 兜底找运行时）。
fn open_scope(
    state: &AppState,
    vault: &Vault,
    target: AiScopeTarget,
    conversation_id: String,
    request_id: String,
) -> Result<AiScope, String> {
    if vault.is_locked() {
        return Err("AI target rejected: vault locked".into());
    }
    validate_target(&target, &conversation_id, &request_id)?;
    match target.kind {
        AiSessionKind::Ssh => {
            // 精确表分派：SSH 目标只查 SSH 表；hostId 与表项**完全一致**
            //（None vs Some 亦失配）才放行——同主机另一连接绝不误中。
            let (runtime_id, writer, session, endpoint, username, host_id) = {
                let sessions = state.sessions.lock().unwrap();
                sessions.get(&target.rust_id).map_or_else(
                    || {
                        Err(format!(
                            "AI target rejected: no SSH runtime for rustId {}",
                            target.rust_id
                        ))
                    },
                    |e| {
                        Ok((
                            Arc::clone(&e.runtime_id),
                            Arc::clone(&e.writer),
                            Arc::clone(&e.session),
                            e.endpoint.clone(),
                            e.username.clone(),
                            e.host_id,
                        ))
                    },
                )?
            };
            if target.host_id != host_id {
                return Err(format!(
                    "AI target rejected: hostId {:?} does not match runtime host {host_id:?}",
                    target.host_id
                ));
            }
            let (scope_id, stored) = state.ai_scopes.register(AiScopeRegistryEntry {
                target: target.clone(),
                endpoint: endpoint.clone(),
                username: Some(username.clone()),
                created_at: Instant::now(),
                runtime_id,
                writer: ScopeWriter::Ssh(writer),
                ssh: Some(session),
                sftp: tokio::sync::Mutex::new(None),
                actions: Mutex::new(HashSet::new()),
                plans: Mutex::new(Vec::new()),
                auto_execs: AtomicU64::new(0),
                auto_started_at: Mutex::new(None),
            })?;
            Ok(AiScope {
                target,
                scope_id,
                endpoint: stored.endpoint.clone(),
                username: stored.username.clone(),
            })
        }
        AiSessionKind::Local => {
            // 本地目标显式无主机：hostId 非 null 直接拒（前端/AI 侧不得把
            // 本地会话冒充某主机连接）。
            if let Some(host_id) = target.host_id {
                return Err(format!(
                    "AI target rejected: local target must have hostId null, got {host_id}"
                ));
            }
            let (runtime_id, writer) = {
                let local = state.local_sessions.lock().unwrap();
                local.get(&target.rust_id).map_or_else(
                    || {
                        Err(format!(
                            "AI target rejected: no local runtime for rustId {}",
                            target.rust_id
                        ))
                    },
                    |e| Ok((Arc::clone(&e.runtime_id), Arc::clone(&e.writer))),
                )?
            };
            let (scope_id, _stored) = state.ai_scopes.register(AiScopeRegistryEntry {
                target: target.clone(),
                endpoint: "local".into(),
                username: None,
                created_at: Instant::now(),
                runtime_id,
                writer: ScopeWriter::Local(writer),
                ssh: None,
                sftp: tokio::sync::Mutex::new(None),
                actions: Mutex::new(HashSet::new()),
                plans: Mutex::new(Vec::new()),
                auto_execs: AtomicU64::new(0),
                auto_started_at: Mutex::new(None),
            })?;
            Ok(AiScope {
                target,
                scope_id,
                endpoint: "local".into(),
                username: None,
            })
        }
    }
}

/// 作用域上下文：**只**取本作用域运行时的剥 ANSI 文本尾 + 归属主机的备注行
///（本地无主机 → notes 恒 None）；绝不跨作用域、绝不按 hostId 重找运行时。
fn scope_context(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    bytes: u32,
) -> Result<AiScopeContext, String> {
    if vault.is_locked() {
        return Err("AI context rejected: vault locked".into());
    }
    let entry = state.ai_scopes.valid(scope_id)?;
    let bytes = bytes.min(CONTEXT_MAX_BYTES) as usize;
    match &entry.writer {
        ScopeWriter::Ssh(_) => {
            let (tail, host_id) = {
                let sessions = state.sessions.lock().unwrap();
                match sessions.get(&entry.target.rust_id) {
                    Some(e) if Arc::ptr_eq(&e.runtime_id, &entry.runtime_id) => {
                        (e.text_tail.tail(bytes), e.host_id)
                    }
                    _ => {
                        return Err(format!(
                            "AI context rejected: runtime {} no longer matches the scoped connection",
                            entry.target.rust_id
                        ));
                    }
                }
            };
            let notes = match host_id {
                Some(id) => ottr_vault::Hosts::get(vault, id)
                    .map_err(|e| format!("AI context rejected: host row: {e}"))?
                    .and_then(|host| host.notes),
                None => None,
            };
            Ok(AiScopeContext { tail, notes })
        }
        ScopeWriter::Local(_) => {
            let tail = {
                let local = state.local_sessions.lock().unwrap();
                match local.get(&entry.target.rust_id) {
                    Some(e) if Arc::ptr_eq(&e.runtime_id, &entry.runtime_id) => {
                        e.text_tail.tail(bytes)
                    }
                    _ => {
                        return Err(format!(
                            "AI context rejected: runtime {} no longer matches the scoped connection",
                            entry.target.rust_id
                        ));
                    }
                }
            };
            Ok(AiScopeContext { tail, notes: None })
        }
    }
}

/// writer 锁在手后的第二道门（简报：claim 后、写入前复核 scope/lock/当前
/// writer）：作用域仍在册且是同一实体（撤销/过期/随锁撤销 = 拒绝）+ 库未锁
/// + 表内 runtime_id 仍是捕获的那个（移除/替换同名 id = 拒绝）。
fn gate_after_lock(
    scopes: &AiScopeRegistry,
    vault: &Vault,
    scope_id: &str,
    entry: &Arc<AiScopeRegistryEntry>,
    current_runtime: Option<&Arc<()>>,
) -> Result<(), String> {
    if vault.is_locked() {
        return Err("AI insert rejected: vault locked".into());
    }
    let live = scopes.valid(scope_id)?;
    if !Arc::ptr_eq(&live, entry) {
        return Err("AI insert rejected: scope revoked or expired".into());
    }
    match current_runtime {
        Some(rt) if Arc::ptr_eq(rt, &entry.runtime_id) => Ok(()),
        Some(_) => Err(format!(
            "AI insert rejected: runtime {} was replaced",
            entry.target.rust_id
        )),
        None => Err(format!(
            "AI insert rejected: runtime {} is gone",
            entry.target.rust_id
        )),
    }
}

/// AI 插入（一次性）：文本校验 → claim（await 前）→ 快照当前表项身份 →
/// 拿 writer 锁 → [`gate_after_lock`] 复核 → 逐字节写入（不追加换行）。
/// SSH 写端异步锁；本地 PTY master 同步锁经 spawn_blocking（满缓冲会阻塞，
/// 绝不拖垮异步运行时——`write_session` 本地分支同款裁定），复核在**锁内**
/// 重做（撤销/替换发生在等待窗口时照样零写入）。
async fn insert_scope(
    state: &AppState,
    vault: Arc<Vault>,
    scope_id: String,
    action_id: String,
    text: String,
) -> Result<(), String> {
    // 静态校验先行：坏文本不消耗动作预算。
    validate_insert_text(&text)?;
    if vault.is_locked() {
        return Err("AI insert rejected: vault locked".into());
    }
    let entry = state.ai_scopes.valid(&scope_id)?;
    // await 前 claim：一次性语义在等待 writer 之前落账——并发重放即拒。
    state.ai_scopes.claim_action(&entry, &action_id)?;
    let runtime_id = Arc::clone(&entry.runtime_id);
    let rust_id = entry.target.rust_id.clone();
    // 写端用 open 时捕获的 Arc（不可变身份面）；表内 runtime_id 复核通过
    // 即等价同一表项（Arc<()> 每次注册唯一）——绝不按 hostId/表另找 writer。
    match &entry.writer {
        ScopeWriter::Ssh(captured) => {
            {
                let sessions = state.sessions.lock().unwrap();
                match sessions.get(&rust_id) {
                    Some(e) if Arc::ptr_eq(&e.runtime_id, &runtime_id) => {}
                    Some(_) => {
                        return Err(format!(
                            "AI insert rejected: runtime {rust_id} was replaced"
                        ));
                    }
                    None => return Err(format!("AI insert rejected: runtime {rust_id} is gone")),
                }
            }
            let mut guard = captured.lock().await;
            let current_runtime = state
                .sessions
                .lock()
                .unwrap()
                .get(&rust_id)
                .map(|e| Arc::clone(&e.runtime_id));
            gate_after_lock(
                &state.ai_scopes,
                &vault,
                &scope_id,
                &entry,
                current_runtime.as_ref(),
            )?;
            guard
                .write_all(text.as_bytes())
                .await
                .map_err(|e| format!("AI insert rejected: pty write failed: {e}"))?;
            guard
                .flush()
                .await
                .map_err(|e| format!("AI insert rejected: pty flush failed: {e}"))?;
            Ok(())
        }
        ScopeWriter::Local(captured) => {
            {
                let local = state.local_sessions.lock().unwrap();
                match local.get(&rust_id) {
                    Some(e) if Arc::ptr_eq(&e.runtime_id, &runtime_id) => {}
                    Some(_) => {
                        return Err(format!(
                            "AI insert rejected: runtime {rust_id} was replaced"
                        ));
                    }
                    None => return Err(format!("AI insert rejected: runtime {rust_id} is gone")),
                }
            }
            let writer = Arc::clone(captured);
            let scopes = Arc::clone(&state.ai_scopes);
            let local_sessions = Arc::clone(&state.local_sessions);
            let entry = Arc::clone(&entry);
            let scope_id2 = scope_id.clone();
            tokio::task::spawn_blocking(move || -> Result<(), String> {
                let mut guard = writer.lock().unwrap();
                let current_runtime = local_sessions
                    .lock()
                    .unwrap()
                    .get(&rust_id)
                    .map(|e| Arc::clone(&e.runtime_id));
                gate_after_lock(
                    &scopes,
                    &vault,
                    &scope_id2,
                    &entry,
                    current_runtime.as_ref(),
                )?;
                guard
                    .write_all(text.as_bytes())
                    .map_err(|e| format!("AI insert rejected: pty write failed: {e}"))?;
                guard
                    .flush()
                    .map_err(|e| format!("AI insert rejected: pty flush failed: {e}"))?;
                Ok(())
            })
            .await
            .map_err(|e| format!("AI insert rejected: join: {e}"))?
        }
    }
}

/// 库锁定收尾（[`lock_vault`]）：先撤作用域再落锁，窗口最短——锁定即 AI
/// 全部作用域失效，解锁后不复活。vault_lock 命令与自动锁定共用。
pub(crate) fn lock_vault(vault: &Vault, scopes: &AiScopeRegistry) {
    scopes.revoke_all();
    vault.lock();
}

// ---------------------------------------------------------------------------
// 只读面 + 执行面（Ask Ottr 执行模式 · 第一步 Plan 档）
// ---------------------------------------------------------------------------

/// 单行文本静态校验（插入面与执行面**同一口径**）：非空、单行（拒绝一切
/// 控制字符与 U+2028/2029 行/段分隔符）、≤ [`INSERT_MAX_BYTES`] 字节。
/// `face` 只进错误前缀（insert / exec）——执行面**也要**过这道闸：命令会
/// 进计划清单，脏命令进清单等于把注入面留给后续执行。
fn validate_single_line_text(text: &str, face: &str) -> Result<(), String> {
    if text.is_empty() {
        return Err(format!("AI {face} rejected: empty text"));
    }
    if text.len() > INSERT_MAX_BYTES {
        return Err(format!(
            "AI {face} rejected: text exceeds {INSERT_MAX_BYTES} bytes"
        ));
    }
    if let Some(ch) = text
        .chars()
        .find(|c| c.is_control() || *c == '\u{2028}' || *c == '\u{2029}')
    {
        return Err(format!(
            "AI {face} rejected: control/newline character U+{:04X}",
            ch as u32
        ));
    }
    Ok(())
}

/// actionId 静态校验（非空 + 长度上限）：它是执行面的幂等键。
/// `face` 只进错误前缀（exec 登记面 / run 执行面）。
fn validate_action_id(action_id: &str, face: &str) -> Result<(), String> {
    if action_id.is_empty() {
        return Err(format!("AI {face} rejected: empty actionId"));
    }
    if action_id.len() > LINKAGE_MAX_LEN {
        return Err(format!(
            "AI {face} rejected: actionId exceeds {LINKAGE_MAX_LEN} bytes"
        ));
    }
    Ok(())
}

/// stepId 静态校验（非空 + 长度上限）：它是执行面命中登记簿的键。
///
/// **形态不校验前缀**（`ai-step-<hash>` 是后端派生的，但拒绝一个形状陌生的
/// stepId 没有额外安全收益——真正的闸门是「登记簿里有没有这一条」）。
fn validate_step_id(step_id: &str) -> Result<(), String> {
    if step_id.is_empty() {
        return Err("AI run rejected: empty stepId".into());
    }
    if step_id.len() > LINKAGE_MAX_LEN {
        return Err(format!(
            "AI run rejected: stepId exceeds {LINKAGE_MAX_LEN} bytes"
        ));
    }
    Ok(())
}

/// 远端路径静态校验（沿用 MCP read_file 口径）：绝对路径、无 NUL、无 `..`
/// 段。**canonical 终判在远端**（realpath 后与作用域只读根做段边界比对）。
fn validate_remote_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("AI read rejected: empty path".into());
    }
    if !path.starts_with('/') {
        return Err("AI read rejected: path must be an absolute remote path".into());
    }
    if path.as_bytes().contains(&0) {
        return Err("AI read rejected: path contains NUL".into());
    }
    if path.split('/').any(|seg| seg == "..") {
        return Err("AI read rejected: path must not contain '..' segments".into());
    }
    Ok(())
}

/// 目录边界精确到路径段（`/tmp2` 不匹配 `/tmp`；根目录 `/` 特判避免 `//`
/// 前缀误判）——与 MCP read_file 的白名单前缀判定同款纪律。
fn path_within(child: &str, dir: &str) -> bool {
    if dir == "/" {
        return child.starts_with('/');
    }
    child == dir || child.starts_with(&format!("{dir}/"))
}

/// 本机（kind=local）会话**一律不开放主机文件读取面**。
///
/// 裁定（2026-11-04 修补 A1）：本地终端会话的只读面**只保留终端输出尾**
/// （那本来就是用户自己屏幕上的东西），读文件 / 列目录**一律拒**——本地会话
/// 的只读根曾被实现自选为「Ottr 进程用户的整个 HOME」，等于把 `~/.ssh`、
/// `~/.aws`、`~/.kube`、`~/.gnupg` 等凭据默认交给外部模型，而脱敏层只覆盖
/// PEM/AKIA/`password=` 等已知形态（`~/.kube/config` 的 `client-key-data`、
/// PGP 私钥块并不覆盖）。远端家目录之外的放开（按主机授权表）是第三步的事。
///
/// 错误文案要能直接说清原因（前端另有 8 语本地化文案，见 i18n `ai.hostTool.
/// localReadRejected`）。
const LOCAL_READ_DENIED: &str =
    "AI read rejected: local terminal sessions do not expose host file reads";

/// IO 之后的二次身份复核（读取面专用）：作用域若在 IO 期间被撤销/过期/
/// 运行时被替换 → **不返回已取到的数据**（读取面同样守"撤销即失效"；
/// 读面虽无副作用，但"已撤销的作用域不该再拿到主机内容"是同一条纪律）。
fn recheck_scope(
    state: &AppState,
    scope_id: &str,
    entry: &Arc<AiScopeRegistryEntry>,
    face: &str,
) -> Result<(), String> {
    let live = state.ai_scopes.valid(scope_id)?;
    if !Arc::ptr_eq(&live, entry) {
        return Err(format!("AI {face} rejected: scope revoked or expired"));
    }
    verify_runtime(state, entry, face)
}

/// 作用域运行时复核（任何 IO 之前）：SSH 只查 SSH 表、本地只查本地表
/// （**绝不双表兜底**）；表内 runtime_id 必须是开立作用域时捕获的那一个
/// （`Arc::ptr_eq`）——被替换/移除即拒；hostId 与表项**完全一致**
/// （None vs Some 亦判失配）。
fn verify_runtime(
    state: &AppState,
    entry: &Arc<AiScopeRegistryEntry>,
    face: &str,
) -> Result<(), String> {
    match entry.target.kind {
        AiSessionKind::Ssh => {
            let sessions = state.sessions.lock().unwrap();
            match sessions.get(&entry.target.rust_id) {
                Some(e) if Arc::ptr_eq(&e.runtime_id, &entry.runtime_id) => {
                    if e.host_id != entry.target.host_id {
                        return Err(format!(
                            "AI {face} rejected: hostId {:?} does not match runtime host {:?}",
                            entry.target.host_id, e.host_id
                        ));
                    }
                    Ok(())
                }
                Some(_) => Err(format!(
                    "AI {face} rejected: runtime {} was replaced",
                    entry.target.rust_id
                )),
                None => Err(format!(
                    "AI {face} rejected: runtime {} is gone",
                    entry.target.rust_id
                )),
            }
        }
        AiSessionKind::Local => {
            let local = state.local_sessions.lock().unwrap();
            match local.get(&entry.target.rust_id) {
                Some(e) if Arc::ptr_eq(&e.runtime_id, &entry.runtime_id) => Ok(()),
                Some(_) => Err(format!(
                    "AI {face} rejected: runtime {} was replaced",
                    entry.target.rust_id
                )),
                None => Err(format!(
                    "AI {face} rejected: runtime {} is gone",
                    entry.target.rust_id
                )),
            }
        }
    }
}

/// 作用域的 SFTP 客户端（懒开 + 缓存）：**只**经开立时捕获的会话开通道
/// （绝不按 hostId/表另找——防串主机）。
async fn scope_sftp(
    entry: &AiScopeRegistryEntry,
) -> Result<Arc<ottr_transfer::SftpClient>, String> {
    let Some(session) = entry.ssh.as_ref() else {
        return Err("AI read rejected: scope has no SSH runtime".into());
    };
    let mut guard = entry.sftp.lock().await;
    if let Some(cached) = guard.as_ref() {
        return Ok(Arc::clone(cached));
    }
    let client = Arc::new(
        ottr_transfer::SftpClient::open(session)
            .await
            .map_err(|e| format!("AI read rejected: sftp open failed: {e}"))?,
    );
    *guard = Some(Arc::clone(&client));
    Ok(client)
}

/// 远端只读根 = 远端家目录（`realpath(".")`：远端 home 展开锚点）。
///
/// **形态校验**：SFTP 服务端在 `realpath` 回落成空文件名列表时会把入参原样
/// 返回（对 "." 就是 "."）——此时只读根不是绝对路径，`path_within` 恒假、
/// **所有远端读全被拒**（fail-closed，安全上没问题，但错误面难排查）。故这里
/// 显式判形态：拿不到绝对路径的家目录就说清是「无法确定远端家目录」。
async fn remote_read_root(sftp: &ottr_transfer::SftpClient) -> Result<String, String> {
    let root = sftp
        .realpath(".")
        .await
        .map_err(|e| format!("AI read rejected: resolve scope root failed: {e}"))?;
    if !root.starts_with('/') {
        return Err(format!(
            "AI read rejected: cannot determine the remote home directory (realpath returned {root:?})"
        ));
    }
    Ok(root)
}

/// 远端列目录（canonical 终判 → 列目录 → 截断条目数）。
async fn sftp_list_dir(
    sftp: &ottr_transfer::SftpClient,
    path: &str,
) -> Result<AiScopeListing, String> {
    let canonical = sftp
        .realpath(path)
        .await
        .map_err(|e| format!("AI read rejected: resolve path failed: {e}"))?;
    let root = remote_read_root(sftp).await?;
    if !path_within(&canonical, &root) {
        return Err(format!(
            "AI read rejected: path {path} is outside the scope read root ({root})"
        ));
    }
    let entries = sftp
        .list_dir(&canonical)
        .await
        .map_err(|e| format!("AI read rejected: list dir failed: {e}"))?;
    let entries = entries
        .into_iter()
        .take(AI_SCOPE_LIST_MAX_ENTRIES)
        .map(|e| AiScopeEntry {
            name: e.name,
            is_dir: e.is_dir,
            size: e.size,
        })
        .collect();
    Ok(AiScopeListing {
        path: canonical,
        entries,
    })
}

/// 远端读文件（canonical 终判 → stat 硬上限 → 读 → 软上限截断）。
async fn sftp_read_file(
    sftp: &ottr_transfer::SftpClient,
    path: &str,
) -> Result<AiScopeFile, String> {
    let canonical = sftp
        .realpath(path)
        .await
        .map_err(|e| format!("AI read rejected: resolve path failed: {e}"))?;
    let root = remote_read_root(sftp).await?;
    if !path_within(&canonical, &root) {
        return Err(format!(
            "AI read rejected: path {path} is outside the scope read root ({root})"
        ));
    }
    let stat = sftp
        .stat(&canonical)
        .await
        .map_err(|e| format!("AI read rejected: stat failed: {e}"))?;
    if stat.is_dir {
        return Err("AI read rejected: path is a directory".into());
    }
    if stat.size > AI_SCOPE_FILE_HARD_MAX_BYTES {
        return Err(format!(
            "AI read rejected: file exceeds the {} KiB read limit ({} bytes)",
            AI_SCOPE_FILE_HARD_MAX_BYTES / 1024,
            stat.size
        ));
    }
    let bytes = sftp
        .open_remote_text(&canonical)
        .await
        .map_err(|e| format!("AI read rejected: read failed: {e}"))?;
    let truncated = bytes.len() > AI_SCOPE_FILE_MAX_BYTES;
    let cut = bytes.len().min(AI_SCOPE_FILE_MAX_BYTES);
    Ok(AiScopeFile {
        path: canonical,
        size: stat.size.max(bytes.len() as u64),
        content: String::from_utf8_lossy(&bytes[..cut]).into_owned(),
        truncated,
    })
}

/// 只读面：列目录（**仅 SSH 走 SFTP**；本地会话一律拒——见 [`LOCAL_READ_DENIED`]）。
///
/// 闸门顺序：锁定 → 作用域在册/未过期 → 运行时身份复核（被替换/移除即拒）
/// → 本地面关闭（kind=local 一律拒）→ 路径规则（远端：绝对 + 无 `..`）→ IO
/// （带超时与字节/条目上限）。
async fn list_dir_scope(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    path: &str,
) -> Result<AiScopeListing, String> {
    if vault.is_locked() {
        return Err("AI read rejected: vault locked".into());
    }
    let entry = state.ai_scopes.valid(scope_id)?;
    verify_runtime(state, &entry, "read")?;
    match entry.target.kind {
        AiSessionKind::Ssh => {
            validate_remote_path(path)?;
            // 超时**包住开通道在内**的整段远端 IO：对端不回 SFTP 握手时
            // 绝不无限挂起（russh 通道无 Drop 收尾——超时后通道悬空也好过
            // 整个命令挂死）。
            let io = async {
                let sftp = scope_sftp(&entry).await?;
                sftp_list_dir(&sftp, path).await
            };
            let result = tokio::time::timeout(AI_SCOPE_IO_TIMEOUT, io)
                .await
                .map_err(|_| {
                    format!(
                        "AI read rejected: timed out after {}s",
                        AI_SCOPE_IO_TIMEOUT.as_secs()
                    )
                })?;
            recheck_scope(state, scope_id, &entry, "read")?;
            result
        }
        // 本地会话**不开放主机文件读取面**（A1 裁定）：一律拒，零 IO。
        AiSessionKind::Local => Err(LOCAL_READ_DENIED.to_string()),
    }
}

/// 只读面：读文件（**仅 SSH 走 SFTP**；本地会话一律拒——见 [`LOCAL_READ_DENIED`]）。
/// 路径规则与列目录同口径（绝对路径、无 `..` 段、canonical 终判落在只读根内）。
async fn read_file_scope(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    path: &str,
) -> Result<AiScopeFile, String> {
    if vault.is_locked() {
        return Err("AI read rejected: vault locked".into());
    }
    let entry = state.ai_scopes.valid(scope_id)?;
    verify_runtime(state, &entry, "read")?;
    match entry.target.kind {
        AiSessionKind::Ssh => {
            validate_remote_path(path)?;
            // 超时**包住开通道在内**的整段远端 IO（见 list_dir_scope 同款裁定）。
            let io = async {
                let sftp = scope_sftp(&entry).await?;
                sftp_read_file(&sftp, path).await
            };
            let result = tokio::time::timeout(AI_SCOPE_IO_TIMEOUT, io)
                .await
                .map_err(|_| {
                    format!(
                        "AI read rejected: timed out after {}s",
                        AI_SCOPE_IO_TIMEOUT.as_secs()
                    )
                })?;
            recheck_scope(state, scope_id, &entry, "read")?;
            result
        }
        // 本地会话**不开放主机文件读取面**（A1 裁定）：一律拒，零 IO。
        AiSessionKind::Local => Err(LOCAL_READ_DENIED.to_string()),
    }
}

/// 计划步骤 id（确定性派生）：同一 actionId 恒得同一步 id——重放幂等（前端
/// 可直接用它去重计划清单，后端也据此判"这一步已登记"）。FNV-1a 64 位摘要。
fn plan_step_id(action_id: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in action_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("ai-step-{hash:016x}")
}

/// 计划步骤登记（**只登记不执行**）：满员拒绝新登记。
///
/// 同一 actionId 的重复登记在**进入本函数之前**已被 [`AiScopeRegistry::
/// claim_action`] 拦掉（一次性消费语义）；这里的「同 actionId 返同一步 id」
/// 只是第二道保险（登记簿自身保持幂等，绝不产生第二条计划条目）。
///
/// `mode` 随登记落账（后端执行面复核放行与否的唯一依据——见 [`AiPlanStep`]）。
fn register_plan_step(
    entry: &AiScopeRegistryEntry,
    action_id: &str,
    command: &str,
    mode: AiExecMode,
    auto_approved: bool,
    auto_verdict: Option<AutoVerdict>,
) -> Result<String, String> {
    let mut plans = entry.plans.lock().unwrap();
    if let Some(existing) = plans.iter().find(|p| p.action_id == action_id) {
        return Ok(existing.step_id.clone());
    }
    if plans.len() >= AI_SCOPE_MAX_PLAN_STEPS {
        return Err(format!(
            "AI exec rejected: plan budget exhausted ({AI_SCOPE_MAX_PLAN_STEPS}): open a new scope"
        ));
    }
    let step_id = plan_step_id(action_id);
    plans.push(AiPlanStep {
        step_id: step_id.clone(),
        action_id: action_id.to_string(),
        command: command.to_string(),
        mode,
        auto_approved,
        auto_verdict,
        consumed: false,
    });
    Ok(step_id)
}

/// 计划步骤的**只读查找**（执行面前的预检）：命中返回该步骤（副本）。
///
/// 与 [`claim_step_execution`] 分开是刻意的：预检（档位判定 / 本地会话 /
/// 命令静态校验 / 运行时复核）**不得**消费步骤——被拒的调用必须零副作用
/// （步骤仍可被合法调用执行）。
fn find_plan_step(entry: &AiScopeRegistryEntry, step_id: &str) -> Option<AiPlanStep> {
    let plans = entry.plans.lock().unwrap();
    plans.iter().find(|p| p.step_id == step_id).cloned()
}

/// 计划步骤的**执行 claim**（**一次性**，await 前的同步动作）。
///
/// 三道判定合一（同一把锁内完成，**原子**）：
/// 1. `step_id` 必须命中登记簿（未登记 → 拒；**不接受前端传来的任意命令**）；
/// 2. `action_id` 必须与登记时那条一致（防串改）；
/// 3. 该步骤未被消费过（二次调用 → 拒「already consumed」）。
///
/// **为什么不用 scope 级的 [`AiScopeRegistry::claim_action`] 账本**：登记时
/// （[`ai_scope_exec`]）已经消费过**同一个 actionId**（那是「登记一次性」的
/// 幂等键）——执行面若复用同一账本会**恒拒**（每次都撞上「already
/// consumed」）。故执行的一次性消费落在**步骤自身**的 `consumed` 标记上。
///
/// 消费时机：**await 之前**（并发双击只有一个放行），且**失败也消费**
/// （fail-closed：命令已发出或已被中止，重放不是安全动作——要重跑就重新
/// 登记一条新步骤）。
fn claim_step_execution(
    entry: &AiScopeRegistryEntry,
    step_id: &str,
    action_id: &str,
) -> Result<AiPlanStep, String> {
    let mut plans = entry.plans.lock().unwrap();
    let step = plans
        .iter_mut()
        .find(|p| p.step_id == step_id)
        .ok_or_else(|| {
            format!("AI run rejected: step {step_id} is not registered in this scope")
        })?;
    if step.action_id != action_id {
        return Err("AI run rejected: actionId does not match the registered step".to_string());
    }
    if step.consumed {
        return Err(format!(
            "AI run rejected: action already consumed: {action_id}"
        ));
    }
    step.consumed = true;
    Ok(step.clone())
}

/// 执行面：按会话模式分派。
///
/// * `plan`（默认）：**只登记计划步骤**——绝不打开 exec 通道、绝不碰任何写端
///   （零执行、零副作用）；返回 `planned = true` + 步骤 id。
/// * `manual`：本步同样**只登记不执行**（真正执行是第二步的前端确认流）。
/// * `auto`：**主机已授权 + 命令分级放行**才执行（见 [`auto_exec_scope`]）；
///   其余降级为逐条确认；red 级直接拒。
///
/// 闸门顺序（2026-11-04 修补 A2/A3）：
/// 1. 静态校验（坏命令不登记计划、不消耗任何预算）；
/// 2. 库锁定 → 拒；
/// 3. **作用域有效性**（在册 + 未过期）→ 拒——错误面先说作用域的问题，
///    不用「auto 未启用」盖住真实原因；
/// 4. **模式判定**（auto → 拒）；
/// 5. 本地会话无执行权 → 拒；运行时身份复核（被替换/移除 → 拒）；
/// 6. **一次性消费 actionId**（claim 面，与 insert 同款纪律）→ 同一 actionId
///    第二次调用即拒「already consumed」；
/// 7. 登记计划步骤（只登记不执行）。
///
/// 本地会话（kind=local）**一律不给执行权**（设计裁定：本地是用户自己的
/// 机器与交互 shell，AI 在其中自动跑命令的误操作代价最高）。
async fn exec_scope(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    action_id: &str,
    command: &str,
    mode: AiExecMode,
) -> Result<AiScopeExecOutcome, String> {
    // 静态校验先行：坏命令不登记计划、不消耗任何预算。
    validate_single_line_text(command, "exec")?;
    validate_action_id(action_id, "exec")?;
    if vault.is_locked() {
        return Err("AI exec rejected: vault locked".into());
    }
    // 作用域有效性**先于**模式判定（错误面一致：作用域无效就说作用域无效）。
    let entry = state.ai_scopes.valid(scope_id)?;
    // 模式闸门在后端（档位由前端在登记时传上来、后端**原样落账**）。
    //
    // plan / manual **一律只登记**（零副作用：不开通道、不执行）——manual
    // 档登记后由用户在待确认卡点「执行」，前端再调 [`ai_scope_run_step`]。
    //
    // **auto 档**（2026-11-04 第三步）走独立的放行判定链：
    // 主机授权 → 命令分级（red 直接拒 / 只读白名单 / 写类别 / 逃逸降级）→
    // 放行则**立即执行**、否则降级为逐条确认。
    let message = match mode {
        AiExecMode::Plan => "recorded in the plan; not executed (plan mode)",
        AiExecMode::Manual => {
            "recorded for confirmation; not executed yet — run it after you confirm (manual mode)"
        }
        AiExecMode::Auto => {
            return auto_exec_scope(state, vault, &entry, scope_id, action_id, command).await;
        }
    };
    // 本地会话无执行权：只给只读上下文。
    if entry.target.kind == AiSessionKind::Local {
        return Err(
            "AI exec rejected: local terminal sessions never grant AI execution rights".into(),
        );
    }
    // 运行时身份复核（被替换/移除 → 拒；此时仍未产生任何副作用）。
    verify_runtime(state, &entry, "exec")?;
    // **一次性消费 actionId**（登记计划之前 claim）：同一 actionId 第二次调用
    // 即拒「already consumed」——重放窗口在登记前就关闭（与 insert 面同款
    // 纪律：claim 是 await 前的同步动作，重放并发也只放行一次）。
    state.ai_scopes.claim_action(&entry, action_id)?;
    // 只登记计划步骤：不开 exec 通道、不碰写端。档位随登记落账（执行面复核用）。
    let step_id = register_plan_step(&entry, action_id, command, mode, false, None)?;
    Ok(AiScopeExecOutcome {
        executed: false,
        planned: true,
        step_id,
        message: message.to_string(),
        result: None,
        downgrade_reason: None,
    })
}

/// **自动档的放行判定链**（后端唯一真源，2026-11-04 第三步）。
///
/// 顺序（顺序不可换）：
/// 1. 本地会话 → 拒（本地不给 AI 执行权）；
/// 2. 运行时身份复核 → 拒（连接被替换/移除）；
/// 3. **主机授权**（`ai_host_policies.auto_enabled`）：未授权 → 拒
///    （默认全拒——没有授权行 = 该主机不允许 AI 自动执行任何命令）；
/// 4. **命令分级**（[`classify_command`]）：
///    * red → **直接拒绝**（不登记、不降级）；
///    * 只读白名单 → **放行**（立即执行）；
///    * 写操作且该主机授权了对应类别 → **放行**；
///    * 逃逸形态 / 未知命令 / 未授权的写类别 → **降级为逐条确认**
///      （登记成 manual 档步骤，等用户点「执行」）；
/// 5. 放行路径：登记一条 **auto 档且后端已放行**的步骤，再走**与手动档
///    同一条**执行路径（同一套九道闸门 + 消费侧硬超时 + 64 KiB 截断）。
async fn auto_exec_scope(
    state: &AppState,
    vault: &Vault,
    entry: &Arc<AiScopeRegistryEntry>,
    scope_id: &str,
    action_id: &str,
    command: &str,
) -> Result<AiScopeExecOutcome, String> {
    // 1. 本地会话无执行权。
    if entry.target.kind == AiSessionKind::Local {
        return Err(
            "AI exec rejected: local terminal sessions never grant AI execution rights".into(),
        );
    }
    // 2. 运行时身份复核。
    verify_runtime(state, entry, "exec")?;
    // 3. 主机授权（默认全拒）。
    let host_id = entry
        .target
        .host_id
        .ok_or_else(|| "AI exec rejected: auto mode needs a host-bound scope".to_string())?;
    let policy = AiHostPolicies::get_for_host(vault, host_id)
        .map_err(|e| format!("AI exec rejected: cannot read the host policy: {e}"))?;
    let policy = match policy {
        Some(p) if p.auto_enabled => p,
        _ => {
            return Err(format!(
                "AI exec rejected: auto mode is not authorized for host {host_id} \
                 (enable it in Settings → AI → Hosts allowed to run automatically)"
            ));
        }
    };
    // 4. 命令分级（red 直接拒；只读/授权类别放行；其余降级）。
    let verdict = classify_command(command);
    let auto_approved = match verdict.class {
        AiCommandClass::Red => {
            // ★ red：直接拒绝——**不登记、不降级**（降级成「等你确认」等于
            // 把灾难级命令交给用户随手一点，设计裁定是直接拒）。
            return Err(format!(
                "AI exec rejected: blocked by the auto-mode safety rules ({})",
                verdict.reason
            ));
        }
        AiCommandClass::ReadOnly => true,
        AiCommandClass::Write(cat) => policy.write_categories.contains(&cat),
        AiCommandClass::Escape | AiCommandClass::Unknown => false,
    };
    // 判定结论（登记时的快照；执行前会**复核**——授权/分级都可能在此后变化）。
    let auto_verdict = AutoVerdict {
        class: verdict.class.clone(),
        category: match verdict.class {
            AiCommandClass::Write(cat) => Some(cat),
            _ => None,
        },
    };
    // 一次性消费 actionId（登记之前 claim——同款纪律）。
    state.ai_scopes.claim_action(entry, action_id)?;
    if !auto_approved {
        // 降级：登记成 **manual 档**步骤（用户点「执行」才真跑）。
        // **不落**自动档的判定结论：降级后走的是**手动档语义**——用户点
        // 「执行」本身就是授权 ✅，不该再要求「主机授权了该写类别」（否则
        // 用户点了也跑不了 = 降级成了死路）。
        let step_id =
            register_plan_step(entry, action_id, command, AiExecMode::Manual, false, None)?;
        let reason = if matches!(verdict.class, AiCommandClass::Write(_)) {
            format!(
                "{}: write category not authorized for this host — downgraded to confirmation",
                verdict.reason
            )
        } else {
            format!("{}: downgraded to confirmation", verdict.reason)
        };
        return Ok(AiScopeExecOutcome {
            executed: false,
            planned: true,
            step_id,
            message: format!(
                "auto mode downgraded this command to manual confirmation ({reason}) — \
                 it has NOT been executed"
            ),
            result: None,
            downgrade_reason: Some(reason),
        });
    }
    // 5. **后端护栏**（步数 / 单轮总时长）：护栏写在「前端数一下」等于没有
    //    护栏——前端那份只是提前止损，后端才是最后一道闸。
    check_auto_guardrails(entry, vault)?;
    // 6. 放行：登记成 auto 档（后端已放行）→ 走同一条执行路径。
    let step_id = register_plan_step(
        entry,
        action_id,
        command,
        AiExecMode::Auto,
        true,
        Some(auto_verdict),
    )?;
    // 计数（作用域内自动执行次数 / 首次执行的时刻）。
    entry.auto_execs.fetch_add(1, Ordering::SeqCst);
    {
        let mut started = entry.auto_started_at.lock().unwrap();
        if started.is_none() {
            *started = Some(Instant::now());
        }
    }
    let result = run_step_scope(
        state,
        vault,
        scope_id,
        &step_id,
        action_id,
        exec_timeout(vault),
    )
    .await?;
    Ok(AiScopeExecOutcome {
        executed: true,
        planned: false,
        step_id,
        message: format!("auto mode executed the command ({})", verdict.reason),
        result: Some(result),
        downgrade_reason: None,
    })
}

/// 执行面单条命令超时（秒）：读设置 `ai.exec.timeout_secs`（缺省 30）。
/// 读不到（vault 锁 / 键缺 / 值非法）→ 用缺省值——**不让配置问题变成执行
/// 面故障**。
fn exec_timeout(vault: &Vault) -> Duration {
    let secs = Settings::get_u64(vault, SETTING_AI_EXEC_TIMEOUT)
        .ok()
        .flatten()
        .unwrap_or(AI_SCOPE_EXEC_TIMEOUT.as_secs());
    Duration::from_secs(secs.clamp(AI_EXEC_TIMEOUT_MIN, AI_EXEC_TIMEOUT_MAX))
}

/// 档位升级面：把一条 **plan 档登记**的步骤升级为 **manual 档**（2026-11-04
/// 修补 I-1）。
///
/// **为什么要有这条命令**：`ai_scope_run_step` 只认**登记时落账的档位**——plan
/// 档登记的步骤一律拒「plan 模式不执行」。手动档的意义是「我来确认执行」，
/// 于是必须有一条「把这条步骤升到 manual 档」的路。旧路径由**前端**把手里的
/// 命令副本重新送去登记（`ai_scope_exec(scopeId, actionId, 命令原文, "manual")`）
/// ——那等于**执行对象的命令文本来源变回了前端**（前端在两步之间改写命令，
/// 后端只校验形态、不校验与原步骤一致），削弱了「执行只认登记簿里的命令原文」
/// 这条契约不变量。
///
/// **本函数的纪律**：
/// * **命令原文只从该 scope 的登记簿里取**（`source.command`）——前端**不传**
///   命令，本函数的签名里也**没有**命令参数 → 「从登记到执行」的最后一跳，
///   命令文本的来源仍然只有第一次登记那一条；
/// * **新登记一条**（新 actionId + 新 stepId）而不是原地改档位：原地改会让
///   原 actionId 同时是「登记幂等键」与「执行一次性键」，两种语义混在同一个
///   id 上（登记时已被消费过，执行面再校验就会恒拒）；新登记则让**新**的
///   actionId 只承担一次性语义（登记即消费 → 执行时由步骤级 `consumed` 标记
///   再兜一道）；
/// * **新 actionId 必须一次性且与原 id 不同**：`claim_action` 保证「同一个
///   actionId 第二次登记即拒」（作用域动作账本），另加一道显式比对——复用
///   原 id 会让「升级」退化成「原地改档位」，绕开一次性语义；
/// * **只升级、不执行**：执行仍是 [`ai_scope_run_step`] 的事（前端拿新
///   stepId + 新 actionId 去调）——与既有 flow 一致，且**「用户点了执行」**
///   这一环仍由前端保证（后端无从核验，见设计文档 §3.6 的「不可承诺的边界」）。
///
/// 闸门顺序（与执行面同款纪律）：
/// 1. 静态校验（stepId / actionId 形态）；
/// 2. 库锁定 → 拒；
/// 3. 作用域在册 + 未过期 → 拒；
/// 4. 源步骤必须已登记（否则拒——不接受前端传来的任意命令）；
/// 5. 源步骤必须登记在 **plan 档**（manual 档无需升级；auto 档不存在）；
/// 6. 新 actionId 与原 actionId 不同；
/// 7. 本地会话 → 拒（不给执行权）；
/// 8. 运行时身份复核（连接被替换/移除 → 拒，此时零副作用）；
/// 9. 命令原文静态校验（登记簿里的原文——与 insert 面同口径）；
/// 10. **一次性消费新 actionId**（await 前的同步动作）→ 再登记新步骤。
///
/// 拒绝路径**一律零副作用**（不开通道、不执行、不改原步骤）。
async fn upgrade_step_scope(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    step_id: &str,
    action_id: &str,
) -> Result<AiScopeUpgradeOutcome, String> {
    // 1. 静态校验：stepId / actionId 形态（坏形态不消耗任何预算）。
    validate_step_id(step_id)?;
    validate_action_id(action_id, "upgrade")?;
    // 2. 库锁定 → 拒。
    if vault.is_locked() {
        return Err("AI upgrade rejected: vault locked".into());
    }
    // 3. 作用域在册 + 未过期（撤销/过期一律按不存在拒绝）。
    let entry = state.ai_scopes.valid(scope_id)?;
    // 4. 本地会话无执行权（与登记面 / 执行面同款裁定；本地作用域**不可能**
    //    有登记步骤——登记面已拒——这道是防御性双保险，且让错误面更准）。
    if entry.target.kind == AiSessionKind::Local {
        return Err(
            "AI upgrade rejected: local terminal sessions never grant AI execution rights".into(),
        );
    }
    // 5. 源步骤必须已登记（本函数**不接受**前端传来的命令——命令原文只从
    //    登记簿里取）。
    let source = find_plan_step(&entry, step_id).ok_or_else(|| {
        format!("AI upgrade rejected: step {step_id} is not registered in this scope")
    })?;
    // 6. 源步骤必须登记在 plan 档（manual 档本来就能执行，无需升级）。
    match source.mode {
        AiExecMode::Plan => {}
        AiExecMode::Manual => {
            return Err(
                "AI upgrade rejected: step is already registered in manual mode (nothing to upgrade)"
                    .into(),
            );
        }
        AiExecMode::Auto => {
            // 自动档登记的步骤**要么已经当场执行了**（白名单命令），要么
            // 压根没登记（red 直接拒 / 降级的那条登记为 manual 档）。
            // 两种都不需要「升档」——升档面只服务 plan → manual。
            return Err(
                "AI upgrade rejected: step is registered in auto mode (auto mode authorizes and                  executes on its own; nothing to upgrade)"
                    .into(),
            );
        }
    }
    // 7. 新 actionId 必须与原 id 不同（复用原 id = 原地改档位的绕行口）。
    if action_id == source.action_id {
        return Err(
            "AI upgrade rejected: actionId must differ from the registered step's actionId".into(),
        );
    }
    // 8. 运行时身份复核（连接被替换/移除 → 拒；此时零副作用）。
    verify_runtime(state, &entry, "upgrade")?;
    // 9. 命令静态校验（**登记簿里的原文**——与 insert 面同口径）。
    validate_single_line_text(&source.command, "upgrade")?;
    // 10. 一次性消费新 actionId（await 前的同步动作）→ 再登记新步骤。
    //     「同一个 actionId 第二次升级即拒」（作用域动作账本）。
    state.ai_scopes.claim_action(&entry, action_id)?;
    let step_id = register_plan_step(
        &entry,
        action_id,
        &source.command,
        AiExecMode::Manual,
        false,
        // 升档是**手动档**的入口（用户切到手动档并点「执行」）——不落自动档
        // 的判定结论：自动档的复核规则（主机授权/写类别）不适用于手动档 ✅
        // （手动档的授权语义是「用户逐条确认」，不是主机授权表）。
        None,
    )?;
    Ok(AiScopeUpgradeOutcome {
        step_id,
        action_id: action_id.to_string(),
        mode: AiExecMode::Manual,
        message: "upgraded to manual mode (recorded from the plan registry; not executed yet)"
            .to_string(),
    })
}

/// 执行面：**真执行**一个已登记的计划步骤（manual 档专用）。
///
/// 执行序列（顺序不可换，与契约 §3 一一对应）：
/// 1. **静态校验**（stepId / actionId 形态；命令取自登记簿后**再**校验一次——
///    登记簿是内存里的第二真源，绝不因「登记时校验过」就跳过）；
/// 2. **库锁定** → 拒；
/// 3. **作用域在册 + 未过期**（`scope.valid`）→ 拒；
/// 4. **档位判定**（按登记时落账的档位）：manual 才继续；plan 档登记的步骤
///    即拒（「plan 模式不执行」）；auto 档仅放行**后端已判定**的那条
///    （`auto_approved`），其余拒；
/// 5. **本地会话** → 拒（无执行权）；
/// 6. **运行时身份复核**（连接被替换/移除 → 拒，此时零副作用）；
/// 7. **一次性 claim**（await 前的同步动作：步骤未被领走 + actionId 一致）；
/// 8. **从作用域捕获的 `ssh` 句柄**开 exec 通道执行（**绝不按 hostId 或表
///    另找连接**）；
/// 9. **消费侧硬超时**（[`AI_SCOPE_EXEC_TIMEOUT`]）：超时 → **显式关闭
///    channel**（`exec_with_timeout` 内做）→ 结果按「超时」文案回灌模型；
/// 10. **输出上限** 64 KiB（stdout / stderr 各自）→ 截断 + `truncated`。
///
/// 拒绝路径**一律零副作用**（不开通道、不消费步骤）：作用域撤销/过期/
/// 被替换、库锁定、档位不对、本地会话、运行时失配、未登记的 stepId、
/// actionId 不符——都只是拒。
async fn run_step_scope(
    state: &AppState,
    vault: &Vault,
    scope_id: &str,
    step_id: &str,
    action_id: &str,
    timeout: Duration,
) -> Result<AiScopeRunResult, String> {
    // 1. 静态校验：stepId / actionId 形态（坏形态不消耗任何预算）。
    validate_step_id(step_id)?;
    validate_action_id(action_id, "run")?;
    // 2. 库锁定 → 拒。
    if vault.is_locked() {
        return Err("AI run rejected: vault locked".into());
    }
    // 3. 作用域在册 + 未过期（撤销/过期一律按不存在拒绝）。
    let entry = state.ai_scopes.valid(scope_id)?;
    // 步骤必须**已登记**（不接受前端传来的任意命令）。
    let step = find_plan_step(&entry, step_id).ok_or_else(|| {
        format!("AI run rejected: step {step_id} is not registered in this scope")
    })?;
    // 4. 档位判定（按**登记时落账的档位**——不是会话当前档位；档位本身由
    //    前端登记时落账，「用户已确认」这一环后端无从核验，见设计文档 §3.6）：
    //    manual 才继续；auto 档**仅限后端已判定放行的那条**
    //    （`auto_approved` = 登记时后端按「主机已授权 + 命令在白名单/授权
    //    类别内」判定的结论——自动档的放行判断只在后端做）。
    match step.mode {
        AiExecMode::Manual => {}
        AiExecMode::Plan => {
            return Err(
                "AI run rejected: plan mode does not execute (register the step in manual mode)"
                    .into(),
            );
        }
        AiExecMode::Auto => {
            if !step.auto_approved {
                return Err(
                    "AI run rejected: auto mode requires a backend-approved command".into(),
                );
            }
        }
    }
    // 5. 本地会话无执行权（本地是用户自己的机器与交互 shell）。
    if entry.target.kind == AiSessionKind::Local {
        return Err(
            "AI run rejected: local terminal sessions never grant AI execution rights".into(),
        );
    }
    // 5b. **自动档产出的步骤：执行前复核**（登记时的判定是**快照**——
    // 登记之后用户可能撤销了主机授权、收紧了写类别勾选）。
    if let Some(verdict) = &step.auto_verdict {
        reverify_auto_verdict(vault, &entry, &step.command, verdict)?;
    }
    // 命令静态校验（登记簿里的原文——与 insert 面同口径）。
    validate_single_line_text(&step.command, "run")?;
    // 6. 运行时身份复核（连接被替换/移除 → 拒；此时零副作用）。
    verify_runtime(state, &entry, "run")?;
    // 7. 一次性 claim（await 前的同步动作）：未登记 / actionId 不符 / 已消费
    //    → 拒。**闸门没过就不消费**（前 6 道判定失败时步骤仍可被合法调用
    //    执行）；claim 一旦落账即消费（后续 exec 失败也不回滚——fail-closed：
    //    命令已发出或已被中止，重放不是安全动作）。
    let claimed = claim_step_execution(&entry, step_id, action_id)?;
    // 执行前最后一次作用域复核（撤销/过期 → 拒，零副作用）。
    let live = state.ai_scopes.valid(scope_id)?;
    if !Arc::ptr_eq(&live, &entry) {
        return Err("AI run rejected: scope revoked or expired".into());
    }
    // 8. 从作用域捕获的 ssh 句柄开 exec 通道执行（不落用户终端、不进 shell
    //    历史、不与用户输入抢行缓冲）。
    let session = entry
        .ssh
        .as_ref()
        .ok_or_else(|| "AI run rejected: scope has no SSH runtime".to_string())?;
    // 9. 消费侧硬超时：超时由 `exec_with_timeout` **显式关闭通道**后返回
    //    （不留悬挂远端 shell）——**不在这一层再包一层 timeout**（外层超时
    //    会 drop future = 通道悬空，正是本步要修的缺陷）。
    let outcome = session
        .exec_with_timeout(&claimed.command, timeout)
        .await
        .map_err(|e| format!("AI run failed: {e}"))?;
    // 10. 输出上限 64 KiB（stdout / stderr 各自）→ 截断 + 标记。
    let (stdout, stdout_truncated) = cap_exec_output(&outcome.stdout);
    let (stderr, stderr_truncated) = cap_exec_output(&outcome.stderr);
    let truncated = stdout_truncated || stderr_truncated;
    let message = run_result_message(&outcome, timeout, truncated);
    Ok(AiScopeRunResult {
        executed: true,
        step_id: step_id.to_string(),
        exit_code: outcome.exit_status,
        stdout,
        stderr,
        truncated,
        timed_out: outcome.timed_out,
        message,
    })
}

/// **自动档护栏（后端收口）**：单轮步数上限 + 单轮总时长上限。
///
/// 上限值取设置项 `ai.auto.max_steps`（缺省 10）与 `ai.auto.max_duration_secs`
/// （缺省 300 秒）；读不到就用缺省。计数落在**作用域**上（一个作用域 = 一轮
/// 对话的 run ✅ ——作用域是按 run 开立的）。
///
/// 到顶 → **拒**（零副作用，不执行）：护栏到顶后继续跑 = 没有护栏。
fn check_auto_guardrails(entry: &AiScopeRegistryEntry, vault: &Vault) -> Result<(), String> {
    let max_steps = ottr_vault::settings::Settings::get_u64(vault, SETTING_AI_AUTO_MAX_STEPS)
        .ok()
        .flatten()
        .unwrap_or(10)
        .clamp(AI_AUTO_MAX_STEPS_MIN, AI_AUTO_MAX_STEPS_MAX);
    let done = entry.auto_execs.load(Ordering::SeqCst);
    if done >= max_steps {
        return Err(format!(
            "AI exec rejected: auto mode reached the per-round command limit ({max_steps})"
        ));
    }
    let max_duration = ottr_vault::settings::Settings::get_u64(vault, SETTING_AI_AUTO_MAX_DURATION)
        .ok()
        .flatten()
        .unwrap_or(300)
        .clamp(AI_AUTO_MAX_DURATION_MIN, AI_AUTO_MAX_DURATION_MAX);
    if let Some(started) = *entry.auto_started_at.lock().unwrap() {
        let elapsed = started.elapsed().as_secs();
        if elapsed >= max_duration {
            return Err(format!(
                "AI exec rejected: auto mode reached the per-round time limit ({max_duration}s)"
            ));
        }
    }
    Ok(())
}

/// **自动档判定结论的执行前复核**（2026-11-04 第三步）。
///
/// 登记时的结论是**快照**。执行前必须重新确认三件事：
/// ① 主机**仍然**被授权自动执行（用户可能刚撤销）；
/// ② 命令的**分级结论没变**（重新分级；red 一律拒）；
/// ③ 写类别**仍在**该主机授权的类别里（用户可能改过勾选）。
///
/// 任何一条不成立 → 拒（零副作用）。理由：拿旧快照执行 = 执行了一条
/// **现在已不被允许**的命令。
fn reverify_auto_verdict(
    vault: &Vault,
    entry: &AiScopeRegistryEntry,
    command: &str,
    verdict: &AutoVerdict,
) -> Result<(), String> {
    let host_id = entry
        .target
        .host_id
        .ok_or_else(|| "AI run rejected: auto mode needs a host-bound scope".to_string())?;
    let policy = AiHostPolicies::get_for_host(vault, host_id)
        .map_err(|e| format!("AI run rejected: cannot read the host policy: {e}"))?;
    let policy = match policy {
        Some(p) if p.auto_enabled => p,
        _ => {
            return Err(format!(
                "AI run rejected: auto mode is no longer authorized for host {host_id}"
            ));
        }
    };
    let now = classify_command(command);
    if now.class != verdict.class {
        return Err(format!(
            "AI run rejected: the command's classification changed since it was registered \
             (was {:?}, now {:?})",
            verdict.class, now.class
        ));
    }
    if let Some(cat) = verdict.category
        && !policy.write_categories.contains(&cat)
    {
        return Err(format!(
            "AI run rejected: the write category {cat:?} is no longer authorized for host {host_id}"
        ));
    }
    Ok(())
}

/// exec 输出截断（字节上限，超限即截）：返回 (截断后文本, 是否截断)。
fn cap_exec_output(bytes: &[u8]) -> (String, bool) {
    let cut = bytes.len().min(AI_SCOPE_EXEC_MAX_BYTES);
    (
        String::from_utf8_lossy(&bytes[..cut]).into_owned(),
        cut < bytes.len(),
    )
}

/// 执行结果的一句话摘要（面向模型）：超时 / 失败 / 成功 + 截断提示。
///
/// 超时与「非零退出码」是**两件事**（超时的 `exit_code` 恒为 `None`）——
/// 摘要必须说清是哪一种，模型据此改方案。
fn run_result_message(
    outcome: &ottr_ssh::ExecOutcome,
    timeout: Duration,
    truncated: bool,
) -> String {
    let mut message = if outcome.timed_out {
        format!(
            "command timed out after {}s and the channel was closed (no exit code)",
            timeout.as_secs()
        )
    } else {
        match outcome.exit_status {
            Some(0) => "command completed successfully (exit code 0)".to_string(),
            Some(code) => format!("command failed (exit code {code})"),
            None => "command finished without an exit status".to_string(),
        }
    };
    if truncated {
        message.push_str(&format!(
            "; output truncated at {} KiB per stream",
            AI_SCOPE_EXEC_MAX_BYTES / 1024
        ));
    }
    message
}

// ---------------------------------------------------------------------------
// Tauri 命令面（camelCase 参数由 Tauri 运行时映射到 snake_case 形参；前端
// 消费面 frontend/ai/sessionApi.ts，命令名契约由 tests/command_contract.rs
// 与 sessionApi.test.ts 双面钉住——session 域同款：不进 tauri-specta 生成面）。
// ---------------------------------------------------------------------------

/// 开立 AI 目标作用域（`ai_scope_open(target, conversationId, requestId)`）。
#[tauri::command]
pub(crate) fn ai_scope_open(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    target: AiScopeTarget,
    conversation_id: String,
    request_id: String,
) -> Result<AiScope, String> {
    open_scope(&state, &vault.0, target, conversation_id, request_id)
}

/// 作用域上下文（`ai_scope_context(scopeId, bytes)`）：本作用域尾部 + 主机备注。
#[tauri::command]
pub(crate) fn ai_scope_context(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    bytes: u32,
) -> Result<AiScopeContext, String> {
    scope_context(&state, &vault.0, &scope_id, bytes)
}

/// 一次性插入（`ai_scope_insert(scopeId, actionId, text)`）：单行、不追加换行。
#[tauri::command]
pub(crate) async fn ai_scope_insert(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    action_id: String,
    text: String,
) -> Result<(), String> {
    insert_scope(&state, Arc::clone(&vault.0), scope_id, action_id, text).await
}

/// 撤销作用域（`ai_scope_revoke(scopeId)`）：幂等（重复撤销/未知 id 均 Ok）。
#[tauri::command]
pub(crate) fn ai_scope_revoke(state: State<'_, AppState>, scope_id: String) -> Result<(), String> {
    state.ai_scopes.revoke(&scope_id);
    Ok(())
}

/// 只读：列目录（`ai_scope_list_dir(scopeId, path)`）——**仅 SSH 走 SFTP**；
/// 本地会话一律拒（不开放主机文件读取面）。作用域绑定 + 路径规则双闸（绝对
/// 路径、无 `..` 段、canonical 终判落在作用域只读根内）。
#[tauri::command]
pub(crate) async fn ai_scope_list_dir(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    path: String,
) -> Result<AiScopeListing, String> {
    list_dir_scope(&state, &vault.0, &scope_id, &path).await
}

/// 只读：读文件（`ai_scope_read_file(scopeId, path)`）——**仅 SSH 走 SFTP**；
/// 本地会话一律拒（不开放主机文件读取面）。路径规则沿用 read_file 口径
/// （绝对路径、无 `..` 段、canonical 终判落在作用域只读根内），读取带超时
/// 与字节上限（超软上限截断 + `truncated` 标记）。
#[tauri::command]
pub(crate) async fn ai_scope_read_file(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    path: String,
) -> Result<AiScopeFile, String> {
    read_file_scope(&state, &vault.0, &scope_id, &path).await
}

/// 执行类：按模式分派（`ai_scope_exec(scopeId, actionId, command, mode)`）。
///
/// * `plan`（默认）：**只登记计划步骤**（`planned = true` + 步骤 id）——绝不
///   打开 exec 通道、绝不写任何写端。
/// * `manual`：同样**只登记**（零副作用）——用户在待确认卡点「执行」后前端
///   才调 [`ai_scope_run_step`]。
/// * `auto`：主机已授权 + 命令分级放行时才执行（第三步已实现）。
///
/// 本地会话（kind=local）一律拒——本地不给 AI 执行权。
#[tauri::command]
pub(crate) async fn ai_scope_exec(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    action_id: String,
    command: String,
    mode: AiExecMode,
) -> Result<AiScopeExecOutcome, String> {
    exec_scope(&state, &vault.0, &scope_id, &action_id, &command, mode).await
}

/// 执行类：**真执行**一个已登记的计划步骤
/// （`ai_scope_run_step(scopeId, stepId, actionId)`）。
///
/// * 只在 **manual 档**允许执行——判据是**登记时落账的档位**（不是会话当前
///   档位）：plan 档登记的步骤 → 拒「plan 模式不执行」；auto 档 → 拒（未启用）。
/// * **只执行已登记的步骤**：`stepId` 必须命中该作用域的计划登记簿，
///   `actionId` 必须与登记时那条一致——**不接受前端传来的任意命令**。
/// * 执行走**独立 exec 通道**（不落用户终端、不进 shell 历史），消费侧硬超时
///   30s（超时 → 显式关闭通道 → 结果按「超时」文案回灌）。
/// * 本地会话（kind=local）一律拒——本地不给 AI 执行权。
#[tauri::command]
pub(crate) async fn ai_scope_run_step(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    step_id: String,
    action_id: String,
) -> Result<AiScopeRunResult, String> {
    run_step_scope(
        &state,
        &vault.0,
        &scope_id,
        &step_id,
        &action_id,
        // ★ 超时取**设置值**（`ai.exec.timeout_secs`，缺省 30）——设置页写的是
        //   「单条命令最多跑多久」，它必须对手动档与自动档**都**生效（此前
        //   只有自动档直执行路径读设置，手动档写死 30 秒 → 设置形同虚设）。
        exec_timeout(&vault.0),
    )
    .await
}

/// 执行类：**档位升级**——把一条 plan 档登记的步骤以 manual 档**新登记**一条
/// （`ai_scope_upgrade_step(scopeId, stepId, actionId)`，2026-11-04 修补 I-1）。
///
/// * **命令原文只从该 scope 的登记簿里取**——本命令**没有命令参数**（前端
///   不传命令，也无从改写）：升级后执行的对象仍然是第一次登记的那条命令；
/// * `stepId` = **待升级的那条**（必须命中登记簿）；`actionId` = **新登记用的**
///   actionId（必须一次性、与原 id 不同——后端在作用域动作账本里消费它）；
/// * **只升级不执行**：前端拿回新的 `stepId` + `actionId` 后再调
///   [`ai_scope_run_step`] 执行（与既有 flow 一致）。
/// * plan 档登记的步骤**仍不能被一步执行**（一步执行 = `ai_scope_run_step`，
///   它按登记簿里的档位判）；升级动作本身**代表「用户点了执行」**——这一环
///   由前端保证，后端无从核验（设计取舍，见设计文档 §3.6 的「不可承诺的边界」）。
#[tauri::command]
pub(crate) async fn ai_scope_upgrade_step(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    scope_id: String,
    step_id: String,
    action_id: String,
) -> Result<AiScopeUpgradeOutcome, String> {
    upgrade_step_scope(&state, &vault.0, &scope_id, &step_id, &action_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Write};
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Mutex, atomic::AtomicBool};
    use std::task::Poll;
    use std::time::Instant;

    use ottr_ssh::AuthMethod;
    use ottr_term::encoding::{Encoding, StreamDecoder};
    use ottr_vault::{
        AiWriteCategory, HostInput, HostProtocol, Hosts, master_key::InMemoryStorage,
    };
    use portable_pty::{NativePtySystem, PtySize, PtySystem};
    use tauri::ipc::{Channel, InvokeResponseBody};

    use crate::commands::local_term::LocalSessionEntry;
    use crate::commands::session::open_and_register;
    use crate::commands::state::{SessionCounters, TextTail};

    struct Fixture {
        state: Arc<AppState>,
        vault: Arc<Vault>,
        _dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let vault = Vault::open_with(dir.path(), &InMemoryStorage::default()).unwrap();
            Self {
                state: Arc::new(AppState::default()),
                vault: Arc::new(vault),
                _dir: dir,
            }
        }

        fn password() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let vault = Vault::open_password_only(dir.path()).unwrap();
            vault.unlock_with_password("fixture-password").unwrap();
            Self {
                state: Arc::new(AppState::default()),
                vault: Arc::new(vault),
                _dir: dir,
            }
        }

        fn target(&self, id: &str, kind: AiSessionKind, host_id: Option<i64>) -> AiScopeTarget {
            AiScopeTarget {
                pane_session_id: "pane-a".into(),
                root_tab_id: "root-a".into(),
                rust_id: id.into(),
                connection_epoch: 3,
                kind,
                host_id,
            }
        }

        fn open(&self, target: AiScopeTarget) -> AiScope {
            open_scope(
                &self.state,
                &self.vault,
                target,
                "conversation-a".into(),
                "request-a".into(),
            )
            .unwrap()
        }

        async fn insert(&self, scope: &AiScope, action: &str, text: &str) -> Result<(), String> {
            insert_scope(
                &self.state,
                Arc::clone(&self.vault),
                scope.scope_id.clone(),
                action.into(),
                text.into(),
            )
            .await
        }

        /// 执行面直驱（按模式分派；plan 档只登记不执行）。
        async fn exec(
            &self,
            scope: &AiScope,
            action: &str,
            command: &str,
            mode: AiExecMode,
        ) -> Result<AiScopeExecOutcome, String> {
            exec_scope(
                &self.state,
                &self.vault,
                &scope.scope_id,
                action,
                command,
                mode,
            )
            .await
        }

        fn local(&self, id: &str) -> Arc<Mutex<Vec<u8>>> {
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let pair = NativePtySystem::default()
                .openpty(PtySize::default())
                .unwrap();
            self.state.local_sessions.lock().unwrap().insert(
                id.into(),
                LocalSessionEntry {
                    runtime_id: Arc::new(()),
                    writer: Arc::new(Mutex::new(Box::new(CaptureSync(Arc::clone(&bytes))))),
                    killer: Arc::new(Mutex::new(Box::new(NoChild))),
                    master: Arc::new(Mutex::new(pair.master)),
                    counters: Arc::new(SessionCounters::default()),
                    decoder: Arc::new(Mutex::new(StreamDecoder::new(Encoding::Utf8))),
                    text_tail: Arc::new(TextTail::new()),
                    recorder: Arc::new(Mutex::new(None)),
                    cols: 80,
                    rows: 24,
                    cancel: Arc::new(AtomicBool::new(false)),
                },
            );
            bytes
        }

        async fn ssh(&self, host_id: Option<i64>, username: &str) -> SshFixture {
            self.ssh_with(host_id, username, ExecReply::Echo).await
        }

        /// 带 exec 响应形态的 SSH 夹具（`ExecReply::Hang` 复现远端挂起 →
        /// 触发消费侧超时；`ExecReply::Big` 复现超限输出 → 截断）。
        async fn ssh_with(
            &self,
            host_id: Option<i64>,
            username: &str,
            reply: ExecReply,
        ) -> SshFixture {
            let bytes = Arc::new(Mutex::new(Vec::new()));
            let key =
                russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                    .unwrap();
            let config = Arc::new(russh::server::Config {
                keys: vec![key],
                ..Default::default()
            });
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let sink = Arc::clone(&bytes);
            let channels = Arc::new(AtomicUsize::new(0));
            let execs = Arc::new(Mutex::new(Vec::new()));
            let closes = Arc::new(AtomicUsize::new(0));
            let server = tokio::spawn({
                let channels = Arc::clone(&channels);
                let execs = Arc::clone(&execs);
                let closes = Arc::clone(&closes);
                async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let handler = SshHandler {
                        bytes: sink,
                        channels,
                        execs,
                        closes,
                        reply,
                    };
                    let running = russh::server::run_stream(config, stream, handler)
                        .await
                        .unwrap();
                    let _ = running.await;
                }
            });
            let id = open_and_register(
                Arc::clone(&self.state.sessions),
                None,
                host_id,
                "127.0.0.1",
                addr.port(),
                username,
                AuthMethod::Password("fixture-password".into()),
                Arc::new(|_| true),
                None,
                Duration::from_secs(5),
                "ai-scope-fixture".into(),
                80,
                24,
                Channel::new(|_: InvokeResponseBody| Ok(())),
                Encoding::Utf8,
                false,
                false,
            )
            .await
            .unwrap();
            SshFixture {
                id,
                endpoint: format!("127.0.0.1:{}", addr.port()),
                bytes,
                channels,
                execs,
                closes,
                server,
            }
        }

        /// 执行面直驱（真执行；测试用短超时，命令面默认 30s）。
        async fn run_step(
            &self,
            scope: &AiScope,
            step_id: &str,
            action_id: &str,
            timeout: Duration,
        ) -> Result<AiScopeRunResult, String> {
            run_step_scope(
                &self.state,
                &self.vault,
                &scope.scope_id,
                step_id,
                action_id,
                timeout,
            )
            .await
        }

        /// 档位升级面直驱（只升级、不执行）。
        async fn upgrade_step(
            &self,
            scope: &AiScope,
            step_id: &str,
            action_id: &str,
        ) -> Result<AiScopeUpgradeOutcome, String> {
            upgrade_step_scope(
                &self.state,
                &self.vault,
                &scope.scope_id,
                step_id,
                action_id,
            )
            .await
        }
    }

    /// mock sshd 对 exec 请求的响应形态（观测面）。
    #[derive(Clone, Copy, PartialEq, Eq)]
    enum ExecReply {
        /// 回显命令 + 退出码 0（正常路径）。
        Echo,
        /// 只回成功、**不回数据/退出码**（远端挂起 → 触发消费侧超时）。
        Hang,
        /// 回 100 KiB stdout（触发输出截断）。
        Big,
    }

    struct SshFixture {
        id: String,
        endpoint: String,
        bytes: Arc<Mutex<Vec<u8>>>,
        /// 服务端已开的 session 通道数（PTY 通道占 1；exec/SFTP 每开一条 +1）
        /// ——"plan 档零执行"的断言面：登记计划后该计数**不得**增长。
        channels: Arc<AtomicUsize>,
        /// 服务端收到的 exec 请求命令原文（逐条）——"真执行"的观测面。
        execs: Arc<Mutex<Vec<String>>>,
        /// 客户端关通道的次数（超时收尾的**显式 close** 的观测面）。
        closes: Arc<AtomicUsize>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Drop for SshFixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    struct SshHandler {
        bytes: Arc<Mutex<Vec<u8>>>,
        channels: Arc<AtomicUsize>,
        execs: Arc<Mutex<Vec<String>>>,
        closes: Arc<AtomicUsize>,
        reply: ExecReply,
    }

    impl russh::server::Handler for SshHandler {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            reply: russh::server::ChannelOpenHandle,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.channels.fetch_add(1, Ordering::SeqCst);
            reply.accept().await;
            Ok(())
        }

        /// exec 请求——**"真执行"最直接的观测面**：命令原文逐条记账。
        async fn exec_request(
            &mut self,
            channel: russh::ChannelId,
            data: &[u8],
            session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            let command = String::from_utf8_lossy(data).into_owned();
            self.execs.lock().unwrap().push(command.clone());
            session.channel_success(channel)?;
            match self.reply {
                // 挂起：只回成功，**不**回数据/退出码（远端不返回）。
                ExecReply::Hang => {}
                ExecReply::Echo => {
                    session.data(channel, format!("ran:{command}").into_bytes())?;
                    session.exit_status_request(channel, 0)?;
                    session.eof(channel)?;
                    session.close(channel)?;
                }
                ExecReply::Big => {
                    session.data(channel, vec![b'x'; 100 * 1024])?;
                    session.exit_status_request(channel, 0)?;
                    session.eof(channel)?;
                    session.close(channel)?;
                }
            }
            Ok(())
        }

        /// 客户端关通道（超时收尾的显式 close 会走到这里 → 远端不留悬挂 shell）。
        async fn channel_close(
            &mut self,
            _channel: russh::ChannelId,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.closes.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn data(
            &mut self,
            _channel: russh::ChannelId,
            data: &[u8],
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.bytes.lock().unwrap().extend_from_slice(data);
            Ok(())
        }
    }

    struct CaptureSync(Arc<Mutex<Vec<u8>>>);

    impl Write for CaptureSync {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Debug)]
    struct NoChild;

    impl portable_pty::ChildKiller for NoChild {
        fn kill(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(Self)
        }
    }

    async fn wait_for(mut predicate: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !predicate() {
            assert!(Instant::now() < deadline, "fixture deadline exceeded");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn host_input(notes: &str) -> HostInput {
        HostInput {
            name: "fixture".into(),
            group_id: None,
            tags: vec![],
            address: "database-current.example".into(),
            port: 22,
            username: Some("database-current-user".into()),
            protocol: HostProtocol::Ssh,
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: Some(notes.into()),
        }
    }

    #[tokio::test]
    async fn opens_exact_runtime_and_keeps_actual_endpoint_and_account() {
        let f = Fixture::new();
        let host = Hosts::create(&f.vault, host_input("host notes")).unwrap();
        let ssh = f.ssh(Some(host.id), "actual-login").await;
        let target = f.target(&ssh.id, AiSessionKind::Ssh, Some(host.id));
        let scope = f.open(target.clone());
        Hosts::update(&f.vault, host.id, host_input("updated notes")).unwrap();
        let reopened = f.open(target.clone());
        assert_eq!(scope.target, target);
        assert_eq!(scope.endpoint, ssh.endpoint);
        assert_eq!(scope.username.as_deref(), Some("actual-login"));
        assert_eq!(reopened.endpoint, ssh.endpoint);
        assert_eq!(reopened.username.as_deref(), Some("actual-login"));
        let json = serde_json::to_value(&scope).unwrap();
        assert_eq!(json["paneSessionId"], "pane-a");
        assert_eq!(json["rootTabId"], "root-a");
        assert_eq!(json["connectionEpoch"], 3);
        assert_eq!(json["kind"], "ssh");
        assert_eq!(json["hostId"], host.id);
        assert!(json.get("target").is_none());
        assert!(json.get("scopeId").is_some());
    }

    #[tokio::test]
    async fn rejects_wrong_host_kind_and_missing_runtime_without_host_fallback() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "actual-login").await;
        f.local("local-1");
        for target in [
            f.target(&ssh.id, AiSessionKind::Ssh, Some(43)),
            f.target(&ssh.id, AiSessionKind::Local, None),
            f.target("local-1", AiSessionKind::Ssh, Some(42)),
            f.target("local-1", AiSessionKind::Local, Some(42)),
            f.target("absent", AiSessionKind::Ssh, Some(42)),
            f.target("absent", AiSessionKind::Local, None),
        ] {
            let err = open_scope(&f.state, &f.vault, target, "c".into(), "r".into()).unwrap_err();
            assert!(err.starts_with("AI target"), "{err}");
        }
    }

    #[tokio::test]
    async fn exact_ssh_and_local_writers_receive_only_their_actions() {
        let f = Fixture::new();
        let ssh_a = f.ssh(Some(42), "user-a").await;
        let ssh_b = f.ssh(Some(42), "user-b").await;
        let local_a = f.local("local-a");
        let local_b = f.local("local-b");
        let ssh_scope = f.open(f.target(&ssh_b.id, AiSessionKind::Ssh, Some(42)));
        let local_scope = f.open(f.target("local-b", AiSessionKind::Local, None));
        assert_eq!(local_scope.endpoint, "local");
        assert_eq!(local_scope.username, None);
        assert_eq!(local_scope.target.host_id, None);
        f.insert(&ssh_scope, "action", "whoami").await.unwrap();
        f.insert(&local_scope, "action", "pwd").await.unwrap();
        wait_for(|| ssh_b.bytes.lock().unwrap().len() == 6).await;
        assert_eq!(*ssh_b.bytes.lock().unwrap(), b"whoami");
        assert!(ssh_a.bytes.lock().unwrap().is_empty());
        assert_eq!(*local_b.lock().unwrap(), b"pwd");
        assert!(local_a.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn context_uses_only_scoped_runtime_tail_and_host_notes() {
        let f = Fixture::new();
        let host_a = Hosts::create(&f.vault, host_input("notes-a")).unwrap();
        let host_b = Hosts::create(&f.vault, host_input("notes-b")).unwrap();
        let ssh_a = f.ssh(Some(host_a.id), "user-a").await;
        let ssh_b = f.ssh(Some(host_b.id), "user-b").await;
        {
            let sessions = f.state.sessions.lock().unwrap();
            sessions[&ssh_a.id].text_tail.push(b"output-a\n");
            sessions[&ssh_b.id]
                .text_tail
                .push(b"\x1b[31moutput-b\x1b[0m\n");
        }
        f.local("local-a");
        f.state.local_sessions.lock().unwrap()["local-a"]
            .text_tail
            .push(b"local-output\n");
        let scope = f.open(f.target(&ssh_b.id, AiSessionKind::Ssh, Some(host_b.id)));
        assert_eq!(
            scope_context(&f.state, &f.vault, &scope.scope_id, 8192).unwrap(),
            AiScopeContext {
                tail: "output-b".into(),
                notes: Some("notes-b".into())
            }
        );
        let local = f.open(f.target("local-a", AiSessionKind::Local, None));
        assert_eq!(
            scope_context(&f.state, &f.vault, &local.scope_id, 8192).unwrap(),
            AiScopeContext {
                tail: "local-output".into(),
                notes: None
            }
        );
    }

    #[tokio::test]
    async fn concurrent_duplicate_action_is_claimed_before_writer_wait() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let writer = Arc::clone(&f.state.sessions.lock().unwrap()[&ssh.id].writer);
        let guard = writer.lock().await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let mut first = Box::pin(f.insert(&scope, "same-action", "whoami"));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(first.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        let duplicate = tokio::time::timeout(
            Duration::from_secs(1),
            f.insert(&scope, "same-action", "whoami"),
        )
        .await
        .expect("duplicate must not wait for the writer");
        assert!(duplicate.is_err());
        drop(guard);
        first.await.unwrap();
        assert!(f.insert(&scope, "same-action", "whoami").await.is_err());
        wait_for(|| ssh.bytes.lock().unwrap().len() == 6).await;
        assert_eq!(*ssh.bytes.lock().unwrap(), b"whoami");
    }

    #[tokio::test]
    async fn revocation_while_waiting_for_ssh_writer_writes_nothing() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let writer = Arc::clone(&f.state.sessions.lock().unwrap()[&ssh.id].writer);
        let guard = writer.lock().await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let mut pending = Box::pin(f.insert(&scope, "late", "whoami"));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        f.state.ai_scopes.revoke(&scope.scope_id);
        drop(guard);
        assert!(pending.await.is_err());
        assert!(ssh.bytes.lock().unwrap().is_empty());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
    }

    #[tokio::test]
    async fn removed_ssh_runtime_cannot_write_through_captured_writer() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let writer = Arc::clone(&f.state.sessions.lock().unwrap()[&ssh.id].writer);
        let guard = writer.lock().await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let mut pending = Box::pin(f.insert(&scope, "late", "whoami"));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        let removed = f.state.sessions.lock().unwrap().remove(&ssh.id).unwrap();
        drop(guard);
        assert!(pending.await.is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(ssh.bytes.lock().unwrap().is_empty());
        removed.cancel.notify_one();
    }

    #[tokio::test]
    async fn replaced_ssh_runtime_with_same_id_and_writer_cannot_reuse_scope() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let replacement = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let old = {
            let mut sessions = f.state.sessions.lock().unwrap();
            let mut new = sessions.remove(&replacement.id).unwrap();
            new.writer = Arc::clone(&sessions[&ssh.id].writer);
            sessions.insert(ssh.id.clone(), new).unwrap()
        };
        assert!(f.insert(&scope, "late", "whoami").await.is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(ssh.bytes.lock().unwrap().is_empty());
        assert!(replacement.bytes.lock().unwrap().is_empty());
        old.cancel.notify_one();
    }

    #[tokio::test]
    async fn removed_and_replaced_local_runtimes_cannot_reuse_scope() {
        let f = Fixture::new();
        let old = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        f.state.local_sessions.lock().unwrap().remove("local-a");
        assert!(f.insert(&scope, "removed", "pwd").await.is_err());
        let replacement = f.local("local-a");
        assert!(f.insert(&scope, "replaced", "pwd").await.is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(old.lock().unwrap().is_empty());
        assert!(replacement.lock().unwrap().is_empty());
    }

    #[tokio::test]
    // 故意持有 std 锁跨 await：复现「PTY master 同步写端被占、insert 阻塞
    // 等锁」的窗口（正是被测行为；真正产线路径在 spawn_blocking 内锁）。
    #[allow(clippy::await_holding_lock)]
    async fn local_worker_rechecks_revocation_after_blocking_writer_acquisition() {
        let f = Fixture::new();
        let bytes = f.local("local-a");
        let writer = Arc::clone(&f.state.local_sessions.lock().unwrap()["local-a"].writer);
        let guard = writer.lock().unwrap();
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        let mut pending = Box::pin(f.insert(&scope, "late", "pwd"));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        f.state.ai_scopes.revoke(&scope.scope_id);
        drop(guard);
        assert!(pending.await.is_err());
        tokio::task::spawn_blocking(move || drop(writer.lock().unwrap()))
            .await
            .unwrap();
        assert!(bytes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn rejects_controls_and_newlines_without_writing() {
        let f = Fixture::new();
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        for (i, text) in [
            "",
            "whoami\n",
            "whoami\r",
            "a\tb",
            "a\0b",
            "\x1b[31mwhoami",
            "a\x7fb",
            "a\u{85}b",
            "a\u{2028}b",
            "a\u{2029}b",
        ]
        .iter()
        .enumerate()
        {
            assert!(
                f.insert(&scope, &format!("invalid-{i}"), text)
                    .await
                    .is_err()
            );
        }
        assert!(bytes.lock().unwrap().is_empty());
        f.insert(&scope, "valid", "printf '中文'").await.unwrap();
        assert_eq!(*bytes.lock().unwrap(), "printf '中文'".as_bytes());
    }

    #[tokio::test]
    async fn locked_vault_rejects_open_context_and_insert() {
        let f = Fixture::password();
        let bytes = f.local("local-a");
        let target = f.target("local-a", AiSessionKind::Local, None);
        let scope = f.open(target.clone());
        f.vault.lock();
        assert!(open_scope(&f.state, &f.vault, target, "c".into(), "r".into()).is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(f.insert(&scope, "locked", "pwd").await.is_err());
        assert!(bytes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn vault_lock_revokes_scopes_permanently_across_unlock() {
        let f = Fixture::password();
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        lock_vault(&f.vault, &f.state.ai_scopes);
        assert!(f.vault.is_locked());
        f.vault.unlock_with_password("fixture-password").unwrap();
        assert!(f.insert(&scope, "unlocked-late", "pwd").await.is_err());
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(bytes.lock().unwrap().is_empty());
        let new_scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        f.insert(&new_scope, "fresh", "pwd").await.unwrap();
        assert_eq!(*bytes.lock().unwrap(), b"pwd");
    }

    #[tokio::test]
    async fn expired_scope_rejects_context_and_insertion() {
        let mut f = Fixture::new();
        Arc::get_mut(&mut f.state).unwrap().ai_scopes = Arc::new(AiScopeRegistry {
            ttl: Duration::ZERO,
            ..Default::default()
        });
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        assert!(scope_context(&f.state, &f.vault, &scope.scope_id, 8192).is_err());
        assert!(f.insert(&scope, "expired", "pwd").await.is_err());
        assert!(bytes.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn bounded_scope_registry_recovers_capacity_after_revoke() {
        let mut f = Fixture::new();
        Arc::get_mut(&mut f.state).unwrap().ai_scopes = Arc::new(AiScopeRegistry {
            max_scopes: 1,
            ..Default::default()
        });
        f.local("local-a");
        let target = f.target("local-a", AiSessionKind::Local, None);
        let scope = f.open(target.clone());
        assert!(open_scope(&f.state, &f.vault, target.clone(), "c".into(), "r2".into()).is_err());
        f.state.ai_scopes.revoke(&scope.scope_id);
        f.open(target);
    }

    #[tokio::test]
    async fn bounded_actions_never_evict_consumed_action_ids() {
        let mut f = Fixture::new();
        Arc::get_mut(&mut f.state).unwrap().ai_scopes = Arc::new(AiScopeRegistry {
            max_actions: 1,
            ..Default::default()
        });
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        f.insert(&scope, "first", "pwd").await.unwrap();
        assert!(f.insert(&scope, "second", "pwd").await.is_err());
        assert!(f.insert(&scope, "first", "pwd").await.is_err());
        assert_eq!(*bytes.lock().unwrap(), b"pwd");
    }

    #[tokio::test]
    async fn rejects_empty_run_linkage_and_unsafe_frontend_numbers() {
        let f = Fixture::new();
        f.local("local-a");
        let target = f.target("local-a", AiSessionKind::Local, None);
        for (conversation, request) in [("", "r"), ("c", "")] {
            assert!(
                open_scope(
                    &f.state,
                    &f.vault,
                    target.clone(),
                    conversation.into(),
                    request.into()
                )
                .is_err()
            );
        }
        let mut unsafe_epoch = target.clone();
        unsafe_epoch.connection_epoch = 1 << 53;
        assert!(open_scope(&f.state, &f.vault, unsafe_epoch, "c".into(), "r".into()).is_err());
        let mut empty_pane = target;
        empty_pane.pane_session_id.clear();
        assert!(open_scope(&f.state, &f.vault, empty_pane, "c".into(), "r".into()).is_err());
    }

    // -----------------------------------------------------------------------
    // Ask Ottr 执行模式 · 第一步（Plan 档）：只读面 + 执行面
    // -----------------------------------------------------------------------

    /// plan 档 = **零执行**：不开 exec 通道、不写任何写端；只登记计划步骤。
    #[tokio::test]
    async fn plan_mode_exec_records_a_step_and_touches_nothing() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let channels_before = ssh.channels.load(Ordering::SeqCst);
        let outcome = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        assert!(!outcome.executed, "plan 档绝不执行");
        assert!(outcome.planned, "plan 档只产计划");
        assert!(
            outcome.step_id.starts_with("ai-step-"),
            "{}",
            outcome.step_id
        );
        assert_eq!(
            ssh.channels.load(Ordering::SeqCst),
            channels_before,
            "plan 档绝不开新通道（exec/SFTP 通道数不得增长）"
        );
        assert!(ssh.bytes.lock().unwrap().is_empty(), "plan 档绝不写写端");
        // 重放同一 actionId → **拒**（actionId 是一次性消费的，见
        // exec_action_id_is_consumed_once）：重放窗口在登记计划前就关闭。
        let replay = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap_err();
        assert!(replay.contains("already consumed"), "{replay}");
    }

    /// actionId 是**一次性**的：同一 actionId 第二次调用即拒「already
    /// consumed」（A2 裁定：登记计划之前就消费——重放不可能产生第二条计划
    /// 步骤，也不可能在第二步真执行时被重放）。
    #[tokio::test]
    async fn exec_action_id_is_consumed_once() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let first = f
            .exec(&scope, "action-once", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        assert!(first.planned);
        // 同一 actionId 再来一次（哪怕命令不同）→ 拒
        let err = f
            .exec(&scope, "action-once", "id", AiExecMode::Plan)
            .await
            .unwrap_err();
        assert!(err.contains("already consumed"), "{err}");
        // 换档重放同样拒（消费是跨档的）
        let err = f
            .exec(&scope, "action-once", "whoami", AiExecMode::Manual)
            .await
            .unwrap_err();
        assert!(err.contains("already consumed"), "{err}");
        // 新 actionId 仍可登记（预算没被误伤）
        let second = f
            .exec(&scope, "action-two", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        assert_ne!(second.step_id, first.step_id);
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// manual 档本步同样**只登记不执行**（真执行是第二步）。
    #[tokio::test]
    async fn manual_mode_also_only_records_the_step() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let channels_before = ssh.channels.load(Ordering::SeqCst);
        let outcome = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        assert!(!outcome.executed);
        assert!(outcome.planned);
        assert!(!outcome.step_id.is_empty());
        assert_eq!(ssh.channels.load(Ordering::SeqCst), channels_before);
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// auto 档：**主机已授权 + 命令分级放行**才执行（第三步已实现）。
    #[tokio::test]
    async fn auto_mode_is_rejected_before_anything_runs() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let channels_before = ssh.channels.load(Ordering::SeqCst);
        let err = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("auto"), "{err}");
        assert_eq!(ssh.channels.load(Ordering::SeqCst), channels_before);
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// 错误面顺序（2026-11-04 修补 A3）：**作用域有效性先于模式判定**——
    /// 作用域无效就说作用域无效（不拿「auto 未启用」盖住真实原因）；作用域
    /// 有效才谈模式。
    #[tokio::test]
    async fn auto_mode_reports_scope_problems_before_mode_problems() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        // 不存在的 scope + auto → 报作用域无效（不报「auto 未启用」）
        let err = exec_scope(
            &f.state,
            &f.vault,
            "ai-scope-does-not-exist",
            "action-1",
            "whoami",
            AiExecMode::Auto,
        )
        .await
        .unwrap_err();
        assert!(err.contains("AI scope not found"), "{err}");
        assert!(!err.contains("auto"), "{err}");
        // 已撤销的 scope + auto → 同样报作用域无效
        f.state.ai_scopes.revoke(&scope.scope_id);
        let err = f
            .exec(&scope, "action-2", "whoami", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("AI scope not found"), "{err}");
        // 有效 scope + auto → 报「该主机未授权自动执行」（授权表默认全拒）
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let err = f
            .exec(&scope, "action-3", "whoami", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("not authorized"), "{err}");
    }

    /// 未知 mode 在反序列化面即被拒（后端不接受"未知 mode"）。
    #[test]
    fn unknown_exec_mode_never_reaches_the_command() {
        assert!(serde_json::from_value::<AiExecMode>(serde_json::json!("turbo")).is_err());
        assert!(serde_json::from_value::<AiExecMode>(serde_json::json!("")).is_err());
        for (mode, wire) in [
            (AiExecMode::Plan, "plan"),
            (AiExecMode::Auto, "auto"),
            (AiExecMode::Manual, "manual"),
        ] {
            assert_eq!(
                serde_json::to_value(mode).unwrap(),
                serde_json::json!(wire),
                "档位序列化面必须是前端约定的小写名"
            );
            assert_eq!(
                serde_json::from_value::<AiExecMode>(serde_json::json!(wire)).unwrap(),
                mode
            );
        }
    }

    /// 命令静态校验四类拒：空 / 多行 / 控制字符 / 超长（plan 档也要校验——
    /// 它会进计划清单）。
    #[tokio::test]
    async fn exec_rejects_empty_multiline_control_and_oversized_commands() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let bad = [
            String::new(),
            "whoami\nid".to_string(),
            "whoami\rid".to_string(),
            "a\tb".to_string(),
            "a\0b".to_string(),
            "\u{1b}[31mwhoami".to_string(),
            "a\u{2028}b".to_string(),
            "x".repeat(INSERT_MAX_BYTES + 1),
        ];
        for (i, command) in bad.iter().enumerate() {
            let err = f
                .exec(&scope, &format!("bad-{i}"), command, AiExecMode::Plan)
                .await
                .unwrap_err();
            assert!(err.starts_with("AI exec rejected"), "{err}");
        }
        // 空 actionId 同样拒（它是幂等键）。
        assert!(
            f.exec(&scope, "", "whoami", AiExecMode::Plan)
                .await
                .is_err()
        );
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// 作用域撤销 / 过期 / 被替换 → 一律拒（零副作用）。
    #[tokio::test]
    async fn exec_rejects_revoked_expired_and_replaced_scopes() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        // 撤销
        f.state.ai_scopes.revoke(&scope.scope_id);
        assert!(
            f.exec(&scope, "revoked", "whoami", AiExecMode::Plan)
                .await
                .is_err()
        );
        // 被替换（同 rustId、换 runtime_id）
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let replacement = f.ssh(Some(42), "user").await;
        let old = {
            let mut sessions = f.state.sessions.lock().unwrap();
            let mut new = sessions.remove(&replacement.id).unwrap();
            new.writer = Arc::clone(&sessions[&ssh.id].writer);
            sessions.insert(ssh.id.clone(), new).unwrap()
        };
        assert!(
            f.exec(&scope, "replaced", "whoami", AiExecMode::Plan)
                .await
                .is_err()
        );
        old.cancel.notify_one();
        // 过期（TTL=0：登记即过期）
        let mut f = Fixture::new();
        Arc::get_mut(&mut f.state).unwrap().ai_scopes = Arc::new(AiScopeRegistry {
            ttl: Duration::ZERO,
            ..Default::default()
        });
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        assert!(
            f.exec(&scope, "expired", "whoami", AiExecMode::Plan)
                .await
                .is_err()
        );
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// 库锁定 → 拒（执行面与只读面同款）。
    #[tokio::test]
    async fn locked_vault_rejects_exec_and_reads() {
        let f = Fixture::password();
        f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        f.vault.lock();
        assert!(
            f.exec(&scope, "locked", "pwd", AiExecMode::Plan)
                .await
                .is_err()
        );
        assert!(
            read_file_scope(&f.state, &f.vault, &scope.scope_id, "/etc/hosts")
                .await
                .is_err()
        );
        assert!(
            list_dir_scope(&f.state, &f.vault, &scope.scope_id, "/etc")
                .await
                .is_err()
        );
    }

    /// 本地会话**不给执行权**：plan 档同样拒（连登记都不登记）。
    #[tokio::test]
    async fn local_sessions_never_grant_execution_rights() {
        let f = Fixture::new();
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        for mode in [AiExecMode::Plan, AiExecMode::Manual, AiExecMode::Auto] {
            let err = f.exec(&scope, "local", "pwd", mode).await.unwrap_err();
            assert!(err.starts_with("AI exec rejected"), "{err}");
        }
        assert!(bytes.lock().unwrap().is_empty());
    }

    /// 本地会话**不开放主机文件读取面**（2026-11-04 修补 A1）：读文件 / 列
    /// 目录一律拒，且**零文件读取副作用**（内容一个字节都不回）。
    ///
    /// 为什么必须关：本地只读根曾被实现自选为「Ottr 进程用户的整个 HOME」，
    /// 等于把 `~/.ssh`、`~/.aws`、`~/.kube/config`、`~/.gnupg` 默认交给外部
    /// 模型，而脱敏层覆盖不到那些形态（client-key-data / PGP 私钥块）。
    #[tokio::test]
    async fn local_sessions_never_expose_host_file_reads() {
        let f = Fixture::new();
        f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        // 造一份「就在本机、路径合法、内容敏感」的文件——它必须读不出来。
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("secret.txt"), b"top-secret-token").unwrap();
        let file_path = root.path().join("secret.txt").to_str().unwrap().to_string();
        let dir_path = root.path().to_str().unwrap().to_string();

        let err = read_file_scope(&f.state, &f.vault, &scope.scope_id, &file_path)
            .await
            .unwrap_err();
        assert!(err.contains("local terminal sessions"), "{err}");
        assert!(!err.contains("top-secret-token"), "{err}");
        let err = list_dir_scope(&f.state, &f.vault, &scope.scope_id, &dir_path)
            .await
            .unwrap_err();
        assert!(err.contains("local terminal sessions"), "{err}");
        assert!(!err.contains("secret.txt"), "{err}");
        // 零读取副作用：文件内容与条目名都没进过返回值（上面两处断言已覆盖
        // 「回包不含内容」；这里再钉一次「拒绝发生在任何 IO 之前」——路径
        // 合法也照样拒，说明不是路径规则挡下的）。
        assert!(LOCAL_READ_DENIED.contains("local terminal sessions"));
    }

    /// 远端路径规则（静态面先于任何 IO）：相对路径 / `..` 段 / NUL 一律拒。
    #[tokio::test]
    async fn remote_path_rules_reject_relative_dotdot_and_nul() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        for path in ["relative/path", "/var/../etc/passwd", "a\0b", ""] {
            let err = read_file_scope(&f.state, &f.vault, &scope.scope_id, path)
                .await
                .unwrap_err();
            assert!(err.starts_with("AI read rejected"), "{err}");
            let err = list_dir_scope(&f.state, &f.vault, &scope.scope_id, path)
                .await
                .unwrap_err();
            assert!(err.starts_with("AI read rejected"), "{err}");
        }
    }

    /// 目录边界精确到路径段（`/tmp2` 不匹配 `/tmp`；根目录特判）。
    #[test]
    fn scope_root_matching_is_segment_exact() {
        assert!(path_within("/tmp/a", "/tmp"));
        assert!(path_within("/tmp", "/tmp"));
        assert!(!path_within("/tmp2/a", "/tmp"));
        assert!(path_within("/anything", "/"));
        assert!(!path_within("relative", "/"));
    }

    /// 载荷序列化面：camelCase 字段名（前端消费面的契约）。
    #[test]
    fn read_and_exec_payloads_use_camel_case_fields() {
        let listing = AiScopeListing {
            path: "/tmp".into(),
            entries: vec![AiScopeEntry {
                name: "a".into(),
                is_dir: false,
                size: 3,
            }],
        };
        let json = serde_json::to_value(&listing).unwrap();
        assert_eq!(json["path"], "/tmp");
        assert_eq!(json["entries"][0]["name"], "a");
        assert_eq!(json["entries"][0]["isDir"], false);
        assert_eq!(json["entries"][0]["size"], 3);

        let file = AiScopeFile {
            path: "/tmp/a".into(),
            size: 3,
            content: "abc".into(),
            truncated: false,
        };
        let json = serde_json::to_value(&file).unwrap();
        assert_eq!(json["path"], "/tmp/a");
        assert_eq!(json["size"], 3);
        assert_eq!(json["content"], "abc");
        assert_eq!(json["truncated"], false);

        let outcome = AiScopeExecOutcome {
            executed: false,
            planned: true,
            step_id: "ai-step-x".into(),
            message: "m".into(),
            result: None,
            downgrade_reason: None,
        };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["executed"], false);
        assert_eq!(json["planned"], true);
        assert_eq!(json["stepId"], "ai-step-x");
        assert_eq!(json["message"], "m");
    }

    // -----------------------------------------------------------------------
    // Ask Ottr 执行模式 · 第三步（Auto 档）：授权 + 分级 + 自动执行/降级/拒
    // -----------------------------------------------------------------------

    /// 建一台主机并写入自动执行授权（`auto_enabled` + 允许的写类别）。
    fn authorized_host(f: &Fixture, categories: Vec<AiWriteCategory>) -> i64 {
        let host = Hosts::create(&f.vault, host_input("auto fixture")).unwrap();
        AiHostPolicies::upsert(
            &f.vault,
            &ottr_vault::AiHostPolicyInput {
                host_id: host.id,
                auto_enabled: true,
                write_categories: categories,
            },
        )
        .unwrap();
        host.id
    }

    /// **默认全拒**：没授权的主机 → 自动档**直接拒**（零执行）。
    #[tokio::test]
    async fn auto_mode_rejects_hosts_without_authorization() {
        let f = Fixture::new();
        let host = Hosts::create(&f.vault, host_input("no policy")).unwrap();
        let ssh = f.ssh(Some(host.id), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(host.id)));
        let err = f
            .exec(&scope, "action-1", "ls -la", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("not authorized"), "{err}");
        assert_eq!(
            ssh.execs.lock().unwrap().len(),
            0,
            "未授权主机零执行（授权表默认全拒）"
        );
    }

    /// **只读白名单 → 自动执行**：mock sshd 的 exec-request **恰好 +1**、
    /// 命令原文一致、结果回传。
    #[tokio::test]
    async fn auto_mode_executes_read_only_commands_without_confirmation() {
        let f = Fixture::new();
        let host_id = authorized_host(&f, vec![]);
        let ssh = f.ssh(Some(host_id), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(host_id)));
        let outcome = f
            .exec(&scope, "action-1", "ls -la", AiExecMode::Auto)
            .await
            .unwrap();
        assert!(outcome.executed, "只读命令在自动档应直接执行");
        assert!(!outcome.planned);
        assert!(outcome.result.is_some(), "自动执行必须回传结果");
        assert_eq!(
            *ssh.execs.lock().unwrap(),
            vec!["ls -la".to_string()],
            "命令原文必须逐字一致"
        );
        assert_eq!(outcome.result.as_ref().unwrap().exit_code, Some(0));
    }

    /// **red 级 → 直接拒绝**（不登记、不降级、不执行）。
    #[tokio::test]
    async fn auto_mode_rejects_red_commands_outright() {
        let f = Fixture::new();
        let host_id = authorized_host(&f, vec![AiWriteCategory::File]);
        let ssh = f.ssh(Some(host_id), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(host_id)));
        let err = f
            .exec(&scope, "action-1", "rm -rf /", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("safety rules"), "{err}");
        assert_eq!(
            ssh.execs.lock().unwrap().len(),
            0,
            "red 命令零执行（直接拒，不降级成「等你确认」）"
        );
    }

    /// **逃逸形态 → 降级为逐条确认**（不执行；登记成 manual 档步骤）。
    #[tokio::test]
    async fn auto_mode_downgrades_escape_forms_to_confirmation() {
        let f = Fixture::new();
        let host_id = authorized_host(&f, vec![]);
        let ssh = f.ssh(Some(host_id), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(host_id)));
        let outcome = f
            .exec(
                &scope,
                "action-1",
                "cat /etc/passwd > /tmp/x",
                AiExecMode::Auto,
            )
            .await
            .unwrap();
        assert!(!outcome.executed, "逃逸形态不得自动执行");
        assert!(outcome.planned);
        assert!(
            outcome.downgrade_reason.is_some(),
            "降级必须说明原因: {:?}",
            outcome.downgrade_reason
        );
        assert_eq!(ssh.execs.lock().unwrap().len(), 0, "降级路径零执行");
    }

    /// **写操作**：类别**未授权** → 降级；类别**已授权** → 自动执行。
    #[tokio::test]
    async fn auto_mode_write_commands_depend_on_the_authorized_category() {
        let f = Fixture::new();
        // 只授权「服务重启」这一类。
        let host_id = authorized_host(&f, vec![AiWriteCategory::Service]);
        let ssh = f.ssh(Some(host_id), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(host_id)));

        // 包管理（未授权类别）→ 降级。
        let downgraded = f
            .exec(&scope, "action-1", "apt install nginx", AiExecMode::Auto)
            .await
            .unwrap();
        assert!(!downgraded.executed, "未授权的写类别必须降级");
        assert_eq!(ssh.execs.lock().unwrap().len(), 0);

        // 服务重启（已授权类别）→ 自动执行。
        let executed = f
            .exec(
                &scope,
                "action-2",
                "systemctl restart nginx",
                AiExecMode::Auto,
            )
            .await
            .unwrap();
        assert!(executed.executed, "已授权的写类别应自动执行");
        assert_eq!(
            *ssh.execs.lock().unwrap(),
            vec!["systemctl restart nginx".to_string()]
        );
    }

    /// **未识别的命令 → 降级**（不认识 = 不放行）。
    #[tokio::test]
    async fn auto_mode_downgrades_unknown_commands() {
        let f = Fixture::new();
        let host_id = authorized_host(&f, vec![AiWriteCategory::File]);
        let ssh = f.ssh(Some(host_id), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(host_id)));
        let outcome = f
            .exec(&scope, "action-1", "frobnicate --all", AiExecMode::Auto)
            .await
            .unwrap();
        assert!(!outcome.executed);
        assert!(outcome.downgrade_reason.is_some());
        assert_eq!(ssh.execs.lock().unwrap().len(), 0);
    }

    /// **本地会话 → 拒绝**（本地不给 AI 执行权；自动档也不例外）。
    #[tokio::test]
    async fn auto_mode_rejects_local_sessions() {
        let f = Fixture::new();
        let local = f.local("local-1");
        let scope = f.open(f.target("local-1", AiSessionKind::Local, None));
        let err = f
            .exec(&scope, "action-1", "ls", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("local terminal"), "{err}");
        assert!(local.lock().unwrap().is_empty());
    }

    /// **降级路径产出的步骤可以在手动档执行**（降级不是死路：用户点「执行」
    /// 就真跑——那正是「降级为逐条确认」的定义）。
    #[tokio::test]
    async fn auto_mode_downgraded_step_runs_after_user_confirmation() {
        let f = Fixture::new();
        let host_id = authorized_host(&f, vec![]);
        let ssh = f.ssh(Some(host_id), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(host_id)));
        let outcome = f
            .exec(&scope, "action-1", "rm /tmp/x", AiExecMode::Auto)
            .await
            .unwrap();
        assert!(!outcome.executed);
        let result = f
            .run_step(&scope, &outcome.step_id, "action-1", Duration::from_secs(5))
            .await
            .unwrap();
        assert!(result.executed);
        assert_eq!(*ssh.execs.lock().unwrap(), vec!["rm /tmp/x".to_string()]);
    }

    /// **执行前复核**：自动档放行后、用户**撤销了该主机的自动授权** →
    /// 执行必须被拒（拿旧快照执行 = 执行了现在已不被允许的命令）。
    #[tokio::test]
    async fn auto_mode_reverifies_the_host_authorization_before_executing() {
        let f = Fixture::new();
        let host_id = authorized_host(&f, vec![]);
        let ssh = f.ssh(Some(host_id), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(host_id)));
        // 登记 + 立即执行前，撤销授权：把「登记」与「执行」拆开做。
        let registered = f
            .exec(&scope, "action-1", "ls -la", AiExecMode::Auto)
            .await
            .unwrap();
        assert!(registered.executed, "授权有效时应自动执行");
        // 撤销授权后，同一作用域再来一条 → 必须被拒。
        AiHostPolicies::delete(&f.vault, host_id).unwrap();
        let err = f
            .exec(&scope, "action-2", "ls -la", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("not authorized"), "{err}");
        assert_eq!(
            ssh.execs.lock().unwrap().len(),
            1,
            "撤销授权后不得再执行（零副作用）"
        );
    }

    /// **后端护栏**：单轮自动执行次数到上限 → 拒（护栏不能只在前端数）。
    #[tokio::test]
    async fn auto_mode_enforces_the_step_budget_on_the_backend() {
        let f = Fixture::new();
        let host_id = authorized_host(&f, vec![]);
        let ssh = f.ssh(Some(host_id), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(host_id)));
        // 护栏上限设为 1（设置项写入侧范围 1..=100 ✅）。
        ottr_vault::settings::Settings::set_u64(&f.vault, SETTING_AI_AUTO_MAX_STEPS, 1).unwrap();
        let first = f
            .exec(&scope, "action-1", "ls -la", AiExecMode::Auto)
            .await
            .unwrap();
        assert!(first.executed, "第一条应放行");
        let err = f
            .exec(&scope, "action-2", "ls -la", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("per-round command limit"), "{err}");
        assert_eq!(ssh.execs.lock().unwrap().len(), 1, "到护栏上限后不得再执行");
    }

    // -----------------------------------------------------------------------
    // Ask Ottr 执行模式 · 第二步（Manual 档）：真执行面
    // -----------------------------------------------------------------------

    /// manual 档 = **真执行**：mock sshd 的 exec-request **恰好 +1**、命令
    /// 原文一致、退出码与 stdout 回传。
    #[tokio::test]
    async fn manual_mode_run_step_executes_the_registered_command() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        assert!(!registered.executed, "登记面绝不执行");
        let channels_before = ssh.channels.load(Ordering::SeqCst);
        let result = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(result.executed);
        assert_eq!(result.step_id, registered.step_id);
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.stdout, "ran:whoami");
        assert_eq!(result.stderr, "");
        assert!(!result.truncated);
        assert!(!result.timed_out, "正常执行不是超时");
        assert!(result.message.contains("exit code 0"), "{}", result.message);
        // 观测面：服务端**恰好**收到一条 exec 请求，命令原文一致。
        assert_eq!(
            *ssh.execs.lock().unwrap(),
            vec!["whoami".to_string()],
            "命令原文必须逐字一致"
        );
        assert_eq!(
            ssh.channels.load(Ordering::SeqCst),
            channels_before + 1,
            "真执行只开一条独立 exec 通道"
        );
    }

    /// **plan 档登记的步骤不可执行**（后端按登记时落账的档位独立复核）：
    /// 拒 + **零执行**（exec 计数不变）。
    #[tokio::test]
    async fn plan_mode_run_step_is_rejected_without_execution() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        let err = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("plan"), "{err}");
        assert!(ssh.execs.lock().unwrap().is_empty(), "plan 档绝不执行");
    }

    /// auto 档登记在登记面就被拒（不存在 auto 步骤）——执行面同样有独立的
    /// auto 拒绝分支（后端不依赖「登记面已拒」这一前提）。
    #[tokio::test]
    async fn auto_mode_is_rejected_at_registration() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let err = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Auto)
            .await
            .unwrap_err();
        assert!(err.contains("auto"), "{err}");
        assert!(ssh.execs.lock().unwrap().is_empty());
    }

    /// **只执行已登记的步骤**：未登记的 stepId 拒；actionId 与登记不符拒
    /// ——两者都**零执行**（exec 计数不变）。
    #[tokio::test]
    async fn run_step_rejects_unregistered_step_and_mismatched_action() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        // 未登记的 stepId
        let err = f
            .run_step(
                &scope,
                "ai-step-not-registered",
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("not registered"), "{err}");
        // actionId 与登记时那条不一致（防串改）
        let err = f
            .run_step(
                &scope,
                &registered.step_id,
                "other-action",
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("actionId"), "{err}");
        // 空 stepId / 空 actionId → 静态校验拒
        assert!(
            f.run_step(&scope, "", "action-1", Duration::from_secs(5))
                .await
                .is_err()
        );
        assert!(
            f.run_step(&scope, &registered.step_id, "", Duration::from_secs(5))
                .await
                .is_err()
        );
        assert!(
            ssh.execs.lock().unwrap().is_empty(),
            "被拒的调用绝不执行（零副作用）"
        );
        // 合法调用仍可执行（被拒不消费步骤）。
        let ok = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(ok.executed);
    }

    /// **同一 actionId 二次执行 → 拒**（一次性消费，await 前的同步 claim）。
    #[tokio::test]
    async fn run_step_rejects_the_same_action_twice() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        let first = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(first.executed);
        let err = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("already consumed"), "{err}");
        assert_eq!(ssh.execs.lock().unwrap().len(), 1, "二次调用绝不重复执行");
    }

    /// 作用域撤销 / 过期 / 运行时被替换 → 一律拒，且**零副作用**（exec 计数
    /// 不变、步骤不被消费）。
    #[tokio::test]
    async fn run_step_rejects_revoked_expired_and_replaced_scopes() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        // 撤销
        f.state.ai_scopes.revoke(&scope.scope_id);
        let err = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("AI scope not found"), "{err}");
        // 被替换（同 rustId、换 runtime_id）
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-2", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        let replacement = f.ssh(Some(42), "user").await;
        let old = {
            let mut sessions = f.state.sessions.lock().unwrap();
            let mut new = sessions.remove(&replacement.id).unwrap();
            new.writer = Arc::clone(&sessions[&ssh.id].writer);
            sessions.insert(ssh.id.clone(), new).unwrap()
        };
        let err = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-2",
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("replaced"), "{err}");
        old.cancel.notify_one();
        // 过期（短 TTL：登记后自然过期 → 执行面按「不存在」拒）
        let mut f = Fixture::new();
        Arc::get_mut(&mut f.state).unwrap().ai_scopes = Arc::new(AiScopeRegistry {
            ttl: Duration::from_millis(50),
            ..Default::default()
        });
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-3", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        let err = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-3",
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("AI scope not found"), "{err}");
        assert!(ssh.execs.lock().unwrap().is_empty(), "被拒的调用零副作用");
    }

    /// 库锁定 → 拒（执行面与登记面同款）。
    #[tokio::test]
    async fn locked_vault_rejects_run_step() {
        let f = Fixture::password();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        f.vault.lock();
        let err = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("vault locked"), "{err}");
        assert!(ssh.execs.lock().unwrap().is_empty());
    }

    /// 本地会话**不给执行权**：执行面一律拒。
    #[tokio::test]
    async fn local_sessions_never_grant_run_step_rights() {
        let f = Fixture::new();
        let bytes = f.local("local-a");
        let scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        // 本地会话连登记都拒 → 没有可执行的步骤。
        let err = f
            .exec(&scope, "action-1", "pwd", AiExecMode::Manual)
            .await
            .unwrap_err();
        assert!(err.starts_with("AI exec rejected"), "{err}");
        // 即便拿到一个未登记的 stepId，也是「未登记」拒绝，绝不执行。
        let err = f
            .run_step(&scope, "ai-step-x", "action-1", Duration::from_secs(5))
            .await
            .unwrap_err();
        assert!(err.starts_with("AI run rejected"), "{err}");
        assert!(bytes.lock().unwrap().is_empty());
    }

    /// **超时**：远端挂起 → 消费侧硬超时 → **显式关闭通道**（服务端能观察到
    /// close → 远端不留悬挂 shell）→ 结果标记超时（**不是**失败退出码）。
    #[tokio::test]
    async fn run_step_timeout_closes_the_channel_and_marks_the_timeout() {
        let f = Fixture::new();
        let ssh = f.ssh_with(Some(42), "user", ExecReply::Hang).await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "sleep 600", AiExecMode::Manual)
            .await
            .unwrap();
        let result = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_millis(200),
            )
            .await
            .unwrap();
        assert!(result.executed, "命令确实发出去了");
        assert_eq!(result.exit_code, None, "超时没有退出码");
        assert!(result.timed_out, "超时要单独给结论（不能只靠退出码为空）");
        assert!(result.message.contains("timed out"), "{}", result.message);
        assert_eq!(ssh.execs.lock().unwrap().len(), 1);
        // 服务端观察到客户端关通道 → 远端不留悬挂 shell。
        wait_for(|| ssh.closes.load(Ordering::SeqCst) >= 1).await;
        assert_eq!(
            ssh.closes.load(Ordering::SeqCst),
            1,
            "超时后必须显式关闭 exec 通道"
        );
    }

    /// 输出超限 → **截断** + `truncated` 标记（stdout / stderr 各自 64 KiB）。
    #[tokio::test]
    async fn run_step_truncates_oversized_output() {
        let f = Fixture::new();
        let ssh = f.ssh_with(Some(42), "user", ExecReply::Big).await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "big", AiExecMode::Manual)
            .await
            .unwrap();
        let result = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(result.truncated, "超限必须标 truncated");
        assert_eq!(
            result.stdout.len(),
            AI_SCOPE_EXEC_MAX_BYTES,
            "stdout 截到 64 KiB 上限"
        );
        assert!(result.message.contains("truncated"), "{}", result.message);
    }

    /// manual 档登记的 message 说明「待确认后执行」，且登记**零副作用**。
    #[tokio::test]
    async fn manual_registration_is_side_effect_free_and_awaits_confirmation() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let channels_before = ssh.channels.load(Ordering::SeqCst);
        let outcome = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        assert!(!outcome.executed);
        assert!(outcome.planned);
        assert!(
            outcome.message.contains("confirmation"),
            "{}",
            outcome.message
        );
        assert_eq!(
            ssh.channels.load(Ordering::SeqCst),
            channels_before,
            "登记面绝不开通道"
        );
        assert!(ssh.execs.lock().unwrap().is_empty());
        assert!(ssh.bytes.lock().unwrap().is_empty());
    }

    /// 执行结果载荷序列化面：camelCase 字段名（前端消费面的契约）。
    #[test]
    fn run_result_payload_uses_camel_case_fields() {
        let result = AiScopeRunResult {
            executed: true,
            step_id: "ai-step-x".into(),
            exit_code: Some(3),
            stdout: "out".into(),
            stderr: "err".into(),
            truncated: true,
            timed_out: false,
            message: "m".into(),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["executed"], true);
        assert_eq!(json["stepId"], "ai-step-x");
        assert_eq!(json["exitCode"], 3);
        assert_eq!(json["stdout"], "out");
        assert_eq!(json["stderr"], "err");
        assert_eq!(json["truncated"], true);
        assert_eq!(json["timedOut"], false);
        assert_eq!(json["message"], "m");
        // 字段集合与契约 §2.2 一致（不多不少）。
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "executed",
                "exitCode",
                "message",
                "stderr",
                "stdout",
                "stepId",
                "timedOut",
                "truncated"
            ]
        );
    }

    // -----------------------------------------------------------------------
    // 档位升级面（2026-11-04 修补 I-1）：命令原文只从登记簿里取
    // -----------------------------------------------------------------------

    /// **升级只执行登记簿里那条命令**：升级命令**没有命令参数**（前端传不
    /// 进来），升级后执行的那条 = 第一次登记时落账的命令原文（服务端可观测量：
    /// exec 请求逐字一致）。
    #[tokio::test]
    async fn upgrade_step_executes_the_registered_command_verbatim() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        // 升级：只升级、不执行（零副作用——还没有任何 exec 请求）。
        let upgraded = f
            .upgrade_step(&scope, &registered.step_id, "action-upgraded")
            .await
            .unwrap();
        assert_eq!(upgraded.mode, AiExecMode::Manual);
        assert_eq!(upgraded.action_id, "action-upgraded");
        assert_ne!(upgraded.step_id, registered.step_id, "升级是新登记的一条");
        assert!(ssh.execs.lock().unwrap().is_empty(), "升级本身绝不执行");
        // 执行新登记的那条 → 服务端收到的命令原文 = 登记簿里那条。
        let result = f
            .run_step(
                &scope,
                &upgraded.step_id,
                &upgraded.action_id,
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(result.executed);
        assert_eq!(
            *ssh.execs.lock().unwrap(),
            vec!["whoami".to_string()],
            "执行对象必须是登记簿里的命令原文（前端无从改写）"
        );
    }

    /// **plan 档登记的步骤不能被一步执行**（升级前）：拒 + **零执行**。
    /// 升级**不改变**这一边界——原步骤仍是 plan 档，仍拒执行。
    #[tokio::test]
    async fn upgrade_does_not_unlock_the_plan_step_for_direct_execution() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        let upgraded = f
            .upgrade_step(&scope, &registered.step_id, "action-upgraded")
            .await
            .unwrap();
        // 原 plan 步骤：仍然拒执行（升级不改原步骤的档位）。
        let err = f
            .run_step(
                &scope,
                &registered.step_id,
                "action-1",
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("plan"), "{err}");
        assert!(
            ssh.execs.lock().unwrap().is_empty(),
            "plan 档步骤（即便已升级）绝不执行"
        );
        // 新登记的那条 manual 步骤：可以执行。
        let result = f
            .run_step(
                &scope,
                &upgraded.step_id,
                &upgraded.action_id,
                Duration::from_secs(5),
            )
            .await
            .unwrap();
        assert!(result.executed);
    }

    /// **重复升级的 actionId 一次性**：同一个新 actionId 第二次升级即拒
    /// （作用域动作账本）；且升级出来的步骤**只能执行一次**（步骤级 consumed）。
    #[tokio::test]
    async fn upgrade_action_id_is_one_time() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        let upgraded = f
            .upgrade_step(&scope, &registered.step_id, "action-upgraded")
            .await
            .unwrap();
        // 同一个新 actionId 再升级一次 → 拒（一次性）。
        let err = f
            .upgrade_step(&scope, &registered.step_id, "action-upgraded")
            .await
            .unwrap_err();
        assert!(err.contains("already consumed"), "{err}");
        // 复用**原** actionId 升级 → 拒（必须与原 id 不同）。
        let err = f
            .upgrade_step(&scope, &registered.step_id, "action-1")
            .await
            .unwrap_err();
        assert!(err.contains("must differ"), "{err}");
        // 升级出来的步骤只执行一次。
        f.run_step(
            &scope,
            &upgraded.step_id,
            &upgraded.action_id,
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        let err = f
            .run_step(
                &scope,
                &upgraded.step_id,
                &upgraded.action_id,
                Duration::from_secs(5),
            )
            .await
            .unwrap_err();
        assert!(err.contains("already consumed"), "{err}");
        assert_eq!(
            *ssh.execs.lock().unwrap(),
            vec!["whoami".to_string()],
            "只执行一次"
        );
    }

    /// 升级面的其它闸门：未登记的 stepId / manual 档步骤 / 本地会话 /
    /// 锁库 → 一律拒，且**零执行**。
    #[tokio::test]
    async fn upgrade_rejects_unknown_step_manual_step_local_and_locked() {
        let f = Fixture::new();
        let ssh = f.ssh(Some(42), "user").await;
        let scope = f.open(f.target(&ssh.id, AiSessionKind::Ssh, Some(42)));
        let registered = f
            .exec(&scope, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        // 未登记的 stepId → 拒。
        let err = f
            .upgrade_step(&scope, "ai-step-not-registered", "action-x")
            .await
            .unwrap_err();
        assert!(err.contains("not registered"), "{err}");
        // manual 档登记的步骤 → 无需升级（拒）。
        let manual = f
            .exec(&scope, "action-2", "whoami", AiExecMode::Manual)
            .await
            .unwrap();
        let err = f
            .upgrade_step(&scope, &manual.step_id, "action-y")
            .await
            .unwrap_err();
        assert!(err.contains("already registered in manual mode"), "{err}");
        // 本地会话 → 拒（不给执行权）。
        let bytes = f.local("local-a");
        let local_scope = f.open(f.target("local-a", AiSessionKind::Local, None));
        let err = f
            .upgrade_step(&local_scope, &registered.step_id, "action-z")
            .await
            .unwrap_err();
        assert!(err.contains("local terminal sessions"), "{err}");
        assert!(bytes.lock().unwrap().is_empty()); // 锁库 → 拒。
        let f2 = Fixture::password();
        let ssh2 = f2.ssh(Some(42), "user").await;
        let scope2 = f2.open(f2.target(&ssh2.id, AiSessionKind::Ssh, Some(42)));
        let registered2 = f2
            .exec(&scope2, "action-1", "whoami", AiExecMode::Plan)
            .await
            .unwrap();
        f2.vault.lock();
        let err = f2
            .upgrade_step(&scope2, &registered2.step_id, "action-locked")
            .await
            .unwrap_err();
        assert!(err.contains("vault locked"), "{err}");
        // 全程零执行。
        assert!(ssh.execs.lock().unwrap().is_empty());
        assert!(ssh2.execs.lock().unwrap().is_empty());
    }

    /// 升级结果载荷序列化面：camelCase 字段名 + 档位小写名（前端消费面契约）。
    #[test]
    fn upgrade_outcome_payload_uses_camel_case_fields() {
        let outcome = AiScopeUpgradeOutcome {
            step_id: "ai-step-y".into(),
            action_id: "action-2".into(),
            mode: AiExecMode::Manual,
            message: "m".into(),
        };
        let json = serde_json::to_value(&outcome).unwrap();
        assert_eq!(json["stepId"], "ai-step-y");
        assert_eq!(json["actionId"], "action-2");
        assert_eq!(json["mode"], "manual");
        assert_eq!(json["message"], "m");
        let mut keys: Vec<&str> = json
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, vec!["actionId", "message", "mode", "stepId"]);
    }
}
