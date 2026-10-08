//! BL-207①：PTY resize → SSH `window-change` 报文的 wire 级测试钉。
//!
//! 会话命令域的 resize 链（缺陷 34）= 前端 fit → `resize_session` 命令投
//! 挂起槽 → 合批转发循环 select 唤醒后调 `Channel::window_change(cols, rows,
//! 0, 0)`（src-tauri commands/session.rs `forward_pty_loop`）。本测试钉住该
//! 链的**最后一环**：客户端 `window_change` 调用确实以正确的 cols/rows 抵达
//! 服务端（russh server `window_change_request` 回调观测）——readline 收
//! SIGWINCH 重绘的前提。挂起槽/命令面/前端守卫由各自测试覆盖（state.rs
//! resize_slot_*、SessionStore.test.ts resizeSession）。
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession, connect};
use russh::server::{Auth, Server as _};

type SizeLog = Arc<Mutex<Vec<(u32, u32)>>>;

#[derive(Clone)]
struct MockAuth {
    sizes: SizeLog,
}

impl russh::server::Handler for MockAuth {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    /// 服务端观测点：记录收到的 (cols, rows)。
    async fn window_change_request(
        &mut self,
        _channel: russh::ChannelId,
        col_width: u32,
        row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.sizes.lock().unwrap().push((col_width, row_height));
        Ok(())
    }
}

struct MockSshd {
    sizes: SizeLog,
}

impl russh::server::Server for MockSshd {
    type Handler = MockAuth;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        MockAuth {
            sizes: Arc::clone(&self.sizes),
        }
    }
}

async fn spawn_mock_sshd() -> (SocketAddr, SizeLog) {
    let sizes: SizeLog = Arc::new(Mutex::new(Vec::new()));
    let host_key =
        russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
            .expect("generate host key");
    let config = Arc::new(russh::server::Config {
        keys: vec![host_key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ledger = Arc::clone(&sizes);
    tokio::spawn(async move {
        let mut sshd = MockSshd { sizes: ledger };
        let _ = sshd.run_on_socket(config, &listener).await;
    });
    (addr, sizes)
}

fn accept_all_policy() -> HostKeyPolicy {
    Arc::new(|_| true)
}

/// open_pty 后连发两次 window_change（模拟 fit 期连续 resize）：服务端必须
/// 按序收到两次正确尺寸（lock-and-send 语义 = 终端每次真实 resize 都到达）。
#[tokio::test]
async fn window_change_reaches_server_with_correct_dimensions() {
    let (addr, sizes) = spawn_mock_sshd().await;
    let session: SshSession = connect(
        &addr.ip().to_string(),
        addr.port(),
        "spike",
        AuthMethod::Password("pw".into()),
        accept_all_policy(),
    )
    .await
    .expect("connect mock sshd");
    let channel = session.open_pty(80, 24).await.expect("session channel");

    // forward_pty_loop 的同一调用面（russh Channel::window_change）。
    channel
        .window_change(117, 46, 0, 0)
        .await
        .expect("window_change 1");
    channel
        .window_change(211, 12, 0, 0)
        .await
        .expect("window_change 2");

    // 轮询等两条记录到齐（服务端处理是异步的）。
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let snap = loop {
        {
            let s = sizes.lock().unwrap();
            if s.len() >= 2 {
                break s.clone();
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "window_change 5s 内未全部抵达服务端"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    assert_eq!(
        snap,
        vec![(117, 46), (211, 12)],
        "服务端按序收到正确 cols/rows"
    );
}
