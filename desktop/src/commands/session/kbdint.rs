//! keyboard-interactive 交互式认证（2026-11-02 批次二）：TOTP / PAM 2FA 跳板机登录。
//!
//! ## 范式来源
//!
//! 逐字复用仓库既有的 **TOFU 问询**链路（`hostkey.rs`）：Rust 侧登记回传端 →
//! 发事件问前端 → `block_in_place` 阻塞等裁定 → 前端经命令回传 → 放行或超时失败。
//! 两者的 fail-closed 语义一致：超时 / 取消 / 槽位缺失 → **一律判认证失败**，
//! 绝不静默放行。
//!
//! ## 与 TOFU 的差异
//!
//! * TOFU 的回传值是 `bool`（接受/拒绝一个指纹）；本模块的回传值是
//!   `Vec<String>`（**一组**答案，条数必须等于服务器下发的提问数——
//!   见 `ottr_ssh::auth::keyboard_interactive_auth` 的 `PromptAnswerMismatch`）；
//! * TOFU 一次连接问一次；keyboard-interactive **可能问多轮**（russh 侧是
//!   `loop`），每轮独立登记槽位、独立发事件。
//!
//! ## TOTP 码自动填
//!
//! 服务器的验证码型提问（"Verification code:" / "验证码" …）由 Ottr **自动算码**
//! 并随事件下发（`suggestion` 字段）——用户点一下即可提交，不必手翻手机。
//! 判定靠提问文本的关键词（[`is_code_prompt`]）；判定不了就不给建议，用户手输。
//! 种子只在 Rust 侧解密（`SecretField::TotpSecret`），明文码随事件回前端一次。

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Emitter, State};

use ottr_ssh::PromptResponder;
use ottr_vault::{CredentialKind, Credentials, SecretField};

use crate::commands::state::{AppState, PROMPT_ASK_TIMEOUT, PromptAsks};
use crate::vault::VaultState;

/// 问询序号（进程内单调递增）。ask_id = `"{host_id}:{n}"`——与 host_id 绑定，
/// 前端只能回传自己收到过的那一个。
static ASK_SEQ: AtomicU64 = AtomicU64::new(1);

/// 交互式认证上下文（构造 [`PromptResponder` 所需）。
///
/// 由调用方（attach / jump）在**已知主机上下文**时构造；部署路径（key_deploy）
/// 与 TOTP 不兼容（部署只接受密码/私钥），传 `None`。
#[derive(Clone)]
pub(crate) struct KbdContext {
    pub(crate) app: AppHandle,
    pub(crate) asks: PromptAsks,
    pub(crate) vault: Arc<ottr_vault::Vault>,
    pub(crate) host_id: i64,
    pub(crate) host_name: String,
    pub(crate) credential_id: i64,
    pub(crate) hop: Option<usize>,
    pub(crate) origin_host_id: Option<i64>,
}

/// 服务器下发的一条提问。
#[derive(Clone, serde::Serialize)]
pub(crate) struct PromptItem {
    /// 提问原文（服务器给什么就显示什么）。
    pub(crate) text: String,
    /// Ottr 自动算出的答案建议（TOTP 验证码；`None` = 需用户手输）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) suggestion: Option<String>,
    /// 建议码的**剩余有效秒数**（TOTP 30s 窗）——前端据此倒计时并到期刷新。
    ///
    /// 没有这个字段的话，弹窗停留超过一个时间窗后提交的仍是旧码（真机 E2E
    /// 实测：提交的是上一窗的码，服务端直接拒）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) suggestion_expires_in: Option<u64>,
}

/// `ottr://kbd-interactive-ask` 事件载荷。
#[derive(Clone, serde::Serialize)]
pub(crate) struct PromptAskPayload {
    /// 问询回执号（前端原样回传给 `kbd_interactive_answer`）。
    pub(crate) ask_id: String,
    pub(crate) host_id: i64,
    pub(crate) host_name: String,
    /// 本次认证用的凭据 id——前端据此在码过期时**重算**一个新码。
    pub(crate) credential_id: i64,
    /// 本轮全部提问（条数 = 需作答条数）。
    pub(crate) prompts: Vec<PromptItem>,
    /// 链上跳序号（0 起；None = 直连）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) hop: Option<usize>,
    /// 发起连接的主机 id（链式时 = 被连主机）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) origin_host_id: Option<i64>,
}

