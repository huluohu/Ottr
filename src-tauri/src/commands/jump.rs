//! 跳板链命令域（Phase 2 Task 2，B7 下半）：jump_chains CRUD 命令 + 链上
//! 逐跳规格解析（[`build_hop_specs`]，attach_host_session 链式路径与
//! [`jc_test`] 共用）+ 测试连接。
//!
//! 分层（沿 Task 0 / Task 1 结构）：
//! * [`JumpSession`](ottr_ssh::JumpSession)（ottr-ssh）= 全跳会话持有与显式
//!   拆除的 teardown owner（Phase 0 挂账清偿）；
//! * [`JumpChains`](ottr_vault::JumpChains) = 存储层 CRUD；本模块只做门卫/
//!   解析/装配。新命令域入 commands/（Global Constraint：lib.rs 只减不增）。
//!
//! 逐跳语义（裁定）：链上**每一跳都是 hosts 表里的真实主机行**（hops =
//! host_id 有序数组）——端点/端口/用户名/凭据按该行解析；host key 逐跳走与
//! 直连同一套 TOFU 状态机（信任锚 = 该跳自己的网络端点，known_hosts 同表
//! 记账），确认框载荷带跳序号与发起主机（前端归属到在途 connect 的标签）。

use tauri::{AppHandle, State};

use ottr_ssh::HopSpec;
use ottr_vault::{JumpChain, JumpChainInput, JumpChains};

use super::state::HostKeyAsks;
use crate::keys;
use crate::vault::{ensure_unlocked, CmdResult, VaultState};

/// 链式连接的限时预算系数：每跳 = host key 问询窗口 60s（HOST_KEY_ASK_TIMEOUT）
/// + 网络预算 15s（与直连路径 75s 同口径，乘跳数）。target 也算一跳。
const BUDGET_PER_HOP_SECS: u64 = 75;

/// 链上逐跳解析结果：specs 按跳序排列；guards 是各跳 key 凭据的临时 PEM
/// 文件守卫（必须活到连接完成后——认证期间文件要存在；调用方把它们绑在
/// connect 的作用域里）。
pub(crate) struct ChainSpecs {
    pub(crate) hops: Vec<HopSpec>,
    #[allow(dead_code)] // 生命周期承载：guard Drop 即删临时 PEM（见 keys.rs）
    pub(crate) guards: Vec<keys::TempKeyGuard>,
}

/// 把 `hop_host_ids`（jump_chains.hops 的 host_id 有序数组）解析为连接规格：
/// 每跳取自己的 host 行（端点/端口/用户名/凭据），host key 策略 = 逐跳 TOFU
/// （载荷带跳序号 + `origin_host_id`，UI 归属到发起连接的主机标签）。
/// 任一跳缺用户名/凭据/端口越界 → 显式报错（不静默跳过——链的安全性与
/// 可达性等价于最弱一跳）。
pub(crate) async fn build_hop_specs(
    vault: &VaultState,
    app: &AppHandle,
    asks: &HostKeyAsks,
    hop_host_ids: &[i64],
    origin_host_id: i64,
) -> Result<ChainSpecs, String> {
    let mut hops = Vec::with_capacity(hop_host_ids.len());
    let mut guards = Vec::with_capacity(hop_host_ids.len());
    for (index, &hop_host_id) in hop_host_ids.iter().enumerate() {
        let hop_host = ottr_vault::Hosts::get(&vault.0, hop_host_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("chain hop host id={hop_host_id} not found"))?;
        let username = hop_host.username.ok_or_else(|| {
            format!(
                "chain hop {} ({}) has no username",
                index + 1,
                hop_host.name
            )
        })?;
        let credential_id = hop_host.credential_id.ok_or_else(|| {
            format!(
                "chain hop {} ({}) has no credential bound",
                index + 1,
                hop_host.name
            )
        })?;
        let (auth, guard) = keys::resolve_credential_auth(vault, credential_id).await?;
        let port = u16::try_from(hop_host.port).map_err(|_| {
            format!(
                "chain hop {} ({}): port {} out of range",
                index + 1,
                hop_host.name,
                hop_host.port
            )
        })?;
        let policy = super::session::tofu_host_key_policy(
            std::sync::Arc::clone(&vault.0),
            app.clone(),
            hop_host.id,
            hop_host.name.clone(),
            // 信任锚 = 该跳自己的网络端点（与直连同一条 known_hosts 记账语义）
            ottr_vault::host_endpoint_key(&hop_host.address, hop_host.port),
            std::sync::Arc::clone(asks),
            Some(index),
            Some(origin_host_id),
        );
        hops.push(HopSpec {
            host: hop_host.address.clone(),
            port,
            username,
            auth,
            host_key: policy,
        });
        guards.push(guard);
    }
    Ok(ChainSpecs { hops, guards })
}

