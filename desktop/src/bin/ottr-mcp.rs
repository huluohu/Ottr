//! ottr-mcp — Ottr 的 MCP stdio relay（Phase 4 Task 3，C1）。
//!
//! MCP 客户端（Claude Desktop 等）按 stdio transport spawn 本进程并把
//! JSON-RPC 打到我们的 stdin/stdout；本进程是**纯字节管道**：
//!
//! ```text
//! Claude Desktop ──stdin──▶ ottr-mcp ──unix:UDS / windows:named pipe──▶ Ottr App 内 MCP 引擎
//!                ◀─stdout──              ◀──────────────              （授权矩阵 + 审批门 + SSH）
//! ```
//!
//! 【形态裁定】引擎在 App 进程内（commands/mcp.rs 模块文档）：relay 不碰
//! vault/钥匙链/SSH，行为可预期；App 未运行时连接失败即以非零码退出
//! （stderr 说明），MCP 客户端会把 server 标记为不可用。
//!
//! 【协议纪律】字节级透传（行分隔 JSON-RPC 两向对流）；本进程**只往 stderr
//! 写日志**——stdout 是协议通道，任何杂质都会破坏客户端解析。
//!
//! 【传输面】unix = UDS（`--socket <path>`，std 原生）；windows = 命名管道
//! （`--pipe <name>`，windows-sys 同步 FFI 客户端——不引运行时依赖，维持
//! 薄管道形态；2026-10-13 命名管道形态落地）。半关（stdin 收线后 Shutdown
//! 写端让引擎排空回包）是 unix 专属礼貌形态；管道无半关，客户端退出时
//! 引擎侧经写失败感知，收尾语义不受影响。
//!
//! 用法：路径/管道名由 Ottr 设置页的配置生成器给出，避免在 relay 里复刻
//! 各平台 app_data_dir 逻辑造成双份事实源。

use std::io::{BufRead, BufReader, Read, Write};
use std::process::exit;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_INTERVAL: Duration = Duration::from_millis(250);

/// 双向传输抽象：unix UDS 与 windows 命名管道的公共面。半关默认 no-op
/// （管道无对应概念，见文件头【传输面】）。
trait Transport: Read + Write {
    fn try_clone(&self) -> std::io::Result<Self>
    where
        Self: Sized;
    fn shutdown_write(&self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(unix)]
fn main() {
    let endpoint = parse_args();
    let stream = match connect_with_retry(&endpoint) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "ottr-mcp: cannot connect to the Ottr app at {}: {e}; \
                 start Ottr (and enable MCP in its settings) first",
                endpoint.display()
            );
            exit(1);
        }
    };
    eprintln!("ottr-mcp: connected to {}", endpoint.display());
    pump(stream);
}

#[cfg(unix)]
impl Transport for std::os::unix::net::UnixStream {
    fn try_clone(&self) -> std::io::Result<Self> {
        std::os::unix::net::UnixStream::try_clone(self)
    }
    fn shutdown_write(&self) -> std::io::Result<()> {
        std::os::unix::net::UnixStream::shutdown(self, std::net::Shutdown::Write)
    }
}

#[cfg(windows)]
fn main() {
    eprintln!("ottr-mcp: starting");
    let endpoint = parse_args();
    // 两端同构 tokio overlapped：引擎侧本就是 tokio named pipe；客户端若用
    // 同步 FFI 句柄，与 overlapped 服务端组合实测写挂死（89B 写入不返回，
    // 2026-10-13 CI 诊断）——客户端同用 tokio = 与 tokio 文档模式一致。
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("relay runtime");
    let pipe = match rt.block_on(connect_with_retry(&endpoint)) {
        Ok(p) => p,
        Err(e) => {
            eprintln!(
                "ottr-mcp: cannot connect to the Ottr app at {}: {e}; \
                 start Ottr (and enable MCP in its settings) first",
                endpoint.display()
            );
            exit(1);
        }
    };
    eprintln!("ottr-mcp: connected to {}", endpoint.display());
    rt.block_on(pump_async(pipe));
}

/// 带重试的连接（App 正在启动时首个管道实例可能还没建好；总窗 10s）。
#[cfg(windows)]
async fn connect_with_retry(
    pipe: &std::path::PathBuf,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, String> {
    use tokio::net::windows::named_pipe::ClientOptions;

    let name = pipe.to_string_lossy().into_owned();
    let deadline = std::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        match ClientOptions::new().open(&name) {
            Ok(p) => return Ok(p),
            Err(e) => {
                // ERROR_PIPE_BUSY（229/231 语义：无空闲实例）→ 稍后重试；
                // 总窗耗尽报最后一条错误（现场最有诊断价值）。
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "{e} (retry window {}s exhausted)",
                        CONNECT_TIMEOUT.as_secs()
                    ));
                }
            }
        }
        tokio::time::sleep(RETRY_INTERVAL).await;
    }
}

/// 异步双拷贝泵：stdin → 管道写半，管道读半 → stdout。任一方向收线即整体
/// 退出（管道无半关；unix 的 Shutdown 写端礼貌形态不适用于本端，见文件头）。
#[cfg(windows)]
async fn pump_async(pipe: tokio::net::windows::named_pipe::NamedPipeClient) {
    use tokio::io::{AsyncWriteExt, Stdin, Stdout};

    let (mut pipe_read, mut pipe_write) = tokio::io::split(pipe);
    let mut stdin = Stdin::default();
    let mut stdout = Stdout::default();

    let up = async move {
        let mut buf = vec![0u8; 8192];
        loop {
            let n = tokio::io::AsyncReadExt::read(&mut stdin, &mut buf).await?;
            if n == 0 {
                break; // 客户端 stdin 关闭
            }
            pipe_write.write_all(&buf[..n]).await?;
            pipe_write.flush().await?;
        }
        Ok::<(), std::io::Error>(())
    };
    let down = async move {
        let mut buf = vec![0u8; 8192];
        loop {
            let n = tokio::io::AsyncReadExt::read(&mut pipe_read, &mut buf).await?;
            if n == 0 {
                break; // 引擎侧断开
            }
            stdout.write_all(&buf[..n]).await?;
            stdout.flush().await?;
        }
        Ok::<(), std::io::Error>(())
    };
    tokio::select! {
        r = up => { if let Err(e) = r { eprintln!("ottr-mcp: up pump failed: {e}"); } }
        r = down => { if let Err(e) = r { eprintln!("ottr-mcp: down pump failed: {e}"); } }
    }
    eprintln!("ottr-mcp: connection closed");
}