/// `ottr://kbd-interactive-timeout` 事件载荷（问询等满时限未作答）。
///
/// 前端据此**关掉弹窗**并说明原因——否则用户面对的是一个「还开着但已经不
/// 会有人听」的输入框。
#[derive(Clone, serde::Serialize)]
pub(crate) struct PromptTimeoutPayload {
    /// 问询回执号（前端据此判断是不是当前那一个弹窗）。
    pub(crate) ask_id: String,
    pub(crate) host_id: i64,
    pub(crate) host_name: String,
    /// 等了多久（秒）——文案里说清「等了多久没人作答」。
    pub(crate) seconds: u64,
}

/// 提问文本是否像「验证码」类（可自动填 TOTP 码）。
///
/// 关键词命中即认为可自动填；命中不了就让用户手输（**宁可不填也不错填**——
/// 把密码型提问误判成验证码型并塞进 TOTP 码，会把错误的码提交给服务器）。
pub(crate) fn is_code_prompt(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    // ASCII 关键词走**词边界**匹配——子串匹配会把 "postcode" / "barcode" 误判成
    // 验证码型（真机回归测试抓到过），进而把 TOTP 码塞进一个非验证码提问。
    const ASCII_KEYWORDS: &[&str] = &["code", "otp", "verification", "verify", "one-time", "token"];
    let ascii_hit = ASCII_KEYWORDS.iter().any(|kw| {
        lower
            .split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
            .any(|w| w == *kw)
    });
    if ascii_hit {
        return true;
    }
    // CJK 关键词无词边界概念，用子串。注意「动态口令」而非「口令」——后者在
    // 中文里更常指私钥解密口令（passphrase），误判会把 TOTP 码填进密码框。
    const CJK_KEYWORDS: &[&str] = &["验证码", "动态码", "动态口令", "令牌"];
    CJK_KEYWORDS.iter().any(|k| lower.contains(k))
}

/// 取该凭据的当前 TOTP 码 + 剩余有效秒数（非 TOTP 凭据 / 解密失败 / 种子非法 → `None`）。
///
/// **纯本地计算**：种子只在 Rust 侧解密，明文码不进日志、不落盘。
///
/// 位数/步长取**凭据自身的配置**（0025 起可配；缺省 6 位 / 30 秒）——写死
/// 6/30 时，Steam（5 位）、8 位服务、60 秒步长的自建服务**自动填码恒错**，
/// 用户只能手输，而界面仍提示「已自动填」。
fn totp_code_for(vault: &ottr_vault::Vault, credential_id: i64) -> Option<(String, u64)> {
    let credential = Credentials::get(vault, credential_id).ok()??;
    if credential.kind != CredentialKind::Totp {
        return None;
    }
    let secret = Credentials::reveal(vault, credential_id, SecretField::TotpSecret)
        .ok()
        .flatten()?;
    let digits = credential.totp_digits.unwrap_or(ottr_totp::DEFAULT_DIGITS);
    let period = credential
        .totp_period
        .map(|p| p as u64)
        .unwrap_or(ottr_totp::DEFAULT_PERIOD);
    let now = unix_now();
    let code = ottr_totp::generate_from_base32(&secret, now, digits, period).ok()?;
    Some((code, ottr_totp::remaining_seconds(now, period)))
}

