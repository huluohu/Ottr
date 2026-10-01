//! JumpSession——跳板链的 teardown owner（Phase 2 Task 2，B7 下半 + Phase 0
//! 终审 Important 挂账清偿）。
//!
//! **问题**（Phase 0 挂账，T15 终审确认）：[`crate::jump::connect`] 只返回
//! target 会话，链上中间跳的 [`SshSession`] 落 drop 即无人持有——russh
//! `Handle::drop` 只打 debug 日志**不关连接**，sshd 侧的每跳 TCP + 会话无限
//! 悬挂。Phase 0 A1 修复只覆盖了「注册前早退」路径，中间跳泄漏是其确认的残余。
//!
//! **裁定**：跳板链的会话所有权收进单一 owner——[`JumpSession`] 持有链上全部
//! 会话（每跳一个 + target），[`JumpSession::disconnect`] 显式拆除全部；任何
//! 一跳都不能先行断开（target 的传输 riding 在跳板会话的 direct-tcpip 通道里，
//! 跳板断了 target 随即断——这也是 [`crate::jump::connect`] 的 API 形状无法
//! 自救的原因：它交不出「全跳所有权」）。
//!
//! 拆除顺序（**target 最先、跳板逆序**）：内层会话的 SSH_MSG_DISCONNECT 必须
//! 经由外层隧道送达——先拆外层会让内层断连帧随隧道猝死（TCP 仍会关，但 sshd
//! 收不到 Disconnect 报文，日志记为异常断开）。逆序（内→外）保证每一跳的
//! DISCONNECT 都在父隧道仍然完整时发出。单跳失败不阻断其余（best-effort
//! 遍历，最后一个错误返回；调用方按日志口径兜底）。
//!
//! 兜底：未显式 [`disconnect`](JumpSession::disconnect) 就 drop 时——能在
//! tokio runtime 上下文内就 spawn 后台任务补发断连（尽力而为，不阻塞 drop）；
//! 无 runtime（同步上下文）只能裸 drop，残余由对端 keepalive/超时兜底（与
//! Phase 0 裸 drop 同口径，此处仅作最后防线）。

use crate::jump::{HopSpec, JumpError, establish_hop_with_keepalive, tunnel_to_with};
use crate::russh_impl::SshSession;
use crate::{Error, RemoteForwardRouter};

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// 一条跳板链上的全部会话（teardown owner）。
///
/// 所有权拓扑：`hops[0..n]` 按跳序持有跳板会话；`target` 是 Arc 化的目标会话
/// （消费方——会话表/SFTP/转发——拿 `Arc<SshSession>` 与直连路径同一形状，
/// 见 src-tauri SessionEntry 集成）。`disconnect()` 拆 target + 全部 hops。
pub struct JumpSession {
    /// 跳板会话，按跳序（hop0 = 本地直连的第一跳）。
    hops: Vec<SshSession>,
    /// 目标会话（Arc：会话表与 JumpSession 共享同一所有者集合）。
    target: Arc<SshSession>,
    /// 已显式拆除（[`Self::disconnect`] 已被调用过，M-2 fix）：Drop 兜底据此
    /// 跳过——disconnect 是对全会话的 best-effort 遍历，之后 Drop 再补一轮
    /// 只会对已关闭的 handle 逐跳产生失败日志（链式关闭 N+1 条噪音），无补救
    /// 价值；兜底只覆盖「从未显式拆除」的路径。
    disconnected: AtomicBool,
}

impl JumpSession {
    /// 沿跳板链连接 `target`，返回持有**全跳**会话的 owner。
    ///
    /// - `chain` 为空时退化为直连 target（跳序号 0，与 [`crate::jump::connect`]
    ///   空链分支同一语义）。
    /// - 任一跳失败即短路返回 [`JumpError::HopFailed`]（带跳序号）；**已建立
    ///   的前序跳会被立即显式拆除**（失败路径不留悬挂连接——A1 语义在链上的
    ///   扩展，mock 测试钉住「失败后服务端会话终结」）。
    /// - 全部会话无 keepalive（spike/夹具对齐面）；生产长连走
    ///   [`Self::connect_with_keepalive`]。
    pub async fn connect(chain: Vec<HopSpec>, target: HopSpec) -> Result<JumpSession, JumpError> {
        Self::connect_with_keepalive(chain, target, None, None).await
    }

