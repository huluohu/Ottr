//! 主机指纹巡检（Phase 3 Task 6，B9 收口）：对 known_hosts 里 state=ok 的端点
//! 周期性跑外部 `ssh-keyscan` 采集当前主机密钥 → 与信任锚比对 → 不一致走既有
//! changed 流程（`KnownHosts::mark_changed`，信任锚不覆盖）并经
//! `ottr://host-key-changed` 事件推给前端通知管线（kind=security）。
//!
//! 结构（裁定 #2 的 TDD 面）：
//!   * **纯判定**：[`classify_probe`]（锚 + 观测 → 判定）与
//!     [`keyscan_line_fingerprint`]（keyscan 输出行 → SHA256 指纹，口径与
//!     commands/session.rs 的 TOFU 指纹一致）——单测直驱；
//!   * **巡检核**：[`audit_once`] 收注入的 prober 闭包（测试造假件），
//!     只做「list → 逐端点探测 → changed 落账」的编排，不触进程/网络；
//!   * **执行面**：[`probe_endpoint`] 外部进程（ssh-keyscan 缺席 = 探测失败 =
//!     **不确定**，绝不据此判 changed——网络故障与换钥是两回事）；
//!   * **调度面**：[`spawn_audit_scheduler`] 60s 心跳，到点读 settings
//!     （开关默认关 / 间隔默认 24h，security.rs 同款 *_from 收敛），vault 锁定
//!     或未就绪跳过本轮（下轮重试）。last_run 是进程内原子时间戳——改间隔
//!     即时生效（下一跳按新间隔对账）。
//!
//! 通知接线：本模块只 emit 事件；落库/系统通知/限频在前端 src/notify/core.ts
//! （监听同事件 → notify(kind=security)）。手动巡检命令
//! [`known_hosts_audit_run`] 与调度器走同一条 [`audit_round`]，事件形状一致。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State};

use ottr_vault::{parse_endpoint_key, KnownHost, KnownHosts, Settings, Vault};

use crate::security::{
    hostkey_audit_interval_from, SETTING_HOSTKEY_AUDIT, SETTING_HOSTKEY_AUDIT_INTERVAL,
};
use crate::vault::VaultState;

/// 单端点 keyscan 的每键型超时（秒）——ssh-keyscan 自带，正常几秒内完成。
const KEYSCAN_TIMEOUT_SECS: u32 = 5;
/// 单轮巡检的墙钟上限（async 层守卫）：端点极多/进程卡死时不无限挂起。
const ROUND_TIMEOUT_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// 纯判定（TDD 直驱面）
// ---------------------------------------------------------------------------

/// 单端点巡检判定：信任锚仍在观测集 → [`ProbeVerdict::Match`]；锚**不在**
/// 观测集（服务器不再出示我们信任的钥匙）→ [`ProbeVerdict::Changed`]；
/// 探测失败/空观测 → [`ProbeVerdict::Inconclusive`]（跳过，不落账）。
///
/// 「不在集合」而非「存在不一致」：服务器通常同时持多型主机密钥（rsa/ecdsa/
/// ed25519），观测集超集是常态；只认「锚消失」才是换钥/中间人的可靠信号，
/// 多出的新钥匙不触发告警（首次连接本就会锚定其中一枚）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeVerdict {
    /// 锚仍在：无动作。
    Match,
    /// 锚消失：走 changed 流程（mark_changed + security 通知）。
    Changed,
    /// 探测失败/空观测：网络故障或 keyscan 缺席——跳过，绝不误报。
    Inconclusive,
}

pub fn classify_probe(anchor: &str, seen: &[String]) -> ProbeVerdict {
    if seen.is_empty() {
        return ProbeVerdict::Inconclusive;
    }
    if seen.iter().any(|fp| fp == anchor) {
        ProbeVerdict::Match
    } else {
        ProbeVerdict::Changed
    }
}

