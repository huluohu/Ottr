//! 主机密钥策略：夹具指纹 pin（spike 驱动面）+ TOFU 状态机与前端问询裁定
//! （正式 UI 面）。纯搬家拆分（原 session.rs 单文件）。

use std::sync::Arc;

use tauri::{AppHandle, Emitter, State};

use ottr_ssh::HostKeyPolicy;
use ottr_vault::{Hosts, KnownHostState, KnownHosts};

use crate::commands::state::{AppState, HOST_KEY_ASK_TIMEOUT, HostKeyAsks};
use crate::vault::VaultState;

// ---------------------------------------------------------------------------
// 主机指纹 pin（来自 fixtures/known_hosts，spike 不允许静默跳过校验）
// ---------------------------------------------------------------------------

/// 写入时的夹具指纹常量；运行时优先从仓库夹具文件按端点解析（防夹具重生成
/// 后漂移）。解析走 [`ottr_ssh::known_hosts::fingerprint_for_host`]（BL-211
/// 收敛点：此前本文件内联的「整文件取首条」实现在多 host 文件上可能 pin 错
/// key，且与 hostkey_audit/bench 三处重复同一算法）。
const PINNED_FP_FALLBACK: &str = "SHA256:nLaxv/1hXxccQNB7JauQUi63z0YmST4P3AvViyoNCIQ";

/// spike 主机密钥策略：指纹必须精确等于 pin 值，其余一律拒绝。
/// pin 目标 = 本次连接的 `(host, port)` 端点行（非首条记录）；文件缺失/无
/// 该端点行 → 退回 `PINNED_FP_FALLBACK`（夹具重生成漂移的兜底，语义不变）。
pub(super) fn pinned_host_key_policy(host: &str, port: u16) -> (HostKeyPolicy, String) {
    let expected = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/known_hosts"
    ))
    .ok()
    .and_then(|c| ottr_ssh::known_hosts::fingerprint_for_host(&c, host, port))
    .unwrap_or_else(|| PINNED_FP_FALLBACK.to_string());
    let expected_for_cb = expected.clone();
    let policy: HostKeyPolicy = Arc::new(move |fingerprint: &str| fingerprint == expected_for_cb);
    (policy, expected)
}

