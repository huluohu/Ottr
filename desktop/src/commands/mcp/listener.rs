//! UDS listener（std 阻塞面：连接专属线程处理整条连接，async 桥只在工具段）。
//! 纯搬家拆分（原 commands/mcp.rs 单文件）。

// 三个 trait 仅 unix conn_loop（read_line/take/write_all）消费；windows
// conn_loop 走 tokio 异步 trait（函数内局部导入）。
#[cfg(unix)]
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;

use crate::mcp::McpServer;

use super::engine::McpEngine;

// ---------------------------------------------------------------------------
// UDS listener（std 阻塞面：连接专属线程处理整条连接，async 桥只在工具段）
// ---------------------------------------------------------------------------

/// listener 运行句柄（cancel + socket 路径；线程不 join——进程退出/连接
/// 自然收尾，stop 只保证不再接受新连接并摘除 socket 文件）。
pub struct ListenerHandle {
    pub socket_path: PathBuf,
    pub cancel: CancellationToken,
}

/// 起 listener：摘陈旧 socket 文件 → bind → accept 循环线程。
/// 每条连接一个专属线程（MCP 客户端个位数连接；线程隔离让逐次审批的
/// 阻塞等待只挂起自己的连接）。
#[cfg(unix)]
pub fn spawn_listener(
    socket_path: PathBuf,
    engine: Arc<McpEngine>,
) -> std::io::Result<ListenerHandle> {
    use std::os::unix::net::UnixListener;
    let _ = std::fs::remove_file(&socket_path); // 上次异常退出的残留 bind 点
    let listener = UnixListener::bind(&socket_path)?;
    // socket 文件权限显式收紧 0600（fix 1/5 I-1）：bind 落盘权限继承进程
    // umask——launchd 可配 umask 000/002，那样 socket 变 group/world 可写，
    // 本机其他用户可连引擎。收紧失败 = fail closed（listener 不启动，错误
    // 经 mcp_set_enabled 浮出 UI），绝不带越权 socket 继续跑。
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
    }
    let cancel = CancellationToken::new();
    let handle = ListenerHandle {
        socket_path: socket_path.clone(),
        cancel: cancel.clone(),
    };
    std::thread::Builder::new()
        .name("mcp-listener".into())
        .spawn(move || accept_loop(listener, engine, cancel))?;
    Ok(handle)
}

#[cfg(unix)]
fn accept_loop(
    listener: std::os::unix::net::UnixListener,
    engine: Arc<McpEngine>,
    cancel: CancellationToken,
) {
    listener
        .set_nonblocking(true)
        .expect("set_nonblocking listener");
    while !cancel.is_cancelled() {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                if cancel.is_cancelled() {
                    break;
                }
                let engine = Arc::clone(&engine);
                let _ = std::thread::Builder::new()
                    .name("mcp-conn".into())
                    .spawn(move || conn_loop(stream, engine));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => {
                eprintln!("[mcp] accept failed: {e}");
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
    eprintln!("[mcp] listener stopped");
}

/// 单连接消息循环：行分隔 JSON-RPC；协议核逐帧分发，响应原路回写。
/// 读侧 [`crate::mcp::MAX_FRAME_BYTES`] 兜底（超长行回 parse error 后断连
/// ——帧界已失，无法续读）。
#[cfg(unix)]
fn conn_loop(stream: std::os::unix::net::UnixStream, engine: Arc<McpEngine>) {
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[mcp] conn clone failed: {e}");
            return;
        }
    };
    let mut reader = std::io::BufReader::new(stream);
    let mut server = McpServer::new();
    let mut line = String::new();
    loop {
        line.clear();
        let mut limited = (&mut reader).take((crate::mcp::MAX_FRAME_BYTES + 1) as u64);
        match limited.read_line(&mut line) {
            Ok(0) => return, // 客户端收线
            Ok(_) => {}
            Err(e) => {
                eprintln!("[mcp] conn read failed: {e}");
                return;
            }
        }
        if line.len() as u64 > crate::mcp::MAX_FRAME_BYTES as u64 {
            eprintln!("[mcp] oversized frame; dropping connection");
            return;
        }
        let response = server.handle_frame(line.as_bytes(), engine.as_ref());
        if let Some(resp) = response {
            if let Err(e) = writer
                .write_all(resp.as_bytes())
                .and_then(|_| writer.write_all(b"\n"))
            {
                eprintln!("[mcp] conn write failed: {e}");
                return;
            }
            let _ = writer.flush();
        }
    }
}

// ---------------------------------------------------------------------------
// Windows 命名管道 listener（2026-10-13 形态落地）：tokio named pipe server。
// 安全 = 管道默认 DACL（创建者 token：仅当前用户与管理员可连）——与 unix 侧
// 0600 socket 同级保证。语义镜像 unix：cancel 停止接受新连接（存量连接随
// 进程收尾）；stop 不 join 线程。
// ---------------------------------------------------------------------------