/// ssh-keyscan 输出行 → `SHA256:<unpadded-std-b64(sha256(key_blob))>` 指纹。
/// 行形状：`host|'[host]:port' <keytype> <b64>`（注释行 `# ...` 跳过）。
/// BL-211 收敛点：算法实现在 [`ottr_ssh::known_hosts::line_fingerprint`]，
/// 本包装保留 keyscan 面的名字与语义（`|1|` hashed 行防御性跳过、marker 行
/// `@cert-authority`/`@revoked` 不参与——keyscan 不产出这些行，规则一致）。
pub fn keyscan_line_fingerprint(line: &str) -> Option<String> {
    ottr_ssh::known_hosts::line_fingerprint(line)
}

// ---------------------------------------------------------------------------
// 执行面（外部进程）
// ---------------------------------------------------------------------------

/// 对单端点跑 `ssh-keyscan`（外部进程，裁定 #2），返回观测到的全部主机指纹。
/// 返回 `Err` = 进程失败/缺席（调用方一律按不确定处理）；`Ok(空)` = 连不上
/// （同样按不确定处理——见 [`classify_probe`]）。
pub fn probe_endpoint(address: &str, port: u16) -> Result<Vec<String>, String> {
    let output = std::process::Command::new("ssh-keyscan")
        .args([
            "-p",
            &port.to_string(),
            "-T",
            &KEYSCAN_TIMEOUT_SECS.to_string(),
            "-t",
            "rsa,ecdsa,ed25519",
            address,
        ])
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "ssh-keyscan not found on PATH".to_string()
            } else {
                format!("spawn ssh-keyscan: {e}")
            }
        })?;
    // keyscan 对「连不上」也退出 0（stderr 报错、stdout 空）——成败看 stdout 面。
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter_map(keyscan_line_fingerprint)
        .collect())
}

// ---------------------------------------------------------------------------
// 巡检核（编排；prober 注入——测试造假件，真面传 probe_endpoint）
// ---------------------------------------------------------------------------

/// 一轮巡检的结果（serde snake_case → TS `HostKeyAuditOutcome`）。
#[derive(Debug, Default, PartialEq, serde::Serialize)]
pub struct AuditOutcome {
    /// 实际探测的端点数（parse 失败/非 ok 状态的行不计）。
    pub checked: usize,
    /// 本次被判 changed 的条目（落账后的行 + 触发判定的观测集——事件/UI 的
    /// 新旧对照面）。
    pub changed: Vec<ChangedEntry>,
}

/// 单条 changed 落账 + 它的观测集。
#[derive(Debug, PartialEq, serde::Serialize)]
pub struct ChangedEntry {
    pub row: KnownHost,
    /// 本次观测到的指纹集（锚消失时的在场钥匙——accept 新锚的候选面）。
    pub seen: Vec<String>,
}

/// 一轮巡检：对全部 state=ok 的端点逐一探测，锚消失 → `KnownHosts::mark_changed`
/// （复用连接期换钥的同一落账路径）。pending（未 verify，无信任语义）与
/// changed（已标记待处理）的行跳过；探测失败（Err/空观测）跳过不误报。
/// `prober` 收端点键（内部 parse；parse 失败 = legacy 虚拟端点，跳过）。
pub fn audit_once<F>(vault: &Vault, mut prober: F) -> Result<AuditOutcome, String>
where
    F: FnMut(&str) -> Result<Vec<String>, String>,
{
    let mut outcome = AuditOutcome::default();
    for row in KnownHosts::list(vault).map_err(|e| e.to_string())? {
        if row.state != ottr_vault::KnownHostState::Ok {
            continue;
        }
        if parse_endpoint_key(&row.host_key).is_none() {
            continue; // legacy 虚拟端点 / 畸形键：不可探测，跳过
        }
        outcome.checked += 1;
        let seen = match prober(&row.host_key) {
            Ok(seen) => seen,
            // Err = 探测器故障（如 keyscan 缺席）：单端点失败不拖垮整轮
            Err(e) => {
                eprintln!("[hostkey-audit] probe {} failed: {e}", row.host_key);
                continue;
            }
        };
        if classify_probe(&row.fingerprint, &seen) == ProbeVerdict::Changed {
            let changed = KnownHosts::mark_changed(vault, &row.host_key, &row.fingerprint)
                .map_err(|e| e.to_string())?;
            outcome.changed.push(ChangedEntry { row: changed, seen });
        }
    }
    Ok(outcome)
}