/// attach_host_session 的 host key 策略：known_hosts 记账 + 前端确认交互（TOFU）。
/// 记账键 = host 端点（0004 迁移，Task 8 义务①）：`host_key = "address:port"`，
/// 同端点共用一条信任记录。状态机（known_hosts state，见 ottr-vault KnownHosts 文档）：
/// * 无记录 → pending 入库（TOFU 留痕，拒绝也留）+ `ottr://host-key-ask`(kind=first)；
/// * 记录存在、指纹一致且 `ok` → 静默放行；
/// * 记录存在、指纹一致且 `pending` → 同问询（kind=pending，历史未决重问）；
/// * 记录存在、指纹**不一致** → 换钥检测：mark_changed 打标 + kind=changed 强提醒
///   （默认拒绝——这是 spec §10 防 MITM 的核心路径，Task 8 前同主机换钥被误判为首见）；
/// * `changed`（指纹一致但状态未恢复）→ kind=changed 强提醒。
///
/// 裁定经 `host_key_decision` 回传：接受=true 放行（库态转 ok、信任锚接管为本次
/// 指纹，由该命令落账，changed_at 保留），拒绝 / 60s 超时=false → 连接以
/// HostKeyRejected 失败；行内信任锚保持旧指纹（mark_changed 不覆盖）。
///
/// 阻塞语义：回调在 russh `connect_stream` spawn 的连接专属任务内执行，
/// `recv_timeout(60s)` 只挂起该连接自己的握手（connect 命令挂起等前端 confirm），
/// 不占公共 worker；超时按拒绝处理（安全侧默认）。
///
/// 链式问询（Phase 2 Task 2）：`hop`/`origin_host_id` 直通进事件载荷——
/// 全链**每一跳都走同一 TOFU 状态机**（同语义裁定：信任锚 = 跳自己的网络端点，
/// 与直连共用 known_hosts 记账；UI 确认框带跳序号）。
#[allow(clippy::too_many_arguments)]
pub(crate) fn tofu_host_key_policy(
    vault: Arc<ottr_vault::Vault>,
    app: AppHandle,
    host_id: i64,
    host_name: String,
    host_key: String,
    asks: HostKeyAsks,
    hop: Option<usize>,
    origin_host_id: Option<i64>,
) -> HostKeyPolicy {
    Arc::new(move |fingerprint: &str| {
        let known = match KnownHosts::get(&vault, &host_key) {
            Ok(k) => k,
            Err(e) => {
                eprintln!("[host-key] known_hosts read failed: {e}");
                return false;
            }
        };
        // 问询：登记回传端 → 事件问前端 → 挂起等裁定/超时。
        let ask = |kind: &'static str| -> bool {
            let (tx, rx) = std::sync::mpsc::channel();
            let key = format!("{host_id}:{fingerprint}");
            register_host_key_ask(&asks, key, tx);
            if let Err(e) = app.emit(
                "ottr://host-key-ask",
                HostKeyAskPayload {
                    host_id,
                    host_name: host_name.clone(),
                    fingerprint: fingerprint.to_string(),
                    kind,
                    hop,
                    origin_host_id,
                },
            ) {
                eprintln!("[host-key] emit ask failed: {e}");
                return false;
            }
            // block_in_place（评审 M-1）：recv_timeout 最长 60s 阻塞；本回调运行在
            // russh run loop 任务（russh-util spawn = tokio::spawn）里，包裹后该
            // worker 被标记 blocking、其余任务可被其余 worker 领走，不占死共享池。
            matches!(
                tokio::task::block_in_place(|| rx.recv_timeout(HOST_KEY_ASK_TIMEOUT)),
                Ok(true)
            )
        };
        // 先分类（None → "first"），再落账：
        //   * 首见 → TOFU pending 入库（入库后记录是 pending，顺序颠倒会让首连问询
        //     带上错误的 kind）；
        //   * 换钥（有记录、指纹不一致）→ mark_changed 打标（保留旧信任锚）。检测即
        //     落值：用户拒绝也留下「何时检测到变更」的痕迹，changed_at 不因放弃而丢失。
        let kind = host_key_ask_kind(known.as_ref(), fingerprint);
        let rotated = matches!(&known, Some(k) if k.fingerprint != fingerprint);
        if kind == Some("first") {
            if let Err(e) = KnownHosts::upsert(&vault, &host_key, fingerprint) {
                eprintln!("[host-key] upsert failed: {e}");
                return false;
            }
        } else if rotated && let Err(e) = KnownHosts::mark_changed(&vault, &host_key, fingerprint) {
            eprintln!("[host-key] mark_changed failed: {e}");
            return false;
        }
        match kind {
            None => true,            // state=ok 且指纹一致 → 静默放行
            Some(kind) => ask(kind), // first / pending / changed → 前端问询
        }
    })
}

/// 登记挂起问询端（BL-207③ 测试 seam）：**同键单槽覆盖**——同键并发问询
/// （双开同一主机）时顶掉旧端；旧等待方随 sender 被 drop 而 recv 立即断开，
/// 在 [`tofu_host_key_policy`] 的 `matches!(recv, Ok(true))` 折算下判拒
/// （fail-closed：并发双开绝不双向放行，也绝不悬挂旧端等满 60s 超时）。
fn register_host_key_ask(asks: &HostKeyAsks, key: String, tx: std::sync::mpsc::Sender<bool>) {
    if let Some(old) = asks.lock().unwrap().insert(key, tx) {
        drop(old);
    }
}

