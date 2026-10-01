//! 跳板链：链式 direct-tcpip 隧道 + 逐跳断点定位（Phase 0 Spike#5，B7「可视化跳板链」核心）。
//!
//! **生产入口是 [`crate::jump_session::JumpSession`]**（Phase 2 Task 2）：本模块的
//! [`connect`] 返回裸 target 会话，中间跳的连接无人持有（russh `Handle::drop`
//! 不关连接）——生产路径必须用 JumpSession 持有全跳并显式拆除。
//!
//! 连接拓扑：
//!
//! ```text
//! local ──ssh── hop0 ──direct-tcpip+ssh── hop1 ──direct-tcpip+ssh── target
//! ```
//!
//! 对链上第 i 跳（i ≥ 1）：经第 i-1 跳的会话
//! `channel_open_direct_tcpip(hop_i.host, hop_i.port)` 打开隧道流，再以
//! [`crate::russh_impl::connect_stream`] 在流上完成下一跳的握手与认证；
//! 第 0 跳与普通连接相同（本地 TCP 直连）。target 同理经最后一跳隧道到达。
//!
//! **断点定位**（B7 的产品级承诺）：任一跳建立失败时返回
//! [`JumpError::HopFailed`]，`index` 直接指明断在第几跳——UI 据此高亮链条上
//! 具体节点，而不是抛一个笼统的连接超时。远端不可达时 sshd 回
//! CHANNEL_OPEN_FAILURE，错误**立即**返回（见
//! [`SshSession::open_direct_tcpip_stream`]）。
//!
//! ```no_run
//! # async fn demo() -> Result<(), ottr_ssh::JumpError> {
//! use ottr_ssh::{jump, AuthMethod, HopSpec};
//!
//! // spike：生产上必须逐跳 pin 指纹，不允许一律放行
//! let policy: ottr_ssh::HostKeyPolicy = std::sync::Arc::new(|_fp: &str| true);
//! let hop = |host: &str, port: u16| HopSpec {
//!     host: host.into(),
//!     port,
//!     username: "spike".into(),
//!     auth: AuthMethod::Password("spike-pass".into()),
//!     host_key: std::sync::Arc::clone(&policy),
//! };
//! // 两级跳板到目标（第 i ≥ 1 跳的地址按「从上一跳视角」解析）：
//! let session = jump::connect(
//!     vec![hop("10.0.0.1", 22), hop("10.0.1.1", 22)],
//!     hop("10.0.2.1", 22),
//! ).await?;
//! # Ok(())
//! # }
//! ```

use crate::auth::HostKeyPolicy;
use crate::russh_impl::SshSession;
use crate::{AuthMethod, Error};

/// 跳板链上一跳（或目标）的连接规格。
pub struct HopSpec {
    /// 主机名/IP。注意：第 i ≥ 1 跳的地址是**从上一跳视角**解析的
    /// （direct-tcpip 的 TCP 连接由上一跳的 sshd 发起）。
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    /// 本跳的 host key 策略（每跳独立，便于逐跳 pin / TOFU）。
    pub host_key: HostKeyPolicy,
}

impl std::fmt::Debug for HopSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // auth 不进 Debug（不把密码/密钥口令泄漏进日志）。
        f.debug_struct("HopSpec")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .finish_non_exhaustive()
    }
}

/// 跳板链错误。**必须**携带「断在第几跳」（B7 断点定位的契约），不允许
/// 把链路失败折叠成一个笼统的连接错误；russh 类型不出现在公共变体中
/// （I-1 同款纪律），底层原因经 `source`（内包 crate 自有 [`Error`]）可追溯。
#[derive(Debug)]
pub enum JumpError {
    /// 第 `index` 跳建立失败。序号从 0 起：`0..chain.len()` 为跳板，
    /// `chain.len()` 为 target。`source` 内包该跳失败的具体原因
    /// （[`Error::AuthRejected`] / [`Error::HostKeyRejected`] /
    /// [`Error::Protocol`]…），UI 可再按原因细分文案。
    HopFailed { index: usize, source: Box<Error> },
}