/// `ottr://host-key-changed` 事件载荷（serde snake_case）。seen = 观测集
/// （管理页「检查」可复用同一形状展示新旧对照）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct HostKeyChangedPayload {
    pub host_key: String,
    /// 旧信任锚（mark_changed 保留值）。
    pub anchor: String,
    pub seen: Vec<String>,
}

/// 一轮巡检（探测 + 落账）+ 逐条 emit 通知事件。调度器与手动命令共用；
/// 墙钟上限 [`ROUND_TIMEOUT_SECS`]（spawn_blocking 里跑，async 层 timeout 守卫）。
pub async fn audit_round(vault: Arc<Vault>, app: &AppHandle) -> Result<AuditOutcome, String> {
    let handle = app.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        audit_once(&vault, |host_key| {
            let (address, port) = parse_endpoint_key(host_key)
                .ok_or_else(|| format!("bad endpoint key {host_key}"))?;
            let port = u16::try_from(port).map_err(|_| format!("port {port} out of range"))?;
            probe_endpoint(&address, port)
        })
    });
    let outcome = tokio::time::timeout(Duration::from_secs(ROUND_TIMEOUT_SECS), task)
        .await
        .map_err(|_| format!("host key audit round timed out after {ROUND_TIMEOUT_SECS}s"))?
        .map_err(|e| format!("join: {e}"))??;
    for entry in &outcome.changed {
        let _ = handle.emit(
            "ottr://host-key-changed",
            HostKeyChangedPayload {
                host_key: entry.row.host_key.clone(),
                anchor: entry.row.fingerprint.clone(),
                seen: entry.seen.clone(),
            },
        );
    }
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// 调度面（60s 心跳 + 到点对账）
// ---------------------------------------------------------------------------

/// 最近一轮巡检完成时刻（unix 秒；进程内瞬态——重启后重算，首轮在间隔到期后
/// 才跑，避免每次启动都出网）。
static LAST_RUN_SECS: AtomicU64 = AtomicU64::new(0);

/// 巡检轮 in-flight 守卫（M-1，fix round 1）：心跳 60s，端点一多单轮可能超
/// 心跳——不守卫则上一轮未完下一跳又起一轮（自重叠双轮：重复出网 + 事件双发）。
/// CAS 抢占，error 路径同样释放（defer 风格 guard）。
static ROUND_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// 抢占成功时的释放 guard（Drop 置 false——error/panic 路径统一收尾）。
struct RoundGuard;
impl Drop for RoundGuard {
    fn drop(&mut self) {
        ROUND_IN_FLIGHT.store(false, Ordering::Relaxed);
    }
}

/// 尝试抢占巡检轮执行权；false = 已有一轮在跑（调用方跳过本轮）。
fn try_begin_round() -> Option<RoundGuard> {
    ROUND_IN_FLIGHT
        .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
        .ok()
        .map(|_| RoundGuard)
}

