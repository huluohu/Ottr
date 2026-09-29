//! ottr-bench（Task 13 / Spike #10）：进程内内存基线测量。
//!
//! 两个模式（RSS 一律由外层脚本 `scripts/bench-memory.sh` 以 `ps -o rss=` 采样，
//! 本二进制只负责打印自身 pid 与保持负载；macOS 无 /proc/self/status，
//! mach API 需要额外 unsafe，外层 `ps` 是两端通行的最简读法）：
//!
//! - `idle [hold_secs]`：tokio runtime 空转（零连接）——「空闲单进程」对照物；
//! - `sessions [N] [hold_secs]`：并发 N 条夹具会话（默认 5，各开 PTY + 排空任务，
//!   会话 0 额外跑一条 SFTP 循环：`download_parallel` 分块下 big100，每轮清
//!   journal/本地文件后重来直到 hold 到期）——「5 会话 + 传输中」负载。
//!
//! 【口径声明】这里测的是 **Rust 侧进程内基线**（russh + tokio + SFTP 缓冲），
//! 不含 webview/前端。spec §9 #10 的红线（空闲 <150MB / 5 会话 <250MB）是
//! **完整 App 口径**——完整数字由 `docs/runbooks/spike-win-linux.md` 在真实
//! Win/Linux 机器上人工补，两者在报告中分开呈现，不许混判。
//!
//! 主机密钥：与 src-tauri 相同的 pin 语义（解析 `fixtures/known_hosts` 首条记录
//! 为 SHA256 指纹，不匹配即拒），不允许静默跳过校验。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use ottr_ssh::AuthMethod;
use ottr_ssh::sftp::download_parallel;
use russh::ChannelMsg;

const FIXTURE: (&str, u16, &str, &str) = ("127.0.0.1", 2222, "spike", "spike-pass");
const REMOTE_BIG: &str = "/tmp/big100";
const SFTP_CHUNKS: usize = 4; // download_parallel 并发 worker（Task 8 验证过的默认）

fn main() {
    // 第一行：pid（外层脚本采样目标）；立即 flush 防管道缓冲延迟采样启动。
    println!("PID={}", std::process::id());
    let mut args = std::env::args().skip(1);
    let mode = args.next().unwrap_or_else(|| usage());
    // sessions 模式：`sessions [N] [hold_secs]`（与 usage/scripts 一致）；idle 只有 hold。
    let (sessions, hold): (usize, u64) = match mode.as_str() {
        "sessions" => {
            let n = args
                .next()
                .map(|s| s.parse().unwrap_or_else(|_| usage()))
                .unwrap_or(5);
            let h = args
                .next()
                .map(|s| s.parse().unwrap_or_else(|_| usage()))
                .unwrap_or(60);
            (n, h)
        }
        "idle" => {
            let h = args
                .next()
                .map(|s| s.parse().unwrap_or_else(|_| usage()))
                .unwrap_or(5);
            (0, h)
        }
        _ => usage(),
    };

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let result = runtime.block_on(run(&mode, sessions, hold));
    // RESULT 行给外层脚本汇总（pid 行之后的第一条结构化输出）。
    println!("RESULT {result}");
}

fn usage() -> ! {
    eprintln!("usage: ottr-bench idle [hold_secs=5] | ottr-bench sessions [N=5] [hold_secs=60]");
    std::process::exit(2);
}

async fn run(mode: &str, sessions: usize, hold: u64) -> String {
    match mode {
        "idle" => {
            // 纯 runtime 空转：对照物（进程装载 + tokio worker 线程，零连接）。
            tokio::time::sleep(Duration::from_secs(hold)).await;
            format!("mode=idle hold={hold}s")
        }
        "sessions" => run_sessions(sessions, hold).await,
        other => {
            eprintln!("unknown mode: {other}");
            std::process::exit(2);
        }
    }
}

async fn run_sessions(n: usize, hold: u64) -> String {
    let deadline = Instant::now() + Duration::from_secs(hold);
    let mut handles = Vec::with_capacity(n);
    for i in 0..n {
        handles.push(tokio::spawn(session_worker(i, deadline)));
    }
    let mut sftp_iters = 0u64;
    let mut sftp_bytes = 0u64;
    let mut drain_bytes = 0u64;
    let mut errors = 0usize;
    for h in handles {
        match h.await {
            Ok(Ok((iters, bytes, drained))) => {
                sftp_iters += iters;
                sftp_bytes += bytes;
                drain_bytes += drained;
            }
            Ok(Err(e)) => {
                errors += 1;
                eprintln!("[bench] session worker failed: {e}");
            }
            Err(e) => {
                errors += 1;
                eprintln!("[bench] join failed: {e}");
            }
        }
    }
    format!(
        "mode=sessions sessions={n} hold={hold}s sftp_iterations={sftp_iters} sftp_bytes={sftp_bytes} drain_bytes={drain_bytes} errors={errors}"
    )
}

