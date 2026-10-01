//! 端口转发三型真夹具集成测试（Phase 2 Task 1 Step 3，B7 上半）。
//!
//! 目标：local(-L) / remote(-R) / dynamic(-D SOCKS5) 各一条真实数据泵验证，
//! 全部打容器化 sshd（127.0.0.1:2222，spike/spike-pass，scripts/spike-sshd.sh，
//! AllowTcpForwarding yes）。
//!
//! * **L**：本机 bind :0 → 经 direct-tcpip 到容器内 localhost:2222（容器 sshd
//!   自身）——随后用 [`connect_stream`] 在**隧道之上**完成完整 SSH 握手 +
//!   exec whoami（最强的泵验证：双向字节 + 协议层闭环）。
//! * **R**：容器 sshd 监听（bind :0 服务端选口）→ 隧道回本机测试 echo 服务；
//!   容器内以 bash /dev/tcp 连本地转发口、写 12 字节、收回回显。
//! * **D**：本机 SOCKS5（RFC1928 无认证）→ 测试内手写最小客户端握手 →
//!   CONNECT 到容器 2222 → 流交给 [`connect_stream`] 完整 SSH（同 L 闭环）。
//!
//! 断线恢复（stop 容器 → error → start 容器 → 重连 → 自动恢复）在
//! src-tauri/tests/forward_manager_fixture.rs（ForwardManager 属命令域）。
//!
//! 夹具未启动时跳过（同 deploy_fixture 纪律）。
//! Run: `cargo test -p ottr-ssh --test forward_fixture`

use std::sync::Arc;
use std::time::Duration;

use ottr_ssh::forward::{ForwardKind, ForwardSpec, ForwardState, ForwardStats, start_forward};
use ottr_ssh::russh_impl::connect_stream;
use ottr_ssh::{AuthMethod, HostKeyPolicy, RemoteForwardRouter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const TEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 夹具指纹 pin（fixtures/known_hosts，与 deploy_fixture 同源）。
fn pinned_host_key_policy() -> HostKeyPolicy {
    let content = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/known_hosts"
    ))
    .expect("read fixtures/known_hosts（先跑 scripts/spike-sshd.sh）");
    let marker = format!("[{HOST}]:{PORT}");
    let base64 = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .unwrap_or_else(|| panic!("known_hosts has no entry for {marker}"))
        .split_whitespace()
        .nth(2)
        .expect("known_hosts line has base64 column")
        .to_string();
    let pinned = russh::keys::parse_public_key_base64(&base64).expect("parse pinned host key");
    let pinned_fp = pinned.fingerprint(russh::keys::HashAlg::Sha256).to_string();
    let pinned_for_cb = pinned_fp.clone();
    Arc::new(move |fingerprint: &str| fingerprint == pinned_for_cb)
}

async fn fixture_up() -> bool {
    tokio::net::TcpStream::connect((HOST, PORT)).await.is_ok()
}

/// 建一条真实会话（-R 需要挂 router 才能收 forwarded-tcpip）。
async fn connect_fixture(router: Option<RemoteForwardRouter>) -> Arc<ottr_ssh::SshSession> {
    let session = ottr_ssh::connect_with_keepalive(
        HOST,
        PORT,
        USER,
        AuthMethod::Password(PASSWORD.into()),
        pinned_host_key_policy(),
        None,
        router,
    )
    .await
    .expect("connect fixture");
    Arc::new(session)
}

/// 启动一条转发并断言落 Active，返回（实际端口, 统计, 取消令牌）。
async fn start_and_expect_active(
    session: Arc<ottr_ssh::SshSession>,
    router: &RemoteForwardRouter,
    spec: ForwardSpec,
) -> (u16, Arc<ForwardStats>, CancellationToken) {
    let stats = ForwardStats::shared();
    let cancel = CancellationToken::new();
    let running = start_forward(session, router, spec, Arc::clone(&stats), cancel.clone())
        .await
        .expect("start_forward");
    let snapshot = stats.snapshot();
    assert_eq!(snapshot.state, ForwardState::Active, "启动即 Active");
    (running.bound_port, stats, cancel)
}

