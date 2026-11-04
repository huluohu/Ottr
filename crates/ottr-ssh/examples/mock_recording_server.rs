//! 真机 E2E 夹具：**记录型** mock sshd（2026-11-04 精灵球多主机隔离验收）。
//!
//! 与 [`mock_kbdint_server`] 同款骨架（进程内 sshd、password 认证、极简
//! 回显 shell），但**多一件事**：把每个连接收到的**原始字节**逐条落盘。
//!
//! 用途：验证「A 终端的 AI 命令绝不写进 B 终端」——两个实例（不同端口、
//! 不同标签）各写自己的日志文件；断言「A 的日志里有该命令、A 的日志里
//! 没有 B 的命令、B 的日志里没有 A 的命令」即构成字节级隔离证据。
//!
//! 记的事件（`event=` 行）：`channel-open` / `pty-request` / `exec-request:…`
//! / `exec-exit:<码>` / `exec-hang` / `subsystem-request:…` / **`channel-close`**
//! （2026-11-04 第二步新增：客户端**显式**关闭通道的取证面——消费侧硬超时
//! 命中时会走到这里，即「远端不留悬挂 shell」的服务端侧证据）。
//!
//! **exec 通道会真执行命令**（2026-11-04 第三步新增）：命令原文交给
//! `sh -c` 跑，回传 stdout / stderr / 退出码 —— 这样真机验收能覆盖
//! 「执行成功 → 输出与退出码回灌模型」的**成功路径**（此前只记录不执行，
//! 每次都落到超时分支，成功路径在真机上永远验不到）。
//!
//! 命令里带 **`__hang__`** 标记 → **不回复任何数据**（模拟远端命令挂起）：
//! 用来触发客户端消费侧硬超时 → 显式关通道（超时路径的取证面）。
//!
//! 用法：
//! ```text
//! cargo run -p ottr-ssh --example mock_recording_server -- <端口> <标签> <日志路径>
//! # 例：cargo run -p ottr-ssh --example mock_recording_server -- 2223 A /tmp/a.log
//! ```
//! 账号固定 `spike`、口令固定 `spike-pass`（与仓库夹具口径一致）。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::Algorithm;
use russh::server::{Auth, Handler, Server as _};

/// 固定账号（与仓库夹具 `scripts/spike-sshd.sh` 同口径）。
const MOCK_USER: &str = "spike";
const MOCK_PASSWORD: &str = "spike-pass";
/// shell 横幅：肉眼可辨「确实连上了」。
const SHELL_BANNER: &[u8] = b"[mock-record] shell ready\r\nspike@mock:~$ ";

/// 通道种类：0=未定，1=PTY（交互 shell），2=exec（执行通道）。
const KIND_PTY: u8 = 1;
const KIND_EXEC: u8 = 2;
/// exec 命令里命中该标记 → **永不回复任何数据**（模拟远端命令挂起）。
const HANG_MARKER: &str = "__hang__";

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

    /// 记一条**事件**（如「开了一条通道」）——与字节记录分开，便于断言
    /// "服务端被开了几条通道"这类结构事实。
    fn record_event(&self, conn: &str, event: &str) {
        let line = format!("[{}[{}] event={}\n", self.label, conn, event);
        let path = self.path.lock().unwrap().clone();
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
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
    /// 本连接标识（用于日志关联）。
    conn: Arc<String>,
    /// 通道 → 种类标记（PTY / exec）：**shell 横幅只发给 PTY 通道**——
    /// exec 通道的 stdout 必须是命令的真实输出，混进横幅会污染取证。
    kinds: Arc<Mutex<HashMap<russh::ChannelId, Arc<AtomicU8>>>>,
}

