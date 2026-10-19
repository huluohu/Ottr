//! 页签切换/面板开合「输入框冒提示符前缀」（用户报告 2026-10-19：`[h`/`[r`）
//! 的复现探针：真 PTY 上注入集成后，按产品路径的宽度变化序列下发
//! window_change（AI 面板打开=终端变窄、关闭=变宽、页签切换=同宽回_fit），
//! 抓 shell 的全部原始应答——若 `[r` 式提示符碎片在输出流中出现，即为
//! SIGWINCH 重绘伪影（输出侧），前端无需写任何字节。
//!
//! 运行：夹具起好后 `cargo run -p ottr --example resize_artifact_probe -- bash|sh`

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::Notify;

use ottr_lib::{SessionCounters, TextTail, forward_pty_loop};
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

/// 产品路径的注入（bash/snippet 或 sh 片段），复用产线注入核。
async fn inject(
    session: &SshSession,
    writer: &Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>>,
    tail: &Arc<TextTail>,
    kind: &str,
) {
    let enabled = true;
    let outcome = ottr_lib::inject_shell_integration(writer, session, tail, enabled).await;
    println!("[inject:{kind}] {outcome:?}");
}

#[tokio::main]
async fn main() {
    let kind = std::env::args().nth(1).unwrap_or_else(|| "bash".into());
    let (user, pass) = match kind.as_str() {
        "sh" => ("spike-sh", "spike-pass"),
        _ => ("spike", "spike-pass"),
    };
    if let Err(e) = run(user, pass, &kind).await {
        eprintln!("[probe] FAIL: {e}");
        std::process::exit(1);
    }
}

async fn run(user: &str, pass: &str, kind: &str) -> Result<(), String> {
    let session: SshSession = connect(
        HOST,
        PORT,
        user,
        AuthMethod::Password(pass.into()),
        pinned_host_key_policy(),
    )
    .await
    .map_err(|e| format!("connect: {e}"))?;
    // 产品 attach 形态：先 2×1 退化尺寸（缺陷 34 注释里的 attach 尺寸），随后
    // fit 出真实尺寸再 resize——两段都保留，观测首提示符在退化宽度下的形态。
    let channel = session
        .open_pty(2, 1)
        .await
        .map_err(|e| format!("open_pty: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("request_shell: {e}"))?;

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
    // resize 走产线同一机制：投槽 → 转发循环 window_change
    let resize_slot = Arc::new(ottr_lib::SessionResizeSlot::default());
    let loop_slot = Arc::clone(&resize_slot);
    let mut chan = channel;
    tauri::async_runtime::spawn(async move {
        let _ = forward_pty_loop(
            &mut chan,
            &on_data,
            &counters,
            &decoder,
            &forward_tail,
            &recorder_slot,
            "resize-artifact-probe",
            &cancel_handle,
            &loop_slot,
        )
        .await;
    });

    let settle = |ms: u64| tokio::time::sleep(Duration::from_millis(ms));
    let resize = |cols: u32, rows: u32| resize_slot.set(cols, rows);
    let mark = |label: &str| {
        let d = decoded.lock().unwrap();
        let len = d.len();
        println!("\n===== {label} (decoded len → {len}) =====");
    };
    let since = |label: &str, from: usize| {
        let d = decoded.lock().unwrap();
        println!("\n----- since {label} -----");
        let s: String = d.chars().skip(from).collect();
        for line in s.split('\n') {
            println!("{:?}", line);
        }
    };

    settle(800).await;
    mark("after attach 2x1 (shell first prompt at degenerate width)");
    since("attach", 0);

    // fit→resizeSession：真实尺寸（产品路径第二步）
    resize(120, 40);
    settle(600).await;
    mark("after resize 120x40");

    // 注入（产线注入核）
    inject(&session, &writer, &text_tail, kind).await;
    settle(800).await;
    let before_cmds = decoded.lock().unwrap().len();
    mark("after inject");

    // 一条失败命令（AI 面板会在此刻自动打开 → 终端变窄）
    {
        use tokio::io::AsyncWriteExt;
        let mut w = writer.lock().await;
        w.write_all(b"false\r").await.map_err(|e| format!("{e}"))?;
    }
    settle(600).await;
    // 面板打开 = 终端宽度收窄（约 25 列）
    resize(95, 40);
    settle(700).await;
    mark("after panel-open narrow 95");
    since("fail+panel-open", before_cmds);

    // 页签切走再切回 = 同宽回 fit（同尺寸去重 → 不应有任何下发，但观测）
    resize(95, 40);
    settle(500).await;
    mark("after same-size resize (dedup expectation)");

    // 面板关闭 = 变宽
    resize(120, 40);
    settle(700).await;
    mark("after panel-close wide 120");
    since("panel-close", before_cmds);

    // 极端：瞬时窄宽度（塌列家族）再回宽
    resize(2, 1);
    settle(400).await;
    resize(120, 40);
    settle(700).await;
    mark("after collapse-to-2 then back to 120");
    since("collapse", before_cmds);

    println!("\n[probe] done — 目检以上各段是否有提示符前缀碎片（如 \"[s\" / \"[r\" / \"[h\"）");
    cancel.notify_one();
    Ok(())
}
