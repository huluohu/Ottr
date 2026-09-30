//! Task 9（A9 收口）：编码自适应的真夹具三段验证——**走正式转发路径**
//! [`ottr_lib::forward_pty_loop`]（合批 4ms 窗口 → 会话 Decoder 解码 → IPC 帧），
//! 而非 Phase 0 gbk_spike 的解码器级重放。切换动作与 `set_session_encoding`
//! 命令体一致（同一 Arc<Mutex<StreamDecoder>> 上 set_encoding；命令体本身
//! 已有单测：encoding_from_str 表 + flush_batch 解码断言）。
//!
//! 连接容器化 sshd 夹具（scripts/spike-sshd.sh，127.0.0.1:2222）→
//! open_pty + request_shell → 每段跑 `gbk-echo`（GBK 裸字节 17B）→
//! 经真转发循环解出的文本断言三段切换语义。另跑 Rust 侧 LANG 探测的
//! 同款逻辑（SshSession::exec("echo $LANG") → detect_hint）。
//!
//! 场景（`cargo run -p ottr --example encoding_fixture`）：
//! 1. 默认 UTF-8：夹具 GBK 字节 → 替换符乱码（ASCII 段保真）；
//! 2. 切 GBK：同批字节 → 「中文测试 GBK 输出」（即切即生效，下个 chunk 起）；
//! 3. 切回 UTF-8：再乱码（与段 1 一致）。
//!
//! 断言不达标进程退出码非 0；stdout 证据供报告原样抄录。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::Notify;

use ottr_lib::{forward_pty_loop, SessionCloseReason, SessionCounters, TextTail};
use ottr_term::encoding::{Encoding, StreamDecoder};
use ottr_term::Decoder;

use ottr_ssh::{connect, AuthMethod, HostKeyPolicy};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/known_hosts");

/// 输出静默多久视为命令已收尾。
const IDLE: Duration = Duration::from_millis(500);
/// 单命令捕获总上限。
const CMD_MAX: Duration = Duration::from_secs(8);

/// 夹具 `gbk-echo` 应解出的文本。
const EXPECTED_TEXT: &str = "中文测试 GBK 输出";
/// 输出窗定界标记（ASCII，任何会话编码下解码后仍可定位）。
const MARKER: &str = "===OTTRGBK===";