/// 单实例命名管道上限（MCP 客户端个位数；排队的 connect 请求最多 8 个）。
#[cfg(windows)]
const PIPE_INSTANCES: usize = 8;

/// 拉起 listener：创建首个管道实例 → accept 循环线程（独立 current_thread
/// runtime——连接处理 spawn 回同一 runtime；逐次审批的阻塞等待经
/// spawn_blocking 下放阻塞池，不卡 accept）。
#[cfg(windows)]
pub fn spawn_listener(
    pipe_path: PathBuf,
    engine: Arc<McpEngine>,
) -> std::io::Result<ListenerHandle> {
    use tokio::runtime::Builder;

    let cancel = CancellationToken::new();
    let handle = ListenerHandle {
        socket_path: pipe_path.clone(),
        cancel: cancel.clone(),
    };
    std::thread::Builder::new()
        .name("mcp-listener".into())
        .spawn(move || {
            let rt = match Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    eprintln!("[mcp] pipe runtime build failed: {e}");
                    return;
                }
            };
            rt.block_on(windows_accept_loop(pipe_path, engine, cancel));
        })?;
    Ok(handle)
}

/// accept 循环：实例建好 → 等客户端连上 → 立刻补建下一实例 → 连接交给
/// 独立任务。create 失败 = 引擎侧不可恢复（管道名被占等），记日志退避。
#[cfg(windows)]
async fn windows_accept_loop(
    pipe_path: PathBuf,
    engine: Arc<McpEngine>,
    cancel: CancellationToken,
) {
    use tokio::net::windows::named_pipe::ServerOptions;

    let pipe_name = pipe_path
        .to_str()
        .expect("pipe name is utf-8 (\\\\.\\pipe\\...)")
        .to_owned();
    let mut server = match ServerOptions::new()
        .first_pipe_instance(true)
        .max_instances(PIPE_INSTANCES)
        .create(&pipe_name)
    {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[mcp] create pipe {pipe_name} failed: {e}");
            return;
        }
    };
    loop {
        tokio::select! {
            _ = cancel.cancelled() => break,
            connected = server.connect() => {
                if let Err(e) = connected {
                    if e.kind() == std::io::ErrorKind::WouldBlock {
                        // 无客户端：短暂让出后再 poll 同一实例（cancel 可打断）
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        continue;
                    }
                    eprintln!("[mcp] pipe connect failed: {e}");
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                if cancel.is_cancelled() {
                    break;
                }
                let conn = server;
                server = match ServerOptions::new().max_instances(PIPE_INSTANCES).create(&pipe_name) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("[mcp] re-create pipe instance failed: {e}");
                        return;
                    }
                };
                let engine = Arc::clone(&engine);
                tokio::spawn(async move {
                    windows_conn_loop(conn, engine).await;
                    eprintln!("[mcp] pipe conn closed");
                });
            }
        }
    }
    eprintln!("[mcp] listener stopped");
}

/// 单连接消息循环（async 形态）：裸 read + 手工分行（take/BufReader 分层
/// 在该平台曾遮挂数据断点——直接裸读，帧界手工切，逻辑可见）。
#[cfg(windows)]
async fn windows_conn_loop(
    mut conn: tokio::net::windows::named_pipe::NamedPipeServer,
    engine: Arc<McpEngine>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut buf = vec![0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    let mut server = McpServer::new();
    loop {
        let n = match conn.read(&mut buf).await {
            Ok(0) => return, // 客户端收线
            Ok(n) => n,
            Err(e) => {
                eprintln!("[mcp] conn read failed: {e}");
                return;
            }
        };
        pending.extend_from_slice(&buf[..n]);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = pending.drain(..=pos).collect();
            if line_bytes.len() as u64 > crate::mcp::MAX_FRAME_BYTES as u64 {
                eprintln!("[mcp] oversized frame; dropping connection");
                return;
            }
            let frame = String::from_utf8_lossy(&line_bytes).into_owned();
            let eng = Arc::clone(&engine);
            // 协议核状态机随帧进出阻塞池（闭包归还 server，下一帧继续用）
            let (server_back, response) = match tokio::task::spawn_blocking(move || {
                let resp = server.handle_frame(frame.as_bytes(), eng.as_ref());
                (server, resp)
            })
            .await
            {
                Ok(pair) => pair,
                Err(e) => {
                    eprintln!("[mcp] frame task join failed: {e}");
                    return;
                }
            };
            server = server_back;
            if let Some(resp) = response {
                let write = async {
                    conn.write_all(resp.as_bytes()).await?;
                    conn.write_all(b"\n").await?;
                    conn.flush().await
                };
                if let Err(e) = write.await {
                    eprintln!("[mcp] conn write failed: {e}");
                    return;
                }
            }
        }
    }
}
