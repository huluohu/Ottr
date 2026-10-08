//! 连接注册生命周期骨架（attach 共用）：connect（限时）→ open_pty →
//! request_shell → 注册会话表 → 起合批转发循环 → 循环退出统一收尾（清表 /
//! session-closed 事件 / 收尾挂钩 / 显式断开）。纯搬家拆分（原 session.rs）。

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

use ottr_ssh::{AuthMethod, HostKeyPolicy, PtyChannel, SshSession};
use ottr_term::encoding::{Encoding, StreamDecoder};
use tokio::sync::Notify;

use super::relay::{SessionClosedPayload, forward_pty_loop};
use super::shell_integration::inject_shell_integration;
use crate::commands::encoding::EncodingHintPayload;
use crate::commands::state::{
    AppState, LANG_PROBE_CMD, LANG_PROBE_TIMEOUT, RegisterArgs, SESSION_SEQ, SessionCounters,
    SessionEntry, SessionMap, TextTail,
};
use crate::vault::VaultState;

/// 连接生命周期骨架（[`attach_session`] 与 [`attach_host_session`] 共用）：
/// connect（限时）→ open_pty（10s）→ request_shell（10s）→ 注册会话表 →
/// 起合批转发循环（Task 9：flush 时按会话 Decoder 解码再 IPC）。
/// 循环退出（对端关闭 / drop_session 取消 / IPC 失败）统一收尾：
/// 清会话表项 + （可选）`ottr://session-closed` 事件 + 显式 disconnect
/// （russh `Handle::drop` 不关连接，必须显式断，见 SshSession::disconnect 文档）。
/// **注册前**（open_pty/request_shell）任一早退——限时超时或协议错——同样
/// 统一收尾：先 best-effort 显式 disconnect 再返回错误（终审 A1，
/// 见 [`close_after_failed_attach`]）。connect 阶段早退无会话可收
/// （[`ottr_ssh::SshSession`] 尚未产出）。
/// `keepalive`：交互式长连传 Some；spike 命令面传 None 保持 Phase 0 语义不变。
/// `initial_encoding`：会话解码初值（host encoding_override 兜底 UTF-8）；
/// `ui_face`：正式 UI 面开关（LANG 探测 + shell 集成自动注入两个后台任务，
/// scripts 驱动面 false 不打扰）；`shell_integration`：settings
/// `shell.integration` 现读值（关 = 不探测不注入，见 [`inject_shell_integration`]）。
/// remote(-R) 转发的入站路由（Phase 2 Task 1）由本函数创建：随 Handler 挂进
/// 连接 + 存会话表项（pf_start/on_session_up 起转发时取用）；无人登记时入站
/// 默认拒绝，spike 面行为不变。
#[allow(clippy::too_many_arguments)]
pub(super) async fn open_and_register(
    sessions: SessionMap,
    close_event: Option<AppHandle>,
    host_id: Option<i64>,
    address: &str,
    port: u16,
    username: &str,
    auth: AuthMethod,
    policy: HostKeyPolicy,
    keepalive: Option<Duration>,
    connect_timeout: Duration,
    err_ctx: String,
    cols: u32,
    rows: u32,
    on_data: Channel<InvokeResponseBody>,
    initial_encoding: Encoding,
    ui_face: bool,
    shell_integration: bool,
) -> Result<String, String> {
    // remote(-R) 转发的入站路由（Phase 2 Task 1）在 connect 前创建：随 Handler
    // 挂进连接 + 成功后存会话表项（pf_start/on_session_up 起转发时取用）；
    // 无人登记时入站默认拒绝，spike 面行为不变。
    let forward_router = ottr_ssh::RemoteForwardRouter::new();
    let session: SshSession = tokio::time::timeout(
        connect_timeout,
        ottr_ssh::connect_with_keepalive(
            address,
            port,
            username,
            auth,
            policy,
            keepalive,
            Some(forward_router.clone()),
        ),
    )
    .await
    .map_err(|_| {
        format!(
            "connect timed out after {}s ({err_ctx})",
            connect_timeout.as_secs()
        )
    })?
    .map_err(|e| format!("connect failed ({err_ctx}): {e}"))?;
    eprintln!("[attach] connected {username}@{address}:{port}");

    register_opened(crate::commands::state::RegisterArgs {
        sessions,
        close_event,
        host_id,
        session: Arc::new(session),
        chain: None,
        forward_router,
        endpoint: format!("{address}:{port}"),
        cols,
        rows,
        on_data,
        initial_encoding,
        ui_face,
        shell_integration,
    })
    .await
}

