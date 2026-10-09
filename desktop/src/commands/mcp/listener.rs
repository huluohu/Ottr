//! UDS listener（std 阻塞面：连接专属线程处理整条连接，async 桥只在工具段）。
//! 纯搬家拆分（原 commands/mcp.rs 单文件）。

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