impl MockAuth {
    /// 标记通道种类。
    fn mark_kind(&self, channel: russh::ChannelId, kind: u8) {
        if let Some(flag) = self.kinds.lock().unwrap().get(&channel) {
            flag.store(kind, Ordering::SeqCst);
        }
    }
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
        let channel_id = channel.id();
        reply.accept().await;
        let (mut read, write) = channel.split();
        let conn = self.conn.clone();
        let log = self.log.clone();
        // 通道种类标记：pty_request / exec_request 落地后才知道是哪种通道。
        let kind = Arc::new(AtomicU8::new(0));
        self.kinds.lock().unwrap().insert(channel_id, kind.clone());
        // ★ 通道计数（2026-11-04 真机取证）：**每开一条 session 通道就记一行**
        // ——"plan 档零执行"的观测面是「服务端被开了几条通道」：连接时那条
        // 交互 PTY 通道是 1 条；若 AI 执行了命令会**再多一条**（exec 通道）。
        // 只看字节不够（exec 的输出不经过 PTY，但字节也没进 PTY → 两者都是 0，
        // 分不出"没执行"与"执行了但输出没回显"）。故通道数是更硬的证据。
        log.record_event(&conn, "channel-open");
        tokio::spawn(async move {
            // 等通道种类落定再决定发不发 shell 横幅（横幅只属于 PTY 通道）。
            for _ in 0..30 {
                if kind.load(Ordering::SeqCst) != 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            if kind.load(Ordering::SeqCst) == KIND_PTY
                && write.data_bytes(SHELL_BANNER.to_vec()).await.is_err()
            {
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
        self.log.record_event(&self.conn, "pty-request");
        self.mark_kind(channel, KIND_PTY);
        session.channel_success(channel)?;
        Ok(())
    }

    /// exec 请求（`channel_exec`）——**"plan 档零执行"最直接的观测面**：
    /// 真机取证断言"服务端从未收到 exec-request"。
    ///
    /// 2026-11-04 第三步：**真执行命令**（此前只记录不执行 → 真机上永远落到
    /// 超时分支，成功路径根本验不到）：命令原文交给 `sh -c`，回传 stdout /
    /// stderr / 退出码。命令含 `__hang__` → 永不回复（验消费侧硬超时）。
    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).to_string();
        self.log.record_event(
            &self.conn,
            &format!("exec-request:{:?}", String::from_utf8_lossy(data)),
        );
        self.mark_kind(channel, KIND_EXEC);
        session.channel_success(channel)?;
        // ★ 后台执行：**不能阻塞 handler**（handler 是连接级的——阻塞它会让
        // 同一连接上的 channel_close 事件也观测不到，超时取证就废了）。
        let handle = session.handle();
        let log = self.log.clone();
        let conn = self.conn.clone();
        tokio::spawn(async move {
            if cmd.contains(HANG_MARKER) {
                // 挂起：永不回任何数据 → 客户端消费侧硬超时 → 显式关通道。
                log.record_event(&conn, "exec-hang");
                std::future::pending::<()>().await;
            }
            // tokio 未开 `process` 特性 → 用 std::process + spawn_blocking。
            let out = tokio::task::spawn_blocking(move || {
                std::process::Command::new("sh")
                    .arg("-c")
                    .arg(&cmd)
                    .output()
            })
            .await;
            match out {
                Ok(Ok(o)) => {
                    let code = o.status.code().unwrap_or(0) as u32;
                    log.record_event(&conn, &format!("exec-exit:{code}"));
                    let _ = handle.data(channel, o.stdout).await;
                    if !o.stderr.is_empty() {
                        let _ = handle.extended_data(channel, 1, o.stderr).await;
                    }
                    let _ = handle.exit_status_request(channel, code).await;
                    let _ = handle.eof(channel).await;
                    let _ = handle.close(channel).await;
                }
                Ok(Err(e)) => {
                    log.record_event(&conn, &format!("exec-error:{e}"));
                    let _ = handle
                        .extended_data(channel, 1, e.to_string().into_bytes())
                        .await;
                    let _ = handle.exit_status_request(channel, 127).await;
                    let _ = handle.eof(channel).await;
                    let _ = handle.close(channel).await;
                }
                Err(_) => {
                    log.record_event(&conn, "exec-error:join-failed");
                    let _ = handle.exit_status_request(channel, 127).await;
                    let _ = handle.eof(channel).await;
                    let _ = handle.close(channel).await;
                }
            }
        });
        Ok(())
    }

    /// **通道关闭事件**（2026-11-04 第二步取证）——消费侧硬超时命中时，
    /// 客户端会**显式**关闭 exec 通道（russh `Channel` 无 Drop 收尾——
    /// drop future = 远端 shell 悬挂）。这条事件就是「远端不留悬挂 shell」
    /// 的服务端侧证据：日志里出现 `event=channel-close` 即客户端显式收尾。
    async fn channel_close(
        &mut self,
        _channel: russh::ChannelId,
        _session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.log.record_event(&self.conn, "channel-close");
        Ok(())
    }

    /// 子系统请求（SFTP 等）。
    async fn subsystem_request(
        &mut self,
        channel: russh::ChannelId,
        name: &str,
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        self.log
            .record_event(&self.conn, &format!("subsystem-request:{name}"));
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
        let mut auth = self.auth.clone();
        auth.conn = Arc::new(format!(
            "#{}.{}",
            auth.log.label,
            CONN_SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        auth
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let port: u16 = args.next().and_then(|s| s.parse().ok()).unwrap_or(2223);
    let label = args.next().unwrap_or_else(|| "X".to_string());
    let log_path = args
        .next()
        .unwrap_or_else(|| "/tmp/mock-record.log".to_string());

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
        // 连接标识在 new_client 里按连接生成（此处为占位）。
        conn: Arc::new(format!("#{}.0", label)),
        kinds: Arc::new(Mutex::new(HashMap::new())),
    };

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    println!("[mock-record] label={label} listening on 127.0.0.1:{port}  log={log_path}");

    let mut sshd = MockSshd { auth };
    sshd.run_on_socket(config, &listener).await?;
    Ok(())
}