/// 调度心跳（60s）。vault 未就绪 / 锁定 / 开关关 / 未到间隔 / 上一轮未完 →
/// 本轮跳过。巡检是明文面读取（known_hosts）+ 出网，锁定态跳过 = 不在密文库
/// 不可读时做信任判定（安全侧：解锁后下一心跳补跑）。
pub fn spawn_audit_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let Some(state) = app.try_state::<VaultState>() else {
                continue; // vault-init 线程尚未 manage：等待
            };
            if state.0.is_locked() {
                continue;
            }
            let enabled = Settings::get(&state.0, SETTING_HOSTKEY_AUDIT)
                .ok()
                .flatten()
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !enabled {
                continue;
            }
            let interval = hostkey_audit_interval_from(
                Settings::get_u64(&state.0, SETTING_HOSTKEY_AUDIT_INTERVAL)
                    .ok()
                    .flatten(),
            );
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            if now.saturating_sub(LAST_RUN_SECS.load(Ordering::Relaxed)) < interval.as_secs() {
                continue;
            }
            // in-flight 抢占：上一轮未完（端点多于心跳预算）本轮让位
            let Some(_guard) = try_begin_round() else {
                continue;
            };
            match audit_round(state.0.clone(), &app).await {
                Ok(o) => {
                    LAST_RUN_SECS.store(now, Ordering::Relaxed);
                    if !o.changed.is_empty() {
                        eprintln!(
                            "[hostkey-audit] round done: {} checked, {} changed",
                            o.checked,
                            o.changed.len()
                        );
                    }
                }
                Err(e) => eprintln!("[hostkey-audit] round failed: {e}"),
            }
            drop(_guard); // 显式收尾（语义面；Drop 本可兜底）
        }
    });
}

// ---------------------------------------------------------------------------
// 命令面
// ---------------------------------------------------------------------------

/// 单端点探测（管理页「检查」/手动 verify 的取证面）：返回观测到的指纹集。
/// Err = 探测失败（进程缺席等）；Ok(空) = 端点不可达——两种形态前端都按
/// 「无法确认」展示，绝不替用户做 changed 判定。
#[tauri::command]
pub async fn known_hosts_probe(
    state: State<'_, VaultState>,
    host_key: String,
) -> Result<Vec<String>, String> {
    state.0.ensure_unlocked().map_err(|e| e.to_string())?;
    let (address, port) =
        parse_endpoint_key(&host_key).ok_or_else(|| format!("bad endpoint key {host_key}"))?;
    let port = u16::try_from(port).map_err(|_| format!("port {port} out of range"))?;
    tauri::async_runtime::spawn_blocking(move || probe_endpoint(&address, port))
        .await
        .map_err(|e| format!("join: {e}"))?
}

