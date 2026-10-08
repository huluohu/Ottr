//! ottr-mcp — Ottr 的 MCP stdio relay（Phase 4 Task 3，C1）。
//!
//! MCP 客户端（Claude Desktop 等）按 stdio transport spawn 本进程并把
//! JSON-RPC 打到我们的 stdin/stdout；本进程是**纯 std 字节管道**：
//!
//! ```text
//! Claude Desktop ──stdin──▶ ottr-mcp ──UDS──▶ Ottr App 内 MCP 引擎
//!                ◀─stdout──         ◀─UDS──   （授权矩阵 + 审批门 + SSH）
//! ```
//!
//! 【形态裁定】引擎在 App 进程内（commands/mcp.rs 模块文档）：relay 不碰
//! vault/钥匙链/SSH，二进制零依赖、行为可预期；App 未运行时连接失败即以
//! 非零码退出（stderr 说明），MCP 客户端会把 server 标记为不可用。
//!
//! 【协议纪律】字节级透传（行分隔 JSON-RPC 两向对流）；本进程**只往 stderr
//! 写日志**——stdout 是协议通道，任何杂质都会破坏客户端解析。
//!
//! 用法：`ottr-mcp --socket <path>`（路径 = Ottr 设置页 MCP 面展示的
//! app_data_dir/mcp.sock；Claude Desktop 配置生成器会带全此参数）。
//! Windows 不支持（UDS relay 待命名管道形态，见 task-3-report 偏差）。

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::exit;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_INTERVAL: Duration = Duration::from_millis(250);

fn main() {
    let socket = parse_args();
    let stream = match connect_with_retry(&socket) {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "ottr-mcp: cannot connect to the Ottr app at {}: {e}; \
                 start Ottr (and enable MCP in its settings) first",
                socket.display()
            );
            exit(1);
        }
    };
    eprintln!("ottr-mcp: connected to {}", socket.display());

    let dead = Arc::new(AtomicBool::new(false));
    let write_half = match stream.try_clone() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("ottr-mcp: socket setup failed: {e}");
            exit(1);
        }
    };

    // stdin → socket（客户端 → 引擎）。stdin 收线 = 半关 socket 写端，让引擎
    // 的回包排空后再退（客户端关闭顺序的礼貌形态）。
    let dead_in = Arc::clone(&dead);
    let stdin_thread = std::thread::spawn(move || {
        let mut reader = BufReader::new(std::io::stdin().lock());
        let mut writer = write_half;
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => break, // 客户端 stdin 关闭
                Ok(_) => {
                    if writer.write_all(line.as_bytes()).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
                Err(_) => break,
            }
        }
        let _ = writer.shutdown(std::net::Shutdown::Write);
        dead_in.store(true, Ordering::Relaxed);
    });

    // socket → stdout（引擎 → 客户端）。EOF/错误 = 引擎侧断开，进程退出。
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

/// `--socket <path>`（必填——路径由 Ottr 设置页的配置生成器给出，避免在
/// relay 里复刻各平台 app_data_dir 逻辑造成双份事实源）。
fn parse_args() -> PathBuf {
    let args: Vec<String> = std::env::args().collect();
    let mut socket = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--socket" if i + 1 < args.len() => {
                socket = Some(PathBuf::from(&args[i + 1]));
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
fn connect_with_retry(socket: &PathBuf) -> Result<UnixStream, String> {
    let deadline = std::time::Instant::now() + CONNECT_TIMEOUT;
    loop {
        match UnixStream::connect(socket) {
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