/// known_hosts 记录 + 本次出示指纹 → 下一步动作（可测纯分类）：
/// `None` = 静默放行（指纹一致且 state=ok）；`Some(kind)` = 需前端确认的种类：
/// * 无记录 = "first"（TOFU 首问；pending 入库由调用方负责）；
/// * 指纹一致 + pending = "pending"（历史未决重问）；
/// * 其余（changed 状态 / **指纹不一致=换钥**）= "changed"（强提醒，默认拒绝）。
fn host_key_ask_kind(
    known: Option<&ottr_vault::KnownHost>,
    fingerprint: &str,
) -> Option<&'static str> {
    match known {
        None => Some("first"),
        Some(k) if k.fingerprint == fingerprint && k.state == KnownHostState::Ok => None,
        Some(k) if k.fingerprint == fingerprint && k.state == KnownHostState::Pending => {
            Some("pending")
        }
        Some(_) => Some("changed"),
    }
}

/// `ottr://host-key-ask` 事件载荷（serde snake_case）。链式连接（Phase 2
/// Task 2）逐跳问询时：`host_id` = 该跳自己的主机 id（host_key_decision 按
/// 它落端点信任锚），`hop` = 跳序号（UI 带「第 N 跳」标识），
/// `origin_host_id` = 发起连接的主机（前端把问询归属到在途 connect 的标签）。
/// 两字段 None = 普通直连问询（skip 序列化，前端旧载荷形状不变）。
#[derive(Clone, serde::Serialize)]
struct HostKeyAskPayload {
    host_id: i64,
    host_name: String,
    fingerprint: String,
    /// "first"（首见 TOFU）/ "pending"（历史问询未决重问）/ "changed"（强提醒，默认拒绝）
    kind: &'static str,
    /// 链上跳序号（0 起；None = target / 直连）。
    #[serde(skip_serializing_if = "Option::is_none")]
    hop: Option<usize>,
    /// 发起连接的主机 id（链式 attach 时 = 被连主机；None = 直连）。
    #[serde(skip_serializing_if = "Option::is_none")]
    origin_host_id: Option<i64>,
}