/// 会话收尾断开（统一面）：链式走 [`ottr_ssh::JumpSession::disconnect`]（target
/// 最先、跳板逆序全链拆除——只断 target 会留下悬挂跳板连接），直连断本会话。
async fn teardown_attached(
    chain: Option<&Arc<ottr_ssh::JumpSession>>,
    session: &SshSession,
) -> ottr_ssh::Result<()> {
    match chain {
        Some(js) => js.disconnect().await,
        None => session.disconnect().await,
    }
}

/// 注册生命周期（[`open_and_register`] 的连接后段与链式 attach 共用，
/// Phase 2 Task 2 拆分；行为与拆分前逐句等价，chain 字段除外）：
/// open_pty（10s）→ request_shell（10s）→ 注册会话表 → 起合批转发循环。
/// 循环退出（对端关闭 / drop_session 取消 / IPC 失败）统一收尾：
/// 清会话表项 + （可选）`ottr://session-closed` 事件 + 显式断开（全链或单会话）。
/// **注册前**（open_pty/request_shell）任一早退——限时超时或协议错——同样
/// 统一收尾：先 best-effort 断开（链式=全链）再返回错误（终审 A1，
/// 见 [`close_after_failed_attach`]）。
pub(super) async fn register_opened(args: RegisterArgs) -> Result<String, String> {
    let RegisterArgs {
        sessions,
        close_event,
        session,
        host_id,
        chain,
        forward_router,
        endpoint,
        cols,
        rows,
        on_data,
        initial_encoding,
        ui_face,
        shell_integration,
    } = args;

    // 终审 A1：注册前阶段（open_pty/request_shell，各限 10s）任一早退——限时
    // 超时或协议错——必须先 best-effort 显式断开再返回错误：russh
    // `Handle::drop` 不关连接，裸 drop 会让客户端 keepalive 任务继续跑、sshd
    // 上的僵尸 SSH 连接无限存活（链式时 Zombie×跳数）。错误文案原样保留
    // （bench/台账对齐口径）。
    let mut channel = match open_shell_channel(&session, cols, rows).await {
        Ok(channel) => channel,
        Err(e) => {
            return Err(
                close_after_failed_attach(e, teardown_attached(chain.as_ref(), &session)).await,
            );
        }
    };

    let id = format!("pty-{}", SESSION_SEQ.fetch_add(1, Ordering::Relaxed));
    let counters = Arc::new(SessionCounters::default());
    let cancel = Arc::new(Notify::new());
    let decoder = Arc::new(Mutex::new(StreamDecoder::new(initial_encoding)));
    let text_tail = Arc::new(TextTail::new());
    // 会话录制槽位（Phase 3 Task 5）：注册即空槽；recording_start 放入、
    // flush_batch tee、stop 命令/循环退出 finalize（槽位归循环收尾任务一份）。
    let recorder: crate::commands::recording::RecorderSlot = Arc::new(Mutex::new(None));
    let writer: Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Send + Unpin>>> = Arc::new(
        tokio::sync::Mutex::new(Box::new(ottr_ssh::pty::writer(&channel))),
    );
    // PTY 尺寸变更挂起槽（缺陷 34）：命令面 resize_session 投槽，转发循环取用。
    let resize = Arc::new(crate::commands::state::SessionResizeSlot::new());
    // session 进 Arc（Task 10）：会话表项持一份（SFTP/传输按 rustId 复用同一
    // 连接），转发循环任务持另一份（退出统一断开）。任一行先消亡，
    // 连接关闭会连带终止另一侧的操作（传输失败报协议错，journal 可续传）。
    // 链式（Phase 2 Task 2）：JumpSession（全跳 owner）由下方转发循环任务
    // 独占持有——生命周期与循环严格同界，收尾点与直连路径同句。
    sessions.lock().unwrap().insert(
        id.clone(),
        SessionEntry {
            session: Arc::clone(&session),
            host_id,
            endpoint,
            writer: Arc::clone(&writer),
            counters: Arc::clone(&counters),
            decoder: Arc::clone(&decoder),
            text_tail: Arc::clone(&text_tail),
            cancel: Arc::clone(&cancel),
            sftp: Arc::new(Mutex::new(None)),
            forward_router: forward_router.clone(),
            recorder: Arc::clone(&recorder),
            cols: cols.min(u16::MAX as u32) as u16,
            rows: rows.min(u16::MAX as u32) as u16,
            resize: Arc::clone(&resize),
        },
    );

    // 读循环持有 channel 与 session（及 chain）；循环退出后统一收尾：清表
    // （此后 session_stats 报 no such session；drop_session 对已消失的 id 幂等
    // 报错，前端容忍）→ session-closed 事件（前端重连状态机的触发点）→
    // 断开（链式=全链拆除）。
    let session_id = id.clone();
    let probe_app = close_event.clone(); // 探测任务与收尾事件各持一份
    let probe_session = ui_face.then(|| Arc::clone(&session));
    // shell 集成注入任务与转发循环共享 writer/text_tail/session（探针看原始
    // 头部、探测走独立 exec 通道、片段写 PTY 输入端）。
    let inject_session = ui_face.then(|| Arc::clone(&session));
    let inject_writer = Arc::clone(&writer);
    let inject_tail = Arc::clone(&text_tail);
    // 端口转发收尾（Phase 2 Task 1）：会话消亡 → Manager 把该会话的转发标
    // Error / 摘除（断线恢复链的上半段；重连恢复挂在 attach_host_session 成功
    // 处的 on_session_up）。close_event 即 ui_face 开关——spike 面无转发可收。
    let forward_close_app = close_event.clone();
    // 录制自动收尾（Phase 3 Task 5）：会话消亡（断线/关标签）→ 槽位若仍有
    // handle = 用户没手动停 → 自动 finalize + 入库（审计痕迹不随连接死亡丢失）。
    // vault 从 app 取（ui_face 才有 close_event；spike 面只落文件留日志）。
    let exit_recorder = Arc::clone(&recorder);
    tauri::async_runtime::spawn(async move {
        let reason = forward_pty_loop(
            &mut channel,
            &on_data,
            &counters,
            &decoder,
            &text_tail,
            &recorder,
            &session_id,
            &cancel,
            &resize,
        )
        .await;
        sessions.lock().unwrap().remove(&session_id);
        {
            let vault_app = forward_close_app.as_ref();
            let vault = vault_app.map(|app| app.state::<VaultState>());
            crate::commands::recording::auto_finalize_on_exit(
                &exit_recorder,
                vault.as_deref().map(|vs| vs.0.as_ref()),
            );
        }
        if let Some(app) = &forward_close_app {
            app.state::<AppState>().forwards.session_down(&session_id);
            // 监控采样同点收尾（Phase 3 Task 1）：会话消亡 → 采样任务摘除即停
            // （guard Drop 即 cancel；此后 monitor_start 对该 id 也会因会话表
            // 已清而显式报错，双保险）。
            app.state::<AppState>().monitors.session_down(&session_id);
        }
        if let Some(app) = &close_event {
            let _ = app.emit(
                "ottr://session-closed",
                SessionClosedPayload {
                    id: session_id.clone(),
                    reason,
                },
            );
        }
        if let Err(e) = teardown_attached(chain.as_ref(), &session).await {
            eprintln!("[batcher:{session_id}] disconnect on exit failed: {e}");
        }
    });

    // LANG 探测（Task 9 detect_hint）：独立 exec 通道异步跑，不阻塞 attach 返回、
    // 不进 PTY 数据流（探测输出不经转发循环）。仅正式 UI 面（probe_lang）。
    // 命中 GBK 家族 → `ottr://encoding-hint`（前端提示条「检测到 GBK，切换？」）；
    // UTF-8 兜底 / exec 失败 / 10s 超时 → 不提示（安全侧，绝不误报打扰）。
    // 注意：家族成员（GBK/GB2312/GB18030）一律归到 GBK 解码建议——保守裁定的
    // 理由与手动切 GB18030 的逃生口见 ottr-term `Encoding::detect_hint` 文档
    // （BL-216 留档）。
    if let Some(probe_session) = probe_session {
        let probe_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let probe =
                tokio::time::timeout(LANG_PROBE_TIMEOUT, probe_session.exec(LANG_PROBE_CMD)).await;
            match probe {
                Ok(Ok(out)) => {
                    let locale = String::from_utf8_lossy(&out.stdout);
                    let hint = ottr_term::Decoder::detect_hint(&locale);
                    eprintln!(
                        "[attach:{probe_id}] LANG probe {:?} -> {}",
                        locale.trim(),
                        hint.name()
                    );
                    if hint == Encoding::Gbk
                        && let Some(app) = probe_app
                    {
                        let _ = app.emit(
                            "ottr://encoding-hint",
                            EncodingHintPayload {
                                id: probe_id,
                                encoding: "gbk".into(),
                            },
                        );
                    }
                }
                Ok(Err(e)) => eprintln!("[attach:{probe_id}] LANG probe exec failed: {e}"),
                Err(_) => eprintln!("[attach:{probe_id}] LANG probe timed out"),
            }
        });
    }

    // shell 集成自动注入（Task 15 fix 1/5，⌘R 历史入库数据源）：仅正式 UI 面
    // 且 settings `shell.integration` 开（缺省开）。探测/幂等/下发全程异步，
    // 不阻塞 attach 返回；结果只打点（注入是增强面，失败不重试——重连即新会话
    // 重走本流程）。
    if let (Some(inj_session), true) = (inject_session, shell_integration) {
        let inject_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome =
                inject_shell_integration(&inject_writer, &inj_session, &inject_tail, true).await;
            eprintln!("[attach:{inject_id}] shell integration: {outcome:?}");
        });
    }
    Ok(id)
}