impl std::fmt::Display for JumpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JumpError::HopFailed { index, source } => {
                write!(f, "jump chain failed at hop {index}: {source}")
            }
        }
    }
}

impl std::error::Error for JumpError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            JumpError::HopFailed { source, .. } => Some(source),
        }
    }
}

/// 沿跳板链连接 `target`，返回**目标机器**上的会话。
///
/// - `chain` 为空时退化为直连 target（与单跳 [`crate::connect`] 等价，跳序号 0）。
/// - 任一跳失败即短路返回 [`JumpError::HopFailed`]（带跳序号），不尝试余下链路。
pub async fn connect(chain: Vec<HopSpec>, target: HopSpec) -> Result<SshSession, JumpError> {
    // target 在链条（跳板 + target）中的序号 = 跳板数。
    let target_index = chain.len();
    let mut hops = chain.into_iter();

    // 第 0 跳：本地 TCP 直连。链为空则直接连 target。
    let Some(first) = hops.next() else {
        return establish_hop(target)
            .await
            .map_err(|source| JumpError::HopFailed {
                index: 0,
                source: Box::new(source),
            });
    };
    let mut session = establish_hop(first)
        .await
        .map_err(|source| JumpError::HopFailed {
            index: 0,
            source: Box::new(source),
        })?;

    // 第 1..n 跳：经上一跳的 direct-tcpip 隧道逐级深入。
    for (offset, hop) in hops.enumerate() {
        let index = offset + 1;
        session = tunnel_to(&session, hop)
            .await
            .map_err(|source| JumpError::HopFailed {
                index,
                source: Box::new(source),
            })?;
    }

    // target：经最后一跳隧道到达（链为空的情形已在上方返回）。
    tunnel_to(&session, target)
        .await
        .map_err(|source| JumpError::HopFailed {
            index: target_index,
            source: Box::new(source),
        })
}

/// 建立一跳的会话：本地 TCP 直连 + 握手 + 认证（第 0 跳与空链直连 target 共用）。
/// `keepalive`：生产链路（[`crate::jump_session::JumpSession`]）传 `Some` 开
/// 传输层 keepalive；spike 面（[`connect`]）传 None 保持 Phase 0 语义不变。
pub(crate) async fn establish_hop_with_keepalive(
    hop: HopSpec,
    keepalive: Option<std::time::Duration>,
) -> Result<SshSession, Error> {
    crate::russh_impl::connect_with_keepalive(
        &hop.host,
        hop.port,
        &hop.username,
        hop.auth,
        hop.host_key,
        keepalive,
        None,
    )
    .await
}

/// 经 `via` 会话的 direct-tcpip 隧道建立下一跳会话：
/// 隧道流（服务端侧完成 TCP 连接）→ 在流上握手 + 认证。
/// `keepalive`/`router` 语义同 [`establish_hop_with_keepalive`]；`router` 只
/// 在 target 连接上有意义（-R 入站路由），中间跳恒 None（见 JumpSession 文档）。
pub(crate) async fn tunnel_to_with(
    via: &SshSession,
    hop: HopSpec,
    keepalive: Option<std::time::Duration>,
    router: Option<crate::forward::RemoteForwardRouter>,
) -> Result<SshSession, Error> {
    let stream = via.open_direct_tcpip_stream(&hop.host, hop.port).await?;
    crate::russh_impl::connect_stream_with_keepalive(
        stream,
        &hop.username,
        hop.auth,
        hop.host_key,
        keepalive,
        router,
    )
    .await
}

/// 建立一跳的会话（Phase 0 spike 面：无 keepalive）。
async fn establish_hop(hop: HopSpec) -> Result<SshSession, Error> {
    establish_hop_with_keepalive(hop, None).await
}

/// 经 `via` 会话的 direct-tcpip 隧道建立下一跳会话（Phase 0 spike 面：无 keepalive）。
async fn tunnel_to(via: &SshSession, hop: HopSpec) -> Result<SshSession, Error> {
    tunnel_to_with(via, hop, None, None).await
}