/// 前端确认框裁定回传：`accept=true` 先落账 `KnownHosts::verify`（state→ok、
/// verified=1、**信任锚接管为本次指纹、changed_at 保留**——变更历史不随信任
/// 恢复抹除），再放行挂起的 connect。落账键 = host 端点（0004 迁移）：按
/// host_id 现查 address/port 组装，与策略层写入口径一致。
/// 无挂起问询（已超时/已裁定）返回错误——落账已发生（接受路径），下次
/// 连接直接放行，无害。
#[tauri::command]
pub(crate) fn host_key_decision(
    state: State<'_, AppState>,
    vault: State<'_, VaultState>,
    host_id: i64,
    fingerprint: String,
    accept: bool,
) -> Result<(), String> {
    let key = format!("{host_id}:{fingerprint}");
    let tx = state.host_key_asks.lock().unwrap().remove(&key);
    // host 行可能在问询挂起期间被删：无端点可落账，按拒绝收尾（不悬挂等待方）。
    let host_key = match Hosts::get(&vault.0, host_id) {
        Ok(Some(host)) => ottr_vault::host_endpoint_key(&host.address, host.port),
        Ok(None) => {
            if let Some(tx) = tx.as_ref() {
                let _ = tx.send(false);
            }
            return Err(format!("host id={host_id} not found for host key decision"));
        }
        Err(e) => {
            if let Some(tx) = tx.as_ref() {
                let _ = tx.send(false);
            }
            return Err(format!("host id={host_id} read failed: {e}"));
        }
    };
    if accept && let Err(e) = KnownHosts::verify(&vault.0, &host_key, &fingerprint) {
        if let Some(tx) = tx.as_ref() {
            let _ = tx.send(false);
        }
        return Err(e.to_string());
    }
    match tx {
        Some(tx) => {
            let _ = tx.send(accept);
            Ok(())
        }
        None => Err(format!(
            "no pending host key ask for host {host_id} (expired or already decided)"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::Duration;

    fn known_host(
        host_key: &str,
        fingerprint: &str,
        state: KnownHostState,
    ) -> ottr_vault::KnownHost {
        ottr_vault::KnownHost {
            host_key: host_key.into(),
            fingerprint: fingerprint.into(),
            first_seen: 0,
            verified: false,
            changed_at: None,
            state,
        }
    }

    /// BL-207③：并发首连 hostKeyAsk **同键单槽覆盖**测试钉（fail-closed 语义
    /// 已定，本例钉住行为不漂移）。双开同一主机（同 host_id + 同指纹）的两次
    /// 问询：第二次登记顶掉第一次——旧等待端 recv 立即断开（折算拒绝：绝不
    /// 双向放行、也不悬挂旧端等满 60s 超时），槽内只剩最新端且裁定可回传；
    /// 不同键（不同主机）互不干扰、各占各槽。
    #[test]
    fn concurrent_host_key_ask_single_slot_displaces_old_waiter_fail_closed() {
        let asks: HostKeyAsks = Arc::new(Mutex::new(HashMap::new()));
        let key = "7:SHA256:fp".to_string();

        let (tx1, rx1) = std::sync::mpsc::channel::<bool>();
        register_host_key_ask(&asks, key.clone(), tx1);
        let (tx2, rx2) = std::sync::mpsc::channel::<bool>();
        register_host_key_ask(&asks, key.clone(), tx2);

        // 单槽：同键只留最新端。
        assert_eq!(asks.lock().unwrap().len(), 1);
        assert!(asks.lock().unwrap().contains_key(&key));
        // 旧等待方立即判拒：recv 断开（Err）→ ask() 闭包的
        // matches!(recv_timeout, Ok(true)) 为 false = HostKeyRejected。
        assert!(
            rx1.recv_timeout(Duration::from_millis(200)).is_err(),
            "被顶掉的旧等待方必须 fail-closed（recv 断开≠放行）"
        );
        // 最新端存活：host_key_decision 的真实流程 = remove 出槽再 send。
        let held2 = asks.lock().unwrap().remove(&key).unwrap();
        held2.send(true).unwrap();
        assert_eq!(rx2.recv(), Ok(true));

        // 不同键（另一台主机）各占各槽，互不顶掉。
        let (tx3, rx3) = std::sync::mpsc::channel::<bool>();
        register_host_key_ask(&asks, "8:SHA256:other".into(), tx3);
        assert_eq!(asks.lock().unwrap().len(), 1, "前一键已随裁定出槽");
        let held3 = asks.lock().unwrap().remove("8:SHA256:other").unwrap();
        held3.send(false).unwrap();
        assert_eq!(rx3.recv(), Ok(false), "拒绝裁定同样经槽回传");
        assert!(asks.lock().unwrap().is_empty(), "裁定后槽位清空");
    }

    #[test]
    fn host_key_classification_matches_known_hosts_states() {
        let hk = "10.0.0.1:22";
        let fp = "SHA256:x";
        // 无记录 → TOFU 首问；指纹一致+ok → 静默放行；一致+pending → 重问；
        // changed / **指纹不一致（换钥）** → 强提醒
        assert_eq!(host_key_ask_kind(None, fp), Some("first"));
        assert_eq!(
            host_key_ask_kind(Some(&known_host(hk, fp, KnownHostState::Ok)), fp),
            None
        );
        assert_eq!(
            host_key_ask_kind(Some(&known_host(hk, fp, KnownHostState::Pending)), fp),
            Some("pending")
        );
        assert_eq!(
            host_key_ask_kind(Some(&known_host(hk, fp, KnownHostState::Changed)), fp),
            Some("changed")
        );
        // 换钥（Task 8 义务①核心分类）：无论旧状态，指纹不一致一律 changed 强提醒
        assert_eq!(
            host_key_ask_kind(Some(&known_host(hk, "SHA256:old", KnownHostState::Ok)), fp),
            Some("changed")
        );
    }

    /// TOFU 全流程落账语义（vault 直查，InMemoryStorage master key），按端点记账：
    /// 首见 upsert=pending → verify=ok → 换钥 mark_changed（changed_at 落值、
    /// 旧锚保留）→ 用户显式接受再 verify：state 回 ok、信任锚接管新指纹、
    /// **changed_at 保留**（「何时出过事」不随信任恢复抹除，Task 6 裁定 #4）。
    #[test]
    fn host_key_tofu_lifecycle_preserves_changed_at_after_reaccept() {
        let dir = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            dir.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .expect("open in-memory vault");
        let hk = "10.0.0.1:22";

        let first = KnownHosts::upsert(&vault, hk, "SHA256:fp").unwrap();
        assert_eq!(first.state, KnownHostState::Pending);
        // 「first」kind 只在策略闭包里于 upsert 之前由 None 分类得出
        // （见 host_key_classification_matches_known_hosts_states）；
        // 已入库的 pending 记录重问时是 "pending"。
        assert_eq!(
            host_key_ask_kind(Some(&first), "SHA256:fp"),
            Some("pending")
        );

        let verified = KnownHosts::verify(&vault, hk, "SHA256:fp").unwrap();
        assert_eq!(verified.state, KnownHostState::Ok);
        assert!(verified.verified);
        assert_eq!(
            host_key_ask_kind(Some(&verified), "SHA256:fp"),
            None,
            "ok 后静默放行"
        );

        // 换钥：同端点同一条记录，changed 强提醒；信任锚保留旧指纹。
        let changed = KnownHosts::mark_changed(&vault, hk, "SHA256:rotated").unwrap();
        assert_eq!(changed.state, KnownHostState::Changed);
        assert_eq!(changed.fingerprint, "SHA256:fp", "旧信任锚保留");
        assert_eq!(
            host_key_ask_kind(Some(&changed), "SHA256:rotated"),
            Some("changed")
        );
        let changed_at = changed.changed_at.expect("mark_changed 落值");

        let reaccepted = KnownHosts::verify(&vault, hk, "SHA256:rotated").unwrap();
        assert_eq!(reaccepted.state, KnownHostState::Ok);
        assert!(reaccepted.verified);
        assert_eq!(
            reaccepted.fingerprint, "SHA256:rotated",
            "接受后信任锚接管新指纹"
        );
        assert_eq!(reaccepted.changed_at, Some(changed_at), "changed_at 保留");
    }

    /// 同 host 换钥全链路（Task 8 义务①核心回归，vault 直查）：
    /// 换钥后的指纹在**同一端点记录**上触发 changed，而不是像旧 schema
    /// （fingerprint 主键）那样查无记录、被当成新一轮 TOFU 首见。
    #[test]
    fn same_host_key_rotation_lands_on_changed_state() {
        let dir = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            dir.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .expect("open in-memory vault");
        let hk = "web.example:22";

        KnownHosts::upsert(&vault, hk, "SHA256:A").unwrap();
        KnownHosts::verify(&vault, hk, "SHA256:A").unwrap();

        // 服务器出示新指纹：分类必须是 changed（不是 first）
        assert_eq!(
            host_key_ask_kind(KnownHosts::get(&vault, hk).unwrap().as_ref(), "SHA256:B"),
            Some("changed")
        );
        let flagged = KnownHosts::mark_changed(&vault, hk, "SHA256:B").unwrap();
        assert_eq!(flagged.state, KnownHostState::Changed);
        // 拒绝后重连：仍是 changed 强提醒（信任锚还在旧钥匙上，指纹依旧不一致）
        assert_eq!(
            host_key_ask_kind(KnownHosts::get(&vault, hk).unwrap().as_ref(), "SHA256:B"),
            Some("changed")
        );
        assert_eq!(KnownHosts::list(&vault).unwrap().len(), 1, "换钥不新增记录");
    }
}