/// 轮询等状态迁移（任务收尾是异步的）。
async fn wait_for_state(stats: &ForwardStats, want: ForwardState, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if stats.snapshot().state == want {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    stats.snapshot().state == want
}

fn local_spec(bind_port: u16, target_port: u16) -> ForwardSpec {
    ForwardSpec {
        kind: ForwardKind::Local,
        bind_addr: "127.0.0.1".into(),
        bind_port,
        target_host: Some("localhost".into()),
        target_port: Some(target_port),
    }
}

fn skip(name: &str) {
    println!("SKIP {name}: fixture down（先跑 scripts/spike-sshd.sh）");
}

// --- local（-L）：隧道之上完成完整 SSH 握手 + exec ------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn local_forward_carries_full_ssh_session() {
    if !fixture_up().await {
        return skip("local");
    }
    let router = RemoteForwardRouter::new();
    let session = connect_fixture(Some(router.clone())).await;
    let (bound, stats, cancel) =
        start_and_expect_active(Arc::clone(&session), &router, local_spec(0, PORT)).await;
    assert_ne!(bound, 0, "bind :0 必须分配实际端口");

    // 隧道上的完整 SSH：TCP → 本机转发口 → direct-tcpip → 容器 sshd。
    let tcp = tokio::net::TcpStream::connect((HOST, bound))
        .await
        .expect("connect local forward");
    let inner = tokio::time::timeout(
        TEST_TIMEOUT,
        connect_stream(
            tcp,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
        ),
    )
    .await
    .expect("inner connect timeout")
    .expect("inner SSH over tunnel must authenticate");
    let who = inner.exec("whoami").await.expect("exec over tunnel");
    assert_eq!(String::from_utf8_lossy(&who.stdout).trim(), USER);

    // 字节计数（pump 处累加）：SSH 握手 + exec 往返后两向必有量。
    let snapshot = stats.snapshot();
    assert!(snapshot.tx_bytes > 0, "tx 必须有量: {snapshot:?}");
    assert!(snapshot.rx_bytes > 0, "rx 必须有量: {snapshot:?}");
    assert_eq!(snapshot.connections, 1);
    assert_eq!(snapshot.conn_errors, 0);

    // 停止：取消令牌 → 状态 stopped（不覆盖 Active）。
    cancel.cancel();
    assert!(
        wait_for_state(&stats, ForwardState::Stopped, Duration::from_secs(3)).await,
        "取消后必须落 Stopped"
    );
    session.disconnect().await.ok();
}

// --- remote（-R）：容器侧监听 → 隧道回本机 echo 服务 ---------------------------

#[tokio::test(flavor = "multi_thread")]
async fn remote_forward_tunnels_container_to_local_echo() {
    if !fixture_up().await {
        return skip("remote");
    }
    // 本机 echo 目标：收 12 字节原样写回后关闭。
    let echo = tokio::net::TcpListener::bind((HOST, 0))
        .await
        .expect("echo bind");
    let echo_port = echo.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = echo.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 12];
                if sock.read_exact(&mut buf).await.is_ok() {
                    sock.write_all(&buf).await.ok();
                    sock.shutdown().await.ok();
                }
            });
        }
    });

    let router = RemoteForwardRouter::new();
    let session = connect_fixture(Some(router.clone())).await;
    let spec = ForwardSpec {
        kind: ForwardKind::Remote,
        bind_addr: "127.0.0.1".into(),
        bind_port: 0, // 服务端选口（返回实际端口）
        target_host: Some(HOST.into()),
        target_port: Some(echo_port),
    };
    let (bound, stats, cancel) = start_and_expect_active(Arc::clone(&session), &router, spec).await;
    assert_ne!(bound, 0, "服务端必须回报实际监听端口");

    // 容器内 bash /dev/tcp 连转发口：写 12 字节 → 经隧道 → 本机 echo → 回读。
    // （容器无 nc/python3；bash 内建 /dev/tcp 是夹具内唯一零依赖客户端。）
    let cmd = format!(
        "exec 3<>/dev/tcp/127.0.0.1/{bound} && printf 'ping-payload' >&3 && head -c 12 <&3"
    );
    let out = tokio::time::timeout(TEST_TIMEOUT, session.exec(&cmd))
        .await
        .expect("remote exec timeout")
        .expect("exec forwarded echo");
    assert_eq!(
        String::from_utf8_lossy(&out.stdout),
        "ping-payload",
        "容器→隧道→本机→隧道→容器 全程回显必须逐字节一致"
    );

    let snapshot = stats.snapshot();
    assert!(
        snapshot.tx_bytes >= 12 && snapshot.rx_bytes >= 12,
        "双向计数: {snapshot:?}"
    );
    assert_eq!(snapshot.connections, 1);

    cancel.cancel();
    assert!(
        wait_for_state(&stats, ForwardState::Stopped, Duration::from_secs(3)).await,
        "取消后必须落 Stopped"
    );
    session.disconnect().await.ok();
}

