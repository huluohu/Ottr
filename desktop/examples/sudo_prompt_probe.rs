//! sudo 提示符冒号丢失（用户报告 2026-10-19：同机同命令，其他 SSH 工具显示
//! `Password:`，Ottr 显示 `Password`）的字节级定位探针。
//!
//! 两会话唯一差异 = Ottr 注入 shell 集成片段 → 四组合实证：
//!   {bash, zsh} × {注入, 不注入}，跑真 sudo（spike 有密码 sudo），
//!   抓产线转发路径（forward_pty_loop 解码流）中 sudo 提示符附近的字节。
//! 若注入会话的字节里冒号消失 = 远端侧（shell/片段与 sudo 交互）问题；
//! 若字节都在 = 传输无损，问题在前端渲染层。
//!
//! 运行：`cargo run -p ottr --example sudo_prompt_probe -- <bash|zsh> <inject|noinject>`

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::Notify;

use ottr_lib::{SessionCounters, ShellIntegrationOutcome, TextTail, forward_pty_loop, inject_shell_integration};
use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession, connect};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/known_hosts");

fn pinned_host_key_policy() -> HostKeyPolicy {
    use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};
    let content =
        std::fs::read_to_string(KNOWN_HOSTS).unwrap_or_else(|e| panic!("read {KNOWN_HOSTS}: {e}"));
    let line = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some("[127.0.0.1]:2222"))
        .expect("known_hosts entry");
    let b64 = line.split_whitespace().nth(2).expect("malformed");
    let pinned: PublicKey = parse_public_key_base64(b64).expect("parse");
    let fp = pinned.fingerprint(HashAlg::Sha256).to_string();
    Arc::new(move |f: &str| f == fp) as HostKeyPolicy
}

#[tokio::main]
async fn main() {
    let shell = std::env::args().nth(1).unwrap_or_else(|| "zsh".into());
    let inject = std::env::args().nth(2).as_deref() != Some("noinject");
    let (user, pass) = if shell == "zsh" {
        ("spike-zsh", "spike-pass")
    } else {
        ("spike", "spike-pass")
    };
    if let Err(e) = run(user, pass, &shell, inject).await {
        eprintln!("[probe] FAIL: {e}");
        std::process::exit(1);
    }
}

async fn run(user: &str, pass: &str, shell: &str, inject: bool) -> Result<(), String> {
    let session: SshSession = connect(
        HOST,
        PORT,
        user,
        AuthMethod::Password(pass.into()),
        pinned_host_key_policy(),
    )
    .await
    .map_err(|e| format!("connect: {e}"))?;
    let mut channel = session.open_pty(120, 40).await.map_err(|e| format!("open_pty: {e}"))?;
    channel.request_shell(true).await.map_err(|e| format!("request_shell: {e}"))?;

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
    let decoder = Arc::new(Mutex::new(ottr_term::encoding::StreamDecoder::new(
        ottr_term::encoding::Encoding::Utf8,
    )));
    let cancel = Arc::new(Notify::new());
    let cancel_handle = Arc::clone(&cancel);
    let text_tail = Arc::new(TextTail::new());
    let writer: Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>> =
        Arc::new(tokio::sync::Mutex::new(Box::new(channel.make_writer())));
    let forward_tail = Arc::clone(&text_tail);
    let recorder_slot: ottr_lib::RecorderSlot = Arc::new(std::sync::Mutex::new(None));
    let loop_slot = Arc::new(ottr_lib::SessionResizeSlot::default());
    let mut chan = channel;
    tauri::async_runtime::spawn(async move {
        let _ = forward_pty_loop(
            &mut chan,
            &on_data,
            &counters,
            &decoder,
            &forward_tail,
            &recorder_slot,
            "sudo-prompt-probe",
            &cancel_handle,
            &loop_slot,
        )
        .await;
    });

    let settle = |ms: u64| tokio::time::sleep(Duration::from_millis(ms));
    settle(1000).await;

    // 产线注入（可选）
    if inject {
        let outcome = inject_shell_integration(&writer, &session, &text_tail, true).await;
        println!("[inject:{shell}] {outcome:?}");
        settle(800).await;
    }

    // 跑 sudo：先清凭据缓存强制提示；不带 -S（走 tty 自然路径，与产品一致）。
    // 错密码喂三轮后 sudo 放弃退出（不真执行任何命令）。
    {
        use tokio::io::AsyncWriteExt;
        let mut w = writer.lock().await;
        w.write_all(b"sudo -k\r").await.map_err(|e| format!("{e}"))?;
    }
    settle(900).await;
    {
        use tokio::io::AsyncWriteExt;
        let mut w = writer.lock().await;
        w.write_all(b"sudo -S true\r").await.map_err(|e| format!("{e}"))?;
    }
    settle(1200).await;
    for _ in 0..3 {
        {
            use tokio::io::AsyncWriteExt;
            let mut w = writer.lock().await;
            w.write_all(b"wrongpass\r").await.map_err(|e| format!("{e}"))?;
        }
        settle(900).await;
    }
    settle(600).await;

    // 输出 sudo 提示符附近的解码流（转义可见）
    let buf = decoded.lock().unwrap();
    let mut hits = 0;
    let mut from = 0;
    while let Some(pos) = buf[from..].find("assword") {
        let start = (from + pos).saturating_sub(40);
        let end = (from + pos + 90).min(buf.len());
        let seg: String = buf[start..end].chars().collect();
        println!("[segment {hits}] {seg:?}");
        hits += 1;
        from = from + pos + 8;
        if hits >= 6 {
            break;
        }
    }
    if hits == 0 {
        println!("[probe] no sudo prompt found in stream (sudo may have failed)");
        let tail: String = buf.chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
        println!("[tail] {tail:?}");
    } else {
        println!("[PASS] {shell} inject={inject}: {hits} prompt segment(s) dumped — 目检冒号");
    }
    cancel.notify_one();
    Ok(())
}
