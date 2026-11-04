//! 真机 E2E 夹具：**记录型** mock sshd（2026-11-04 精灵球多主机隔离验收）。
//!
//! 与 [`mock_kbdint_server`] 同款骨架（进程内 sshd、password 认证、极简
//! 回显 shell），但**多一件事**：把每个连接收到的**原始字节**逐条落盘。
//!
//! 用途：验证「A 终端的 AI 命令绝不写进 B 终端」——两个实例（不同端口、
//! 不同标签）各写自己的日志文件；断言「A 的日志里有该命令、A 的日志里
//! 没有 B 的命令、B 的日志里没有 A 的命令」即构成字节级隔离证据。
//!
//! 用法：
//! ```text
//! cargo run -p ottr-ssh --example mock_recording_server -- <端口> <标签> <日志路径>
//! # 例：cargo run -p ottr-ssh --example mock_recording_server -- 2223 A /tmp/a.log
//! ```
//! 账号固定 `spike`、口令固定 `spike-pass`（与仓库夹具口径一致）。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::Algorithm;
use russh::server::{Auth, Handler, Server as _};

/// 固定账号（与仓库夹具 `scripts/spike-sshd.sh` 同口径）。
const MOCK_USER: &str = "spike";
const MOCK_PASSWORD: &str = "spike-pass";
/// shell 横幅：肉眼可辨「确实连上了」。
const SHELL_BANNER: &[u8] = b"[mock-record] shell ready\r\nspike@mock:~$ ";

/// 连接序号（进程内单调递增）——区分同一实例上的不同连接。
static CONN_SEQ: AtomicU64 = AtomicU64::new(1);

/// 日志写入器：进程内共享，追加写。
#[derive(Clone)]
struct ByteLog {
    path: Arc<Mutex<String>>,
    label: Arc<String>,
}

impl ByteLog {
    fn new(path: &str, label: &str) -> Self {
        Self {
            path: Arc::new(Mutex::new(path.to_string())),
            label: Arc::new(label.to_string()),
        }
    }

    /// 记一条「连接收到字节」。
    fn record(&self, conn: &str, bytes: &[u8]) {
        let line = format!(
            "[{}][{}] len={} data={:?}\n",
            self.label,
            conn,
            bytes.len(),
            String::from_utf8_lossy(bytes)
        );
        let path = self.path.lock().unwrap().clone();
        // 追加写：每次开一次句柄（夹具量级很小，不追求吞吐）。
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }
}

/// 每个 client 连接一份的认证配置。
#[derive(Clone)]
struct MockAuth {
    passwords: Arc<HashMap<&'static str, &'static str>>,
    log: ByteLog,
}

impl Handler for MockAuth {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(match self.passwords.get(user) {
            Some(expected) if *expected == password => Auth::Accept,
            _ => Auth::reject(),
        })
    }

    /// 公钥认证**探测**阶段：russh 0.63 的 publickey 是两阶段——服务端先回
    /// 「这个 key 我认识吗」，客户端再发签名。只实现签名阶段 → 探测就被拒
    /// （2026-11-02 踩过：handler 根本没被调用，日志无痕迹）。
    async fn auth_publickey_offered(
        &mut self,
        _user: &str,
        _key: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    /// 公钥签名阶段：夹具接受任意公钥（只监听 127.0.0.1 的隔离环境；
    /// 公钥本身不是被测对象——被测的是「命令写进了哪条连接」）。
    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &russh::keys::PublicKey,
    ) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    /// 会话通道：开一个**记录型**回显 shell——收到的字节全部落盘再回显。
    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        let (mut read, write) = channel.split();
        let conn = format!("#{}.{}", self.log.label, CONN_SEQ.fetch_add(1, Ordering::SeqCst));
        let log = self.log.clone();
        tokio::spawn(async move {
            if write.data_bytes(SHELL_BANNER.to_vec()).await.is_err() {
                return;
            }
            loop {
                match read.wait().await {
                    Some(russh::ChannelMsg::Data { data }) => {
                        // ★ 隔离证据的采集点：客户端写入的**原始字节**。
                        log.record(&conn, &data);
                        if write.data_bytes(data.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Some(russh::ChannelMsg::Eof)
                    | Some(russh::ChannelMsg::Close)
                    | Some(russh::ChannelMsg::ExitStatus { .. })
                    | None => break,
                    _ => {}
                }
            }
        });
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: russh::ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: russh::ChannelId,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: russh::ChannelId,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }
}

struct MockSshd {
    auth: MockAuth,
}

impl russh::server::Server for MockSshd {
    type Handler = MockAuth;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        self.auth.clone()
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().and_then(|s| s.parse().ok()).unwrap_or(2223);
    let label = args.next().unwrap_or_else(|| "X".to_string());
    let log_path = args.next().unwrap_or_else(|| "/tmp/mock-record.log".to_string());

    let host_key = russh::keys::PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)?;
    let config = Arc::new(russh::server::Config {
        auth_rejection_time: Duration::from_millis(20),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        keys: vec![host_key.clone()],
        inactivity_timeout: None,
        ..Default::default()
    });

    let auth = MockAuth {
        passwords: Arc::new(HashMap::from([(MOCK_USER, MOCK_PASSWORD)])),
        log: ByteLog::new(&log_path, &label),
    };

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!("[mock-record] label={label} listening on 127.0.0.1:{port}  log={log_path}");

    let mut sshd = MockSshd { auth };
    sshd.run_on_socket(config, &listener).await?;
    Ok(())
}