// stdin → 传输（客户端 → 引擎）。stdin 收线 = 半关写端，让引擎的回包排空
// 后再退（客户端关闭顺序的礼貌形态；管道侧 shutdown_write 为 no-op）。
fn pump<T: Transport + Send + 'static>(stream: T) {
    let dead = Arc::new(AtomicBool::new(false));
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("ottr-mcp: transport setup failed: {e}");
            exit(1);
        }
    };

    let dead_in = Arc::clone(&dead);
    let stdin_thread = std::thread::spawn(move || {
        let mut reader = BufReader::new(std::io::stdin().lock());
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // 客户端 stdin 关闭
                Ok(_) => {
                    eprintln!("[relay] stdin {}B, forwarding", line.len());
                    if writer.write_all(line.as_bytes()).is_err() {
                        eprintln!("[relay] pipe write failed");
                        break;
                    }
                    let _ = writer.flush();
                    eprintln!("[relay] pipe write ok {}B", line.len());
                }
                Err(_) => break,
            }
        }
        let _ = writer.shutdown_write();
        dead_in.store(true, Ordering::Relaxed);
    });

    // 传输 → stdout（引擎 → 客户端）。EOF/错误 = 引擎侧断开，进程退出。
    let dead_out = Arc::clone(&dead);
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {
                let mut out = std::io::stdout().lock();
                if out.write_all(line.as_bytes()).is_err() || out.flush().is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
        if dead_out.load(Ordering::Relaxed) && line.is_empty() {
            break;
        }
    }
    let _ = stdin_thread.join();
    eprintln!("ottr-mcp: connection closed");
}

// ---------------------------------------------------------------------------
// unix：UDS（std 原生）
// ---------------------------------------------------------------------------

#[cfg(unix)]
fn parse_args() -> std::path::PathBuf {
    let args: Vec<String> = std::env::args().collect();
    let mut socket = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--socket" if i + 1 < args.len() => {
                socket = Some(std::path::PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--help" | "-h" => {
                println!("usage: ottr-mcp --socket <path-to-mcp.sock>");
                exit(0);
            }
            other => {
                eprintln!("ottr-mcp: unexpected argument {other:?}");
                println!("usage: ottr-mcp --socket <path-to-mcp.sock>");
                exit(2);
            }
        }
    }
    match socket {
        Some(p) => p,
        None => {
            eprintln!("ottr-mcp: --socket <path> is required");
            println!("usage: ottr-mcp --socket <path-to-mcp.sock>");
            exit(2);
        }
    }
}

/// 带重试的连接（App 正在启动时 listener 可能还没 bind；总窗 10s）。
#[cfg(unix)]
fn connect_with_retry(
    socket: &std::path::PathBuf,
) -> Result<std::os::unix::net::UnixStream, String> {
    let deadline = std::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        match std::os::unix::net::UnixStream::connect(socket) {
            Ok(s) => return Ok(s),
            Err(e) => {
                // 只报最后一条错误（重试窗耗尽时刻的现场最有诊断价值）。
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "{e} (retry window {}s exhausted)",
                        CONNECT_TIMEOUT.as_secs()
                    ));
                }
            }
        }
        std::thread::sleep(RETRY_INTERVAL);
    }
}

/// `--pipe <name>`（必填——管道名由 Ottr 设置页的配置生成器给出）。
#[cfg(windows)]
fn parse_args() -> std::path::PathBuf {
    let args: Vec<String> = std::env::args().collect();
    let mut pipe = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--pipe" if i + 1 < args.len() => {
                pipe = Some(std::path::PathBuf::from(&args[i + 1]));
                i += 2;
            }
            "--help" | "-h" => {
                println!("usage: ottr-mcp --pipe <\\\\.\\pipe\\name>");
                exit(0);
            }
            other => {
                eprintln!("ottr-mcp: unexpected argument {other:?}");
                println!("usage: ottr-mcp --pipe <\\\\.\\pipe\\name>");
                exit(2);
            }
        }
    }
    match pipe {
        Some(p) => p,
        None => {
            eprintln!("ottr-mcp: --pipe <name> is required");
            println!("usage: ottr-mcp --pipe <\\\\.\\pipe\\name>");
            exit(2);
        }
    }
}

/// 带重试的连接（App 正在启动时首个管道实例可能还没建好；总窗 10s；
/// ERROR_PIPE_BUSY 的实例内等待已在 PipeStream::connect 内部处理）。
#[cfg(windows)]
fn connect_with_retry(pipe: &std::path::PathBuf) -> Result<pipe::PipeStream, String> {
    let deadline = std::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        match pipe::PipeStream::connect(&pipe.to_string_lossy()) {
            Ok(s) => return Ok(s),
            Err(e) => {
                if std::time::Instant::now() >= deadline {
                    return Err(format!(
                        "{e} (retry window {}s exhausted)",
                        CONNECT_TIMEOUT.as_secs()
                    ));
                }
            }
        }
        std::thread::sleep(RETRY_INTERVAL);
    }
}