/// 供报告原样抄录的转义：U+FFFD 显式标注，其余控制字符 \xNN。
fn escaped(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        match c {
            '\u{FFFD}' => out.push_str("<U+FFFD>"),
            '\r' => out.push_str("\\r"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\x{:02x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 从 known_hosts 提取 `[127.0.0.1]:2222` 指纹 pin（同 Phase 0 gbk_spike）。
fn pinned_host_key_policy() -> (HostKeyPolicy, String) {
    use russh::keys::{parse_public_key_base64, HashAlg, PublicKey};
    let content =
        std::fs::read_to_string(KNOWN_HOSTS).unwrap_or_else(|e| panic!("read {KNOWN_HOSTS}: {e}"));
    let marker = format!("[{HOST}]:{PORT}");
    let line = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .unwrap_or_else(|| panic!("known_hosts has no entry for {marker}"));
    let b64 = line
        .split_whitespace()
        .nth(2)
        .unwrap_or_else(|| panic!("malformed known_hosts line: {line}"));
    let pinned: PublicKey = parse_public_key_base64(b64).expect("parse pinned host key");
    let pinned_fp = pinned.fingerprint(HashAlg::Sha256).to_string();
    let pinned_fp_for_cb = pinned_fp.clone();
    (
        Arc::new(move |fingerprint: &str| fingerprint == pinned_fp_for_cb) as HostKeyPolicy,
        pinned_fp,
    )
}

/// 解码输出捕获窗 + PTY 写端。
struct Stage {
    decoded: Arc<Mutex<String>>,
    writer: tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
}

impl Stage {
    /// 发一行命令并等解码输出静默（连续 IDLE 无增长），返回本窗新增文本。
    async fn run_line(&self, line: &str) -> Result<String, String> {
        use tokio::io::AsyncWriteExt;
        let before = self.decoded.lock().unwrap().len();
        let mut w = self.writer.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        w.write_all(b"\r")
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        drop(w);
        let deadline = tokio::time::Instant::now() + CMD_MAX;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("timeout ({CMD_MAX:?}) waiting output: {line:?}"));
            }
            tokio::time::sleep(IDLE).await;
            let len = self.decoded.lock().unwrap().len();
            if len == before {
                continue; // 本窗尚无输出，继续等
            }
            tokio::time::sleep(IDLE).await;
            let len2 = self.decoded.lock().unwrap().len();
            if len2 == len {
                let buf = self.decoded.lock().unwrap();
                return Ok(buf[before..].to_string());
            }
        }
    }
}

/// 从解码文本窗提取 marker 之间夹的 gbk-echo 输出体（取最后两次出现——
/// 回显的命令行本身含 marker，最后一对才是真输出）。
fn extract_payload(window: &str) -> Result<String, String> {
    let mut positions = vec![];
    let mut from = 0;
    while let Some(pos) = window[from..].find(MARKER) {
        positions.push(from + pos);
        from = from + pos + MARKER.len();
    }
    if positions.len() < 2 {
        return Err(format!(
            "need 2 marker occurrences, got {}: {:?}",
            positions.len(),
            escaped(window)
        ));
    }
    let (prev, last) = (positions[positions.len() - 2], positions[positions.len() - 1]);
    Ok(window[prev + MARKER.len()..last]
        .trim_matches(|c| c == '\r' || c == '\n')
        .to_string())
}

async fn run() -> Result<String, String> {
    let (policy, pinned_fp) = pinned_host_key_policy();
    eprintln!("[fixture] connect spike@127.0.0.1:2222 (pinned {pinned_fp})");
    let session = connect(HOST, PORT, USER, AuthMethod::Password(PASSWORD.into()), policy)
        .await
        .map_err(|e| format!("connect: {e}"))?;
    let mut channel = session
        .open_pty(120, 40)
        .await
        .map_err(|e| format!("open_pty: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("request_shell: {e}"))?;
    eprintln!("[fixture] pty 120x40 + shell running");

    // 正式转发路径：真合批参数（4ms 窗口/16ms 节流/256KB 上限）+ 会话 Decoder，
    // IPC 帧捕获为解码文本（正式面前端 xterm 同样直接消费这些帧）。
    let decoded: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let captured = Arc::clone(&decoded);
    let on_data = Channel::new(move |body: InvokeResponseBody| {
        if let InvokeResponseBody::Raw(bytes) = body {
            captured
                .lock()
                .unwrap()
                .push_str(&String::from_utf8_lossy(&bytes));
        }
        Ok(())
    });
    let counters = SessionCounters::default();
    // 段 1 初值 = 默认 UTF-8（= attach 无 encoding_override 时的兜底）
    let decoder = Arc::new(Mutex::new(StreamDecoder::new(Encoding::Utf8)));
    let decoder_handle = Arc::clone(&decoder);
    let cancel = Arc::new(Notify::new());
    let cancel_handle = Arc::clone(&cancel);
    let writer = tokio::sync::Mutex::new(
        Box::new(channel.make_writer()) as Box<dyn tokio::io::AsyncWrite + Unpin + Send>
    );
    let forward = tauri::async_runtime::spawn(async move {
        let text_tail = TextTail::new();
        forward_pty_loop(&mut channel, &on_data, &counters, &decoder, &text_tail, "fixture", &cancel_handle).await
    });
    let stage = Stage { decoded, writer };

    // 首窗吃掉 banner/提示符
    stage.run_line("true").await?;

    // --- 段 1：默认 UTF-8 → 乱码（替换符），ASCII 段保真 ---------------------
    let win1 = stage
        .run_line(&format!("echo {MARKER}; gbk-echo; echo {MARKER}"))
        .await?;
    let seg1 = extract_payload(&win1)?;
    println!("[seg1] encoding=UTF-8 (default) dec=\"{}\"", escaped(&seg1));
    if !seg1.contains('\u{FFFD}') {
        return Err(format!(
            "seg1 (UTF-8 default) has no U+FFFD: {:?}",
            escaped(&seg1)
        ));
    }
    if !seg1.contains(" GBK ") {
        return Err("seg1: ASCII run ' GBK ' must survive".into());
    }

    // --- 段 2：切 GBK（= set_session_encoding 的 Decoder 侧动作）→ 原文 -------
    let flushed = decoder_handle.lock().unwrap().set_encoding(Encoding::Gbk);
    println!("[switch->GBK] residual-settled text: {:?}", escaped(&flushed));
    let win2 = stage
        .run_line(&format!("echo {MARKER}; gbk-echo; echo {MARKER}"))
        .await?;
    let seg2 = extract_payload(&win2)?;
    println!("[seg2] encoding=GBK dec=\"{}\"", escaped(&seg2));
    if seg2 != EXPECTED_TEXT {
        return Err(format!("seg2 (GBK) = {seg2:?}, expected {EXPECTED_TEXT:?}"));
    }

    // --- 段 3：切回 UTF-8 → 与段 1 一致的乱码 --------------------------------
    let flushed = decoder_handle.lock().unwrap().set_encoding(Encoding::Utf8);
    println!("[switch->UTF-8] residual-settled text: {:?}", escaped(&flushed));
    let win3 = stage
        .run_line(&format!("echo {MARKER}; gbk-echo; echo {MARKER}"))
        .await?;
    let seg3 = extract_payload(&win3)?;
    println!("[seg3] encoding=UTF-8 dec=\"{}\"", escaped(&seg3));
    if seg3 != seg1 {
        return Err("seg3 != seg1 (switch back must reproduce mojibake)".into());
    }

    // --- LANG 探测（Rust 侧 attach 后的 detect_hint 同款逻辑真机跑一遍）------
    let out = session
        .exec("echo $LANG")
        .await
        .map_err(|e| format!("exec probe: {e}"))?;
    let locale = String::from_utf8_lossy(&out.stdout).to_string();
    let hint = Decoder::detect_hint(&locale);
    println!(
        "[lang-probe] echo $LANG = {:?} -> detect_hint = {} -> hint event {}",
        locale.trim(),
        hint.name(),
        if hint == Encoding::Gbk {
            "ottr://encoding-hint(gbk)"
        } else {
            "suppressed (UTF-8 fallback)"
        }
    );

    // 收尾：取消转发循环（= drop_session 的取消语义）
    cancel.notify_one();
    let reason: SessionCloseReason = forward
        .await
        .map_err(|e| format!("forward loop join: {e}"))?;
    println!("[teardown] forward loop exited with {reason:?}");
    let _ = session.disconnect().await;

    Ok(format!(
        "seg1(UTF-8)=\"{}\" -> seg2(GBK)=\"{EXPECTED_TEXT}\" -> seg3(UTF-8)=\"{}\"；真转发路径三段切换语义全绿",
        escaped(&seg1),
        escaped(&seg3)
    ))
}

fn main() {
    let result = tauri::async_runtime::block_on(run());
    match result {
        Ok(summary) => eprintln!("[PASS] encoding_fixture: {summary}"),
        Err(err) => {
            eprintln!("[FAIL] encoding_fixture: {err}");
            std::process::exit(1);
        }
    }
}