// ---------------------------------------------------------------------------
// 命令面（配置 CRUD 过锁定门卫，与 hosts/pf_* 同语义；jc_test = 连接面）
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn jc_list(vault: State<'_, VaultState>) -> CmdResult<Vec<JumpChain>> {
    ensure_unlocked(&vault.0)?;
    JumpChains::list(&vault.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn jc_create(
    vault: State<'_, VaultState>,
    input: JumpChainInput,
) -> CmdResult<JumpChain> {
    ensure_unlocked(&vault.0)?;
    JumpChains::create(&vault.0, &input).map_err(|e| e.to_string())
}

/// 全量替换式更新（name/hops 一起提交；连接中的会话不受影响——规格在
/// connect 时已固化，下次连接按新配置）。
#[tauri::command]
pub(crate) fn jc_update(
    vault: State<'_, VaultState>,
    id: i64,
    input: JumpChainInput,
) -> CmdResult<JumpChain> {
    ensure_unlocked(&vault.0)?;
    JumpChains::update(&vault.0, id, &input).map_err(|e| e.to_string())
}

/// 删链（引用该链的主机在存储层一并解绑，见 ottr-vault JumpChains::delete）。
#[tauri::command]
pub(crate) fn jc_delete(vault: State<'_, VaultState>, id: i64) -> CmdResult<()> {
    ensure_unlocked(&vault.0)?;
    JumpChains::delete(&vault.0, id).map_err(|e| e.to_string())
}

/// 测试连接结果（serde snake_case，前端 `JumpTestResult` 同构）。
#[derive(Clone, serde::Serialize)]
pub struct JumpTestResult {
    pub ok: bool,
    /// 失败跳序号（0 起，`chain.len()` = target；None = 非跳点失败如超时）。
    pub hop: Option<usize>,
    pub error: Option<String>,
    pub elapsed_ms: u64,
}

/// 测试连接：按**当前编辑中的 hop 序列**建一条真实链（最后一个 hop 当
/// target，其余当跳板——与「链的末位之后接 target」的连接语义一致，未保存
/// 的编辑也可测试）。连接成功立即显式拆除（测试不注册会话、不留连接）。
/// host key 沿链逐跳 TOFU（确认框会弹出，与真实连接同一交互）。
#[tauri::command]
pub(crate) async fn jc_test(
    vault: State<'_, VaultState>,
    app: AppHandle,
    state: State<'_, super::state::AppState>,
    hops: Vec<i64>,
) -> CmdResult<JumpTestResult> {
    ensure_unlocked(&vault.0)?;
    if hops.is_empty() {
        return Ok(JumpTestResult {
            ok: false,
            hop: None,
            error: Some("jump chain has no hops".into()),
            elapsed_ms: 0,
        });
    }
    let started = std::time::Instant::now();
    let specs = build_hop_specs(
        &vault,
        &app,
        &state.host_key_asks,
        &hops,
        hops[hops.len() - 1],
    )
    .await?;
    // 测试语义：末位 = target，其余 = 跳板（单跳链 = 直连测试该主机）。
    let split = specs.hops.len() - 1;
    let mut chain_hops = specs.hops;
    let target_hop = chain_hops.split_off(split);
    let target_spec = target_hop
        .into_iter()
        .next()
        .expect("split_off 后必有 1 跳");
    let budget = std::time::Duration::from_secs(BUDGET_PER_HOP_SECS * (split as u64 + 1));
    // 短生命周期测试连接：无 keepalive、无 -R 路由（与 spike/jump::connect 同口径）。
    let outcome = tokio::time::timeout(
        budget,
        ottr_ssh::JumpSession::connect(chain_hops, target_spec),
    )
    .await;
    let elapsed_ms = started.elapsed().as_millis() as u64;
    match outcome {
        Err(_) => Ok(JumpTestResult {
            ok: false,
            hop: None,
            error: Some(format!("connect timed out after {}s", budget.as_secs())),
            elapsed_ms,
        }),
        Ok(Ok(js)) => {
            // 成功即拆（best-effort；失败只留日志——测试连接不留任何活连接）。
            if let Err(e) = js.disconnect().await {
                eprintln!("[jc_test] disconnect after success failed: {e}");
            }
            Ok(JumpTestResult {
                ok: true,
                hop: None,
                error: None,
                elapsed_ms,
            })
        }
        Ok(Err(e)) => {
            let (hop, msg) = match e {
                ottr_ssh::JumpError::HopFailed { index, ref source } => {
                    (Some(index), source.to_string())
                }
            };
            Ok(JumpTestResult {
                ok: false,
                hop,
                error: Some(msg),
                elapsed_ms,
            })
        }
    }
}