/// 手动全量巡检（管理页「立即巡检」）：调度语义同 [`spawn_audit_scheduler`]
/// 的单轮（探测 + mark_changed 落账 + 通知事件），并刷新 LAST_RUN——手动跑过
/// 一轮，定时器从新时刻起算。
#[tauri::command]
pub async fn known_hosts_audit_run(
    app: AppHandle,
    state: State<'_, VaultState>,
) -> Result<AuditOutcome, String> {
    state.0.ensure_unlocked().map_err(|e| e.to_string())?;
    let outcome = audit_round(state.0.clone(), &app).await?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    LAST_RUN_SECS.store(now, Ordering::Relaxed);
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ottr_vault::KnownHostState;

    fn open_vault(dir: &std::path::Path) -> Vault {
        Vault::open_with(dir, &ottr_vault::master_key::InMemoryStorage::new())
            .expect("open in-memory vault")
    }

    // --- classify_probe ---

    #[test]
    fn classify_probe_matrix() {
        let anchor = "SHA256:ANCHOR".to_string();
        // 锚在观测集（单枚/多枚超集）→ Match
        let single = vec![anchor.clone()];
        assert_eq!(classify_probe(&anchor, &single), ProbeVerdict::Match);
        assert_eq!(
            classify_probe(
                &anchor,
                &["SHA256:RSA".into(), anchor.clone(), "SHA256:ECDSA".into()]
            ),
            ProbeVerdict::Match,
            "多型主机密钥的超集观测 = 常态，不告警"
        );
        // 锚消失 → Changed（哪怕观测集非空）
        assert_eq!(
            classify_probe(&anchor, &["SHA256:ROTATED".into()]),
            ProbeVerdict::Changed
        );
        // 空观测 → 不确定（不误报）
        assert_eq!(classify_probe(&anchor, &[]), ProbeVerdict::Inconclusive);
        assert_eq!(
            classify_probe(&anchor, &["".to_string()]),
            ProbeVerdict::Changed,
            "空串是指纹集的一员而非空观测——口径钉死"
        );
    }

    // --- keyscan_line_fingerprint ---

    /// 与夹具真实主机密钥对锚：`fixtures/known_hosts` 首条 blob 经本函数
    /// 算出的指纹 == session.rs 同口径的 pin 值（跨实现对齐的回归锚）。
    #[test]
    fn keyscan_line_fingerprint_matches_fixture_pin() {
        let content = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../fixtures/known_hosts"
        ))
        .expect("fixtures/known_hosts");
        let line = content
            .lines()
            .find(|l| !l.trim().is_empty() && !l.starts_with('#'))
            .unwrap();
        let fp = keyscan_line_fingerprint(line).expect("fixture line yields fingerprint");
        assert!(fp.starts_with("SHA256:"), "got {fp}");
        // pin 值来自 session.rs PINNED_FP_FALLBACK（夹具重生成会漂移，故只断言
        // 形状 + 与文件内 blob 的确定性；真夹具一致性由 hostkey_fixture 断言）。
        let pinned_from_file = {
            // 与 session.rs known_hosts_fingerprint 相同的计算（本地复算）
            let mut parts = line.split_whitespace();
            let b64 = parts.nth(2).unwrap();
            use base64::Engine as _;
            let blob = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .unwrap();
            use sha2::Digest;
            format!(
                "SHA256:{}",
                base64::engine::general_purpose::STANDARD
                    .encode(sha2::Sha256::digest(&blob))
                    .trim_end_matches('=')
            )
        };
        assert_eq!(fp, pinned_from_file);
    }

    #[test]
    fn keyscan_line_fingerprint_rejects_junk() {
        assert_eq!(keyscan_line_fingerprint("# comment"), None);
        assert_eq!(keyscan_line_fingerprint(""), None);
        assert_eq!(keyscan_line_fingerprint("host ssh-ed25519 not-b64!!"), None);
        assert_eq!(
            keyscan_line_fingerprint("host ssh-ed25519 AAAA extra"),
            None,
            "四段行（含端口注释形态）不认"
        );
        // 标准三段行 → 指纹（blob 只需是合法 b64——指纹算法不看键型语义；
        // 真实键形的一致性由 keyscan_line_fingerprint_matches_fixture_pin 锚定）
        let fp = keyscan_line_fingerprint("host ssh-ed25519 AAAA").unwrap();
        assert!(fp.starts_with("SHA256:"));
    }

    // --- audit_once（prober 注入，裁定 #2 的「比对逻辑纯函数+调度 mocked」面）---

    #[test]
    fn audit_once_marks_changed_only_on_anchor_loss() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        // 三行：ok（锚仍在）/ ok（锚消失）/ pending——期望只有第二行被判 changed
        KnownHosts::upsert(&vault, "10.0.0.1:22", "SHA256:CALM").unwrap();
        KnownHosts::verify(&vault, "10.0.0.1:22", "SHA256:CALM").unwrap();
        KnownHosts::upsert(&vault, "10.0.0.2:22", "SHA256:LOST").unwrap();
        KnownHosts::verify(&vault, "10.0.0.2:22", "SHA256:LOST").unwrap();
        KnownHosts::upsert(&vault, "10.0.0.3:22", "SHA256:PENDING").unwrap();
        KnownHosts::upsert(&vault, "legacy:SHA256:OLD", "SHA256:OLD").unwrap();

        let mut probed: Vec<String> = Vec::new();
        let outcome = audit_once(&vault, |hk| {
            probed.push(hk.to_string());
            match hk {
                "10.0.0.1:22" => Ok(vec!["SHA256:CALM".into(), "SHA256:NEWTYPE".into()]),
                "10.0.0.2:22" => Ok(vec!["SHA256:ROTATED".into()]),
                _ => Ok(vec!["SHA256:ANY".into()]),
            }
        })
        .unwrap();

        assert_eq!(
            outcome.checked, 2,
            "pending 与 legacy 行不进探测（只吃 ok+可解析）"
        );
        assert_eq!(probed, vec!["10.0.0.1:22", "10.0.0.2:22"]);
        assert_eq!(outcome.changed.len(), 1);
        let entry = &outcome.changed[0];
        assert_eq!(
            entry.seen,
            vec!["SHA256:ROTATED".to_string()],
            "观测集随行下发"
        );
        let changed = &entry.row;
        assert_eq!(changed.host_key, "10.0.0.2:22");
        assert_eq!(changed.state, KnownHostState::Changed);
        assert_eq!(
            changed.fingerprint, "SHA256:LOST",
            "信任锚保留原值（mark_changed 语义不变）"
        );
        assert!(changed.changed_at.is_some());
        // 库态复核 + 其他行未动
        assert_eq!(
            KnownHosts::get(&vault, "10.0.0.1:22")
                .unwrap()
                .unwrap()
                .state,
            KnownHostState::Ok
        );
    }

    #[test]
    fn audit_once_probe_failure_is_inconclusive_not_changed() {
        let dir = tempfile::tempdir().unwrap();
        let vault = open_vault(dir.path());
        KnownHosts::upsert(&vault, "10.0.0.9:22", "SHA256:FP").unwrap();
        KnownHosts::verify(&vault, "10.0.0.9:22", "SHA256:FP").unwrap();

        // 进程失败（Err）
        let outcome = audit_once(&vault, |_hk| Err("ssh-keyscan not found".into())).unwrap();
        assert_eq!(outcome.checked, 1);
        assert!(outcome.changed.is_empty(), "探测器故障不得判 changed");
        assert_eq!(
            KnownHosts::get(&vault, "10.0.0.9:22")
                .unwrap()
                .unwrap()
                .state,
            KnownHostState::Ok
        );

        // 端点不可达（Ok(空)）
        let outcome = audit_once(&vault, |_hk| Ok(Vec::new())).unwrap();
        assert!(outcome.changed.is_empty(), "空观测 = 不确定，不误报");
    }

    // --- parse_endpoint_key 与 host_endpoint_key 的互逆性（调度面依赖）---

    #[test]
    fn parse_roundtrip_for_endpoint_keys() {
        for (addr, port) in [("10.1.2.3", 22), ("host.example", 2222), ("fe80::5", 2200)] {
            let key = ottr_vault::host_endpoint_key(addr, port);
            assert_eq!(parse_endpoint_key(&key), Some((addr.to_string(), port)));
        }
        assert_eq!(parse_endpoint_key("legacy:SHA256:x"), None);
    }

    /// 巡检轮 in-flight 守卫（M-1，fix round 1）：CAS 抢占互斥——持锁期间第二
    /// 次抢占失败；guard Drop（含 error 路径）释放后可再抢。单测进程内无其他
    /// try_begin_round 调用方（调度器不在单测里 spawn），静态位确定性空闲。
    #[test]
    fn round_guard_is_mutually_exclusive_and_released_on_drop() {
        let g1 = try_begin_round();
        assert!(g1.is_some(), "空闲态首次抢占必须成功");
        assert!(try_begin_round().is_none(), "持锁期间第二次抢占必须失败");
        drop(g1);
        let g2 = try_begin_round();
        assert!(g2.is_some(), "Drop 释放后应可再抢");
        drop(g2); // 归还静态位，不污染后续测试
    }
}