// --- dynamic（-D）：SOCKS5 握手 → 隧道 → 完整 SSH ------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn dynamic_forward_socks5_carries_ssh() {
    if !fixture_up().await {
        return skip("dynamic");
    }
    let router = RemoteForwardRouter::new();
    let session = connect_fixture(Some(router.clone())).await;
    let spec = ForwardSpec {
        kind: ForwardKind::Dynamic,
        bind_addr: "127.0.0.1".into(),
        bind_port: 0,
        target_host: None,
        target_port: None,
    };
    let (bound, stats, cancel) = start_and_expect_active(Arc::clone(&session), &router, spec).await;

    // 手写最小 SOCKS5 客户端（RFC1928 无认证 + CONNECT）：
    // 目标 = 容器内 localhost:2222（dynamic 的目标从服务端视角解析）。
    let mut sock = tokio::net::TcpStream::connect((HOST, bound))
        .await
        .expect("connect socks");
    sock.write_all(&[0x05, 0x01, 0x00]).await.expect("greeting");
    let mut method = [0u8; 2];
    sock.read_exact(&mut method).await.expect("method reply");
    assert_eq!(method, [0x05, 0x00], "必须选无认证");
    // CONNECT 127.0.0.1:2222（IPv4 直排）
    let mut req = vec![0x05, 0x01, 0x00, 0x01];
    req.extend_from_slice(&[127, 0, 0, 1]);
    req.extend_from_slice(&PORT.to_be_bytes());
    sock.write_all(&req).await.expect("connect request");
    let mut reply = [0u8; 10];
    sock.read_exact(&mut reply).await.expect("connect reply");
    assert_eq!(reply[0], 0x05);
    assert_eq!(reply[1], 0x00, "REP 必须成功，got {}", reply[1]);

    // 隧道已建立：流上完成完整 SSH 握手 + exec（与 L 同级的闭环泵验证）。
    let inner = tokio::time::timeout(
        TEST_TIMEOUT,
        connect_stream(
            sock,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
        ),
    )
    .await
    .expect("socks inner connect timeout")
    .expect("SSH over SOCKS must authenticate");
    let who = inner.exec("whoami").await.expect("exec over socks");
    assert_eq!(String::from_utf8_lossy(&who.stdout).trim(), USER);

    let snapshot = stats.snapshot();
    assert!(
        snapshot.tx_bytes > 0 && snapshot.rx_bytes > 0,
        "双向计数: {snapshot:?}"
    );
    assert_eq!(snapshot.connections, 1);

    cancel.cancel();
    assert!(
        wait_for_state(&stats, ForwardState::Stopped, Duration::from_secs(3)).await,
        "取消后必须落 Stopped"
    );
    session.disconnect().await.ok();
}

// --- 启动失败路径：bind 冲突 → Error 留痕（同步返回 Err + 状态可读）-----------

#[tokio::test(flavor = "multi_thread")]
async fn start_failure_surfaces_as_error_state() {
    if !fixture_up().await {
        return skip("bind-failure");
    }
    // 占住一个端口，再往同一个端口 bind → EADDRINUSE。
    let blocker = tokio::net::TcpListener::bind((HOST, 0)).await.unwrap();
    let taken = blocker.local_addr().unwrap().port();
    let router = RemoteForwardRouter::new();
    let session = connect_fixture(Some(router.clone())).await;
    let stats = ForwardStats::shared();
    let cancel = CancellationToken::new();
    let err = start_forward(
        Arc::clone(&session),
        &router,
        local_spec(taken, PORT),
        Arc::clone(&stats),
        cancel,
    )
    .await
    .expect_err("bind 冲突必须失败");
    assert!(
        matches!(err, ottr_ssh::Error::Io(_)),
        "返回原始 Io 错误: {err}"
    );
    // 留痕消息（面板展示面）携带 bind 语义与端口。
    let snapshot = stats.snapshot();
    match &snapshot.state {
        ForwardState::Error(msg) => {
            assert!(
                msg.contains("bind") && msg.contains(&taken.to_string()),
                "Error 留痕应携带 bind 语义与端口: {msg}"
            );
        }
        other => panic!("失败必须落 Error 留痕: {other:?}"),
    }
    session.disconnect().await.ok();
}