/// 当前 Unix 秒。
fn unix_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 构造 keyboard-interactive 提问闭包（`PromptResponder`）。
///
/// 闭包形态与 `HostKeyPolicy` 同构（同步 `Arc<dyn Fn(..)>`）——「等用户输入」
/// 只能在同步上下文里阻塞，因此用 `block_in_place`（TOFU 同一手法）。
pub(crate) fn keyboard_interactive_responder(ctx: KbdContext) -> PromptResponder {
    Arc::new(move |prompts: &[String]| -> Vec<String> {
        let items: Vec<PromptItem> = prompts
            .iter()
            .map(|text| {
                // 验证码型提问 → 现算一个码 + 剩余有效秒数（前端据此到期刷新）。
                let (suggestion, suggestion_expires_in) = if is_code_prompt(text) {
                    match totp_code_for(&ctx.vault, ctx.credential_id) {
                        Some((code, expires_in)) => (Some(code), Some(expires_in)),
                        None => (None, None),
                    }
                } else {
                    (None, None)
                };
                PromptItem {
                    text: text.clone(),
                    suggestion,
                    suggestion_expires_in,
                }
            })
            .collect();

        let ask_id = format!(
            "{}:{}",
            ctx.host_id,
            ASK_SEQ.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = std::sync::mpsc::channel();
        register_prompt_ask(&ctx.asks, ask_id.clone(), tx);

        // **只发给主窗口**（emit_to）：载荷里含明文验证码，全局广播等于把它
        // 发给将来可能出现的任何其他 webview（当前只有 main 窗，但这是白送的面）。
        if let Err(e) = ctx.app.emit_to(
            "main",
            "ottr://kbd-interactive-ask",
            PromptAskPayload {
                ask_id: ask_id.clone(),
                host_id: ctx.host_id,
                host_name: ctx.host_name.clone(),
                credential_id: ctx.credential_id,
                prompts: items,
                hop: ctx.hop,
                origin_host_id: ctx.origin_host_id,
            },
        ) {
            eprintln!("[kbd-interactive] emit ask failed: {e}");
            // 空答案 = 放弃（Rust 侧判 AuthRejected，不向服务端发任何响应）。
            // 不能回等长空串——那等于「替用户提交了空密码」，服务端若允许空口令
            // 就会在用户没作答的情况下放行。
            return Vec::new();
        }

        // 超时 / 槽位被顶掉 → 空答案（服务端拒绝 → 认证失败，fail-closed）。
        match tokio::task::block_in_place(|| rx.recv_timeout(PROMPT_ASK_TIMEOUT)) {
            Ok(answers) => answers,
            Err(e) => {
                eprintln!("[kbd-interactive] ask {ask_id} not answered: {e}");
                // 超时是**前端可见的事实**：弹窗还开着的话，用户会在一个已经
                // 死掉的问询上敲码，提交后只看到「认证被拒」，与「没作答」分不开。
                // 故主动通知前端关窗 + 说清原因（见 PromptTimeoutPayload）。
                if e == std::sync::mpsc::RecvTimeoutError::Timeout {
                    // 槽位一并回收：否则过期后前端再回传答案会命中一个死端
                    // （send 失败被吞，前端以为提交成功）。
                    ctx.asks.lock().unwrap().remove(&ask_id);
                    if let Err(err) = ctx.app.emit_to(
                        "main",
                        "ottr://kbd-interactive-timeout",
                        PromptTimeoutPayload {
                            ask_id: ask_id.clone(),
                            host_id: ctx.host_id,
                            host_name: ctx.host_name.clone(),
                            seconds: PROMPT_ASK_TIMEOUT.as_secs(),
                        },
                    ) {
                        eprintln!("[kbd-interactive] emit timeout failed: {err}");
                    }
                }
                // 同上：空答案 = 放弃（auth.rs 侧判 AuthRejected，绝不向服务端
                // 发「空密码」）。
                Vec::new()
            }
        }
    })
}

/// 登记挂起问询端（**同键单槽覆盖**，与 TOFU 同款 fail-closed 语义）。
fn register_prompt_ask(
    asks: &PromptAsks,
    ask_id: String,
    tx: std::sync::mpsc::Sender<Vec<String>>,
) {
    if let Some(old) = asks.lock().unwrap().insert(ask_id, tx) {
        drop(old);
    }
}

/// 前端作答回传：一组答案（条数须等于提问数）。
///
/// **槽位不存在即报错**（已超时 / 已裁定 / ask_id 无效）——不落任何账、不放行。
#[tauri::command]
pub(crate) fn kbd_interactive_answer(
    state: State<'_, AppState>,
    ask_id: String,
    answers: Vec<String>,
) -> Result<(), String> {
    let tx = state.prompt_asks.lock().unwrap().remove(&ask_id);
    match tx {
        Some(tx) => {
            let _ = tx.send(answers);
            Ok(())
        }
        None => Err(format!(
            "no pending prompt ask for {ask_id} (expired or already answered)"
        )),
    }
}

/// 取某 TOTP 凭据的当前验证码（前端「自动填入」与「凭据管理器展示当前码」共用）。
///
/// **返回明文码是本功能的目的**（用户要用它登录跳板机）；种子只在本函数
/// 内部解密，不出 Rust 侧。非 TOTP 凭据 → 报错（不泄漏其它凭据形态）。
#[tauri::command]
pub(crate) fn credential_totp_code(
    vault: State<'_, VaultState>,
    credential_id: i64,
) -> Result<TotpCodePayload, String> {
    let (code, remaining_seconds) = totp_code_for(&vault.0, credential_id)
        .ok_or_else(|| format!("credential id={credential_id} has no usable TOTP secret"))?;
    Ok(TotpCodePayload {
        code,
        remaining_seconds,
    })
}

/// TOTP 码载荷（码 + 剩余秒数，供 UI 倒计时）。
#[derive(Clone, serde::Serialize)]
pub(crate) struct TotpCodePayload {
    pub(crate) code: String,
    pub(crate) remaining_seconds: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::time::Duration;

    #[test]
    fn code_prompt_detection_covers_common_wordings() {
        assert!(is_code_prompt("Verification code:"));
        assert!(is_code_prompt("One-time password (OTP)"));
        assert!(is_code_prompt("请输入验证码"));
        assert!(is_code_prompt("动态口令"));
        assert!(is_code_prompt("动态码"));
        assert!(is_code_prompt("TOKEN:"));
    }

    #[test]
    fn non_code_prompts_are_not_auto_filled() {
        // 密码型提问**绝不能**被塞 TOTP 码（错的码提交给服务器比不填更糟）。
        assert!(!is_code_prompt("Password:"));
        assert!(!is_code_prompt("password for muniu@host:"));
        assert!(!is_code_prompt("Passphrase:"));
        assert!(!is_code_prompt("密码："));
        // 含 "code" 但语义不同（postcode / barcode）也保守不填——词边界匹配。
        assert!(!is_code_prompt("Your postcode?"));
        assert!(!is_code_prompt("barcode scanner?"));
        // 「口令」在中文里更常指私钥解密口令（passphrase）——不自动填。
        assert!(!is_code_prompt("私钥口令："));
    }

    #[test]
    fn concurrent_ask_same_id_displaces_old_waiter_fail_closed() {
        let asks: PromptAsks = Arc::new(std::sync::Mutex::new(HashMap::new()));
        let (tx1, rx1) = std::sync::mpsc::channel::<Vec<String>>();
        register_prompt_ask(&asks, "7:1".into(), tx1);
        let (tx2, rx2) = std::sync::mpsc::channel::<Vec<String>>();
        register_prompt_ask(&asks, "7:1".into(), tx2);

        assert_eq!(asks.lock().unwrap().len(), 1, "同键只留最新端");
        assert!(
            rx1.recv_timeout(Duration::from_millis(200)).is_err(),
            "被顶掉的旧等待方必须 fail-closed（断开 ≠ 放行）"
        );
        let held = asks.lock().unwrap().remove("7:1").unwrap();
        held.send(vec!["123456".into()]).unwrap();
        assert_eq!(rx2.recv().unwrap(), vec!["123456".to_string()]);
    }
}