/// 注册前阶段：open_pty → request_shell（各限 10s，spike 台账限时打点）。
/// 只负责建通道与报错，**不做连接收尾**——调用方对 Err 必须经
/// [`close_after_failed_attach`] 先显式 disconnect（终审 A1）。错误文案是
/// bench/台账对齐口径（"open_pty timed out after 10s" 等），勿改。
async fn open_shell_channel(
    session: &SshSession,
    cols: u32,
    rows: u32,
) -> Result<PtyChannel, String> {
    let mut channel = tokio::time::timeout(Duration::from_secs(10), session.open_pty(cols, rows))
        .await
        .map_err(|_| "open_pty timed out after 10s".to_string())?
        .map_err(|e| format!("open_pty failed: {e}"))?;
    eprintln!("[attach] pty open ({cols}x{rows})");
    tokio::time::timeout(
        Duration::from_secs(10),
        ottr_ssh::pty::request_shell(&mut channel),
    )
    .await
    .map_err(|_| "request_shell timed out after 10s".to_string())?
    .map_err(|e| format!("request_shell failed: {e}"))?;
    eprintln!("[attach] shell running");
    Ok(channel)
}

/// attach 注册前失败的统一收尾（终审 A1）：先 best-effort 显式 `disconnect`
/// 再原样带回错误。russh `Handle::drop` 只打 debug 日志**不关连接**（见
/// [`SshSession::disconnect`] 文档）——裸 drop 会让客户端 keepalive 任务继续
/// 跑、服务端僵尸 SSH 连接无限存活。disconnect 自身失败（连接已死/会话任务
/// 已退）只打日志，不吞原始错误。`disconnect` 拆成独立参数是回归测试 seam
/// （可观测断言断连被调用）；生产面调用恒传 `session.disconnect()`。
async fn close_after_failed_attach(
    err: String,
    disconnect: impl std::future::Future<Output = ottr_ssh::Result<()>>,
) -> String {
    if let Err(e) = disconnect.await {
        eprintln!("[attach] best-effort disconnect after failed attach: {e}");
    }
    err
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicU64;
    use std::time::Instant;

    // --- 终审 A1 回归：注册前早退路径必须显式 disconnect --------------------
    //
    // 进程内 mock sshd（russh::server::run_stream + 自持 accept 循环）：
    // 握手 + 密码认证放行；channel open 行为按用例配置——
    // * hang=true：handler pending 不回 → 客户端 open_pty 走 10s 超时路径（A1 字面路径）；
    // * hang=false：handler 直接返回、reply handle 落 drop = 自动拒绝（russh 默认
    //   语义）→ 客户端 open_pty 走快速协议错路径。
    // 断连观测点：每连接 `RunningSession` 完成 = 服务端观测到会话结束，落账
    // `closed`（显式 disconnect / 裸 drop 后 russh runner 自行收尾都会触发）。

    struct MockSshd {
        /// 认证成功次数（证明早退发生在建连之后）。
        connected: AtomicU64,
        /// 连接结束次数（服务端会话返回 = 连接被显式关闭的证据）。
        closed: AtomicU64,
    }

    struct MockSshHandler {
        hang_channel_open: bool,
        state: Arc<MockSshd>,
    }

    impl russh::server::Handler for MockSshHandler {
        // russh 要求 Error: From<russh::Error>；测试面直接复用 russh::Error
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(russh::server::Auth::Accept)
        }

        async fn auth_succeeded(
            &mut self,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            self.state.connected.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn channel_open_session(
            &mut self,
            _channel: russh::Channel<russh::server::Msg>,
            _reply: russh::server::ChannelOpenHandle,
            _session: &mut russh::server::Session,
        ) -> Result<(), Self::Error> {
            if self.hang_channel_open {
                std::future::pending().await
            }
            // 不碰 reply（落 drop）= 自动拒绝：客户端 open_pty 快速协议错
            Ok(())
        }
    }

    /// 起一个 mock sshd（127.0.0.1 随机端口），返回 (地址, 观测账本)。
    async fn spawn_mock_sshd(hang_channel_open: bool) -> (std::net::SocketAddr, Arc<MockSshd>) {
        let state = Arc::new(MockSshd {
            connected: AtomicU64::new(0),
            closed: AtomicU64::new(0),
        });
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .expect("mock sshd Ed25519 host key");
        let config = Arc::new(russh::server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let ledger = Arc::clone(&state);
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let cfg = Arc::clone(&config);
                let st = Arc::clone(&ledger);
                tauri::async_runtime::spawn(async move {
                    let handler = MockSshHandler {
                        hang_channel_open,
                        state: Arc::clone(&st),
                    };
                    if let Ok(session) = russh::server::run_stream(cfg, stream, handler).await {
                        let _ = session.await;
                    }
                    st.closed.fetch_add(1, Ordering::SeqCst);
                });
            }
        });
        (addr, state)
    }

    /// 对 mock sshd 走完整 attach（attach_host_session 的 open_and_register 骨架，
    /// 关闭 ui_face/shell 集成旁路，指纹全放行）。
    async fn attach_against_mock(
        addr: std::net::SocketAddr,
    ) -> (Result<String, String>, SessionMap) {
        let sessions: SessionMap = Arc::new(Mutex::new(HashMap::new()));
        let result = open_and_register(
            Arc::clone(&sessions),
            None,
            None,
            "127.0.0.1",
            addr.port(),
            "tester",
            AuthMethod::Password("pw".into()),
            Arc::new(|_| true), // 测试面：指纹全放行
            None,
            Duration::from_secs(5),
            "a1-test".into(),
            80,
            24,
            Channel::new(|_: InvokeResponseBody| Ok(())),
            Encoding::Utf8,
            false,
            false,
        )
        .await;
        (result, sessions)
    }

    /// A1 回归（wire 级，快速路径）：open_pty 协议错早退后不留任何活性残留——
    /// 服务端必须观测到会话结束（显式 disconnect 毫秒级可达）。注：russh 0.63.3
    /// 在最后一个 Handle 落 drop 后 runner 也会经 receiver-None 自行收尾，故本
    /// 断言不区分显式/隐式关闭；「先显式 disconnect 再返回错误」的契约由
    /// [`close_after_failed_attach_awaits_disconnect_then_returns_error`]（seam
    /// mock 断言）+ 单一 match 收尾臂承担，本例守住端到端下界：真实建连 →
    /// 早退报错（协议错文案）→ 会话表无残留 → 服务端会话 5s 内终结。
    #[test]
    fn attach_pre_register_failure_disconnects_connection() {
        tauri::async_runtime::block_on(async {
            let (addr, state) = spawn_mock_sshd(false).await;
            let (result, sessions) = attach_against_mock(addr).await;

            assert!(
                state.connected.load(Ordering::SeqCst) >= 1,
                "mock sshd 未收到成功认证的连接，早退路径未生效"
            );
            let err = result.expect_err("open_pty 被拒必须失败");
            assert!(err.starts_with("open_pty failed: "), "actual: {err}");
            assert!(sessions.lock().unwrap().is_empty(), "会话表不得残留");

            let deadline = Instant::now() + Duration::from_secs(5);
            while state.closed.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(
                state.closed.load(Ordering::SeqCst) >= 1,
                "注册前早退后服务端会话未终结：存在活性残留（A1 回归）"
            );
        });
    }

    /// A1 收尾核 seam 契约（mock 可观测 disconnect 调用）：任一注册前早退的
    /// 错误都必须先 await disconnect（断连恰好一次）再原样带回；disconnect
    /// 自身失败只吞错（生产面打日志），绝不顶替原始错误。
    #[test]
    fn close_after_failed_attach_awaits_disconnect_then_returns_error() {
        let calls = Arc::new(AtomicU64::new(0));
        // disconnect 成功面：断连被调用、错误文案零改动
        let c = Arc::clone(&calls);
        let err = tauri::async_runtime::block_on(close_after_failed_attach(
            "open_pty timed out after 10s".into(),
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
        ));
        assert_eq!(err, "open_pty timed out after 10s");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // disconnect 失败面：吞错（打日志），原始错误原样穿透
        let c = Arc::clone(&calls);
        let err = tauri::async_runtime::block_on(close_after_failed_attach(
            "request_shell failed: boom".into(),
            async move {
                c.fetch_add(1, Ordering::SeqCst);
                Err(ottr_ssh::Error::AuthRejected)
            },
        ));
        assert_eq!(err, "request_shell failed: boom");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    /// A1 回归（字面路径）：open_pty 限时超时早退——错误文案精确对齐台账
    /// （ottr-bench 断言 "open_pty timed out after 10s"）+ 会话表无残留。
    /// 挂起的 handler 卡死服务端会话循环（无法观测断连），wire 级断连证据由
    /// [`attach_pre_register_failure_disconnects_connection`] 承担（同一 match
    /// 收尾臂，[`close_after_failed_attach`] 生产面恒传真 `session.disconnect()`）。
    #[test]
    fn attach_openpty_timeout_returns_error_without_residue() {
        tauri::async_runtime::block_on(async {
            let (addr, state) = spawn_mock_sshd(true).await;
            let (result, sessions) = attach_against_mock(addr).await;

            assert!(
                state.connected.load(Ordering::SeqCst) >= 1,
                "超时必须发生在建连成功之后（A1 指控的路径）"
            );
            assert_eq!(
                result.expect_err("open_pty 挂起必须超时"),
                "open_pty timed out after 10s"
            );
            assert!(sessions.lock().unwrap().is_empty(), "会话表不得残留");
        });
    }
}