/// 一条夹具会话：PTY + 输出排空；会话 0 额外跑 SFTP 循环。
/// 返回 (sftp_iterations, sftp_bytes, pty_drain_bytes)。
async fn session_worker(index: usize, deadline: Instant) -> ottr_ssh::Result<(u64, u64, u64)> {
    let (host, port, user, pass) = FIXTURE;
    let expected_fp = pinned_fingerprint();
    let session = tokio::time::timeout(
        Duration::from_secs(15),
        ottr_ssh::connect(
            host,
            port,
            user,
            AuthMethod::Password(pass.to_string()),
            Arc::new(move |fp: &str| fp == expected_fp),
        ),
    )
    .await
    .map_err(|_| ottr_ssh::Error::Protocol {
        message: "connect timed out after 15s".into(),
        source: None,
    })??;
    eprintln!("[bench] session {index} connected (fp pinned)");

    // PTY + 周期性输出：与 src-tauri attach_session 同序（open_pty →
    // request_shell(true) → make_writer 写入），每步限时——连接类操作不允许
    // 无限等待（phase0-report §5 的 attach 停滞教训）。shell 起来后 exec 成
    // 每 5s 打一行 date 的循环，输出由排空任务持续消费。
    eprintln!("[bench] session {index} opening pty");
    let mut channel = tokio::time::timeout(Duration::from_secs(10), session.open_pty(120, 40))
        .await
        .map_err(|_| ottr_ssh::Error::Protocol {
            message: "open_pty timed out after 10s".into(),
            source: None,
        })??;
    eprintln!("[bench] session {index} pty open, requesting shell");
    tokio::time::timeout(Duration::from_secs(10), channel.request_shell(true))
        .await
        .map_err(|_| ottr_ssh::Error::Protocol {
            message: "request_shell timed out after 10s".into(),
            source: None,
        })?
        .map_err(|e| ottr_ssh::Error::Protocol {
            message: format!("request_shell: {e}"),
            source: None,
        })?;
    eprintln!("[bench] session {index} shell running, sending cmd");
    {
        use tokio::io::AsyncWriteExt;
        let mut writer = channel.make_writer();
        tokio::time::timeout(
            Duration::from_secs(10),
            writer.write_all(b"exec sh -c 'while :; do date +%s; sleep 5; done'\r\n"),
        )
        .await
        .map_err(|_| ottr_ssh::Error::Protocol {
            message: "pty write timed out after 10s".into(),
            source: None,
        })?
        .map_err(|e| ottr_ssh::Error::Protocol {
            message: format!("pty write: {e}"),
            source: None,
        })?;
    }
    eprintln!("[bench] session {index} cmd sent");
    let drain = tokio::spawn(async move {
        let mut drain_bytes = 0u64;
        while let Some(msg) = channel.wait().await {
            if let ChannelMsg::ExtendedData { data, .. } | ChannelMsg::Data { data } = msg {
                drain_bytes += data.len() as u64;
            }
        }
        drain_bytes
    });

    // 会话 0：SFTP 循环分块传 big100，直到 hold 到期。
    let mut sftp_iters = 0u64;
    let mut sftp_bytes = 0u64;
    if index == 0 {
        let local = PathBuf::from("/tmp/ottr-bench-dl.bin");
        let journal = PathBuf::from("/tmp/ottr-bench-dl.journal");
        eprintln!("[bench] sftp loop enter");
        while Instant::now() < deadline {
            let _ = std::fs::remove_file(&local);
            let _ = std::fs::remove_file(&journal);
            eprintln!("[bench] sftp round {} begin", sftp_iters + 1);
            match download_parallel(&session, REMOTE_BIG, &local, SFTP_CHUNKS, &journal).await {
                Ok(stats) => {
                    sftp_iters += 1;
                    sftp_bytes += stats.total_bytes;
                    eprintln!("[bench] sftp round done: {}B", stats.total_bytes);
                }
                Err(e) => eprintln!("[bench] sftp round failed: {e}"),
            }
        }
        eprintln!("[bench] sftp loop exit");
    }

    // 收尾：断连（russh 显式 disconnect —— Handle::drop 只打日志不关连接），
    // 排空任务限时回收：实测 channel.wait() 在 disconnect 后**不保证**返回 None
    // （russh 会话任务关停不逐一 close 通道，Task 7 forward 循环因此用 Notify
    // 显式取消，同款结论），此处只影响收尾不影响测量，3s 不退即放弃。
    let _ = session.disconnect().await;
    eprintln!("[bench] session {index} disconnected");
    let drain_bytes = match tokio::time::timeout(Duration::from_secs(3), drain).await {
        Ok(v) => v.unwrap_or(0),
        Err(_) => {
            eprintln!("[bench] session {index} drain not ending after disconnect (abandoned)");
            0
        }
    };
    Ok((sftp_iters, sftp_bytes, drain_bytes))
}

/// 与 src-tauri 同款 pin：解析仓库 `fixtures/known_hosts` 首条记录。
fn pinned_fingerprint() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/known_hosts");
    if let Ok(content) = std::fs::read_to_string(&path)
        && let Some(fp) = known_hosts_fingerprint(&content)
    {
        return fp;
    }
    // 夹具文件缺失/不可解析时兜底为已 pin 值（与 src-tauri 常量一致）。
    "SHA256:nLaxv/1hXxccQNB7JauQUi63z0YmST4P3AvViyoNCIQ".to_string()
}

/// known_hosts 中 `[host]:port` 记录 → `SHA256:<unpadded-std-b64(sha256(key_blob))>`。
/// 逻辑与 src-tauri lib.rs `known_hosts_fingerprint` / examples/real_fixture.rs
/// 一致（bench 独立编译，不引 app 层）。
fn known_hosts_fingerprint(content: &str) -> Option<String> {
    use sha2::Digest;
    let marker = format!("[{}]:{}", FIXTURE.0, FIXTURE.1);
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let b64 = match (parts.next(), parts.next(), parts.next()) {
            (Some(host), Some(_ktype), Some(b64)) if parts.next().is_none() && host == marker => {
                b64
            }
            _ => continue,
        };
        if let Ok(blob) = B64.decode(b64) {
            let digest = sha2::Sha256::digest(&blob);
            return Some(format!(
                "SHA256:{}",
                B64.encode(digest).trim_end_matches('=')
            ));
        }
    }
    None
}