    /// [`Self::connect`] 的生产变体：`keepalive` 施加于**全部**会话（跳板与
    /// target 都是长连——任何一跳死链都该被 keepalive 及时发现并使整链可见地
    /// 断开）；`target_router` 挂进 target 连接的 Handler（remote(-R) 转发的
    /// 入站路由，链式主机与直连主机同一语义；跳板连接恒无 router——-R 是
    /// target 服务，中途跳不接收入站转发）。
    pub async fn connect_with_keepalive(
        chain: Vec<HopSpec>,
        target: HopSpec,
        keepalive: Option<Duration>,
        target_router: Option<RemoteForwardRouter>,
    ) -> Result<JumpSession, JumpError> {
        let target_index = chain.len();
        let mut hops = chain.into_iter();

        // 第 0 跳：本地 TCP 直连。链为空则直接连 target。
        let Some(first) = hops.next() else {
            let target = establish_hop_with_keepalive(target, keepalive)
                .await
                .map_err(|source| JumpError::HopFailed {
                    index: 0,
                    source: Box::new(source),
                })?;
            return Ok(JumpSession {
                hops: Vec::new(),
                target: Arc::new(target),
                disconnected: AtomicBool::new(false),
            });
        };
        let mut session = establish_hop_with_keepalive(first, keepalive)
            .await
            .map_err(|source| JumpError::HopFailed {
                index: 0,
                source: Box::new(source),
            })?;
        let mut established: Vec<SshSession> = vec![];

        // 第 1..n 跳：经上一跳的 direct-tcpip 隧道逐级深入。任一跳失败：
        // 显式拆除已建立的跳板（失败路径 teardown，不留悬挂）再带序号返回。
        for (offset, hop) in hops.enumerate() {
            let index = offset + 1;
            match tunnel_to_with(&session, hop, keepalive, None).await {
                Ok(next) => {
                    established.push(std::mem::replace(&mut session, next));
                }
                Err(source) => {
                    established.push(session);
                    teardown_hops(&established).await;
                    return Err(JumpError::HopFailed {
                        index,
                        source: Box::new(source),
                    });
                }
            }
        }

        // target：经最后一跳隧道到达（链为空的情形已在上方返回）。
        // target 挂 router（-R 入站路由）；失败同样拆除全部跳板。
        match tunnel_to_with(&session, target, keepalive, target_router).await {
            Ok(target_session) => {
                established.push(session);
                Ok(JumpSession {
                    hops: established,
                    target: Arc::new(target_session),
                    disconnected: AtomicBool::new(false),
                })
            }
            Err(source) => {
                established.push(session);
                teardown_hops(&established).await;
                Err(JumpError::HopFailed {
                    index: target_index,
                    source: Box::new(source),
                })
            }
        }
    }

    /// 目标会话的共享句柄（会话表 entry.session 与直连路径同一形状；
    /// PTY/SFTP/转发全部开在它上面）。
    pub fn target(&self) -> Arc<SshSession> {
        Arc::clone(&self.target)
    }

    /// 链上跳板数（不含 target）。
    pub fn hop_count(&self) -> usize {
        self.hops.len()
    }

    /// 显式拆除全链：**target 最先、跳板逆序**（见模块文档的顺序论证）。
    /// 单跳失败不阻断其余（best-effort 遍历），全部成功返回 `Ok(())`，
    /// 否则返回最后一个错误。置 `disconnected` 旗标（M-2 fix）：Drop 兜底
    /// 据此跳过——拆除已被本轮 best-effort 覆盖，再补一轮只会对已关闭的
    /// handle 逐跳产生失败日志（链式关闭 N+1 条噪音），无补救价值。
    pub async fn disconnect(&self) -> Result<(), Error> {
        self.disconnected.store(true, Ordering::SeqCst);
        let mut last: Result<(), Error> = Ok(());
        if let Err(e) = self.target.disconnect().await {
            eprintln!("[jump] target disconnect failed: {e}");
            last = Err(e);
        }
        for (i, hop) in self.hops.iter().enumerate().rev() {
            if let Err(e) = hop.disconnect().await {
                eprintln!("[jump] hop {i} disconnect failed: {e}");
                last = Err(e);
            }
        }
        last
    }
}

/// 已建立的跳板会话批量拆除（连接失败路径；逆序与 [`JumpSession::disconnect`]
/// 同一论证）。
async fn teardown_hops(hops: &[SshSession]) {
    for (i, hop) in hops.iter().enumerate().rev() {
        if let Err(e) = hop.disconnect().await {
            eprintln!("[jump] failed-chain teardown hop {i} error: {e}");
        }
    }
}

impl Drop for JumpSession {
    fn drop(&mut self) {
        // 兜底（尽力而为）：未显式 disconnect 就 drop——在 runtime 上下文内
        // spawn 后台补断连（毫秒级后台收尾，不阻塞 drop 调用方）；无 runtime
        // 只能裸 drop（russh Handle::drop 不关连接，残余由对端超时兜底——
        // 最后防线，生产路径由 disconnect() 的显式拆除承担契约）。
        // 已显式拆除（M-2 fix）→ 跳过：对已关闭 handle 的补拆只产生
        // N+1 条 drop-fallback 日志，无补救价值。
        if self.disconnected.load(Ordering::SeqCst) {
            return;
        }
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let hops = std::mem::take(&mut self.hops);
        let target = Arc::clone(&self.target);
        // JoinHandle 即刻 detach（任务自驱收尾；drop 里不能等）。
        drop(tokio::spawn(async move {
            if let Err(e) = target.disconnect().await {
                eprintln!("[jump] drop-fallback target disconnect: {e}");
            }
            for (i, hop) in hops.iter().enumerate().rev() {
                if let Err(e) = hop.disconnect().await {
                    eprintln!("[jump] drop-fallback hop {i} disconnect: {e}");
                }
            }
        }));
    }
}

impl std::fmt::Debug for JumpSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 与 HopSpec 同纪律：会话内部（含认证材料）不进 Debug。
        f.debug_struct("JumpSession")
            .field("hop_count", &self.hops.len())
            .finish_non_exhaustive()
    }
}
