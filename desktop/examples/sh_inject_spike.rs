//! sh 系（dash）shell 集成注入的真夹具端到端验证（2026-10-19，sh/ash/dash →
//! ShellKind::Sh 注入路径的协议级验收面；GUI 层由真机 E2E 另行覆盖）。
//!
//! 链路（与 [`history_fixture`](super::history_fixture) 同一条产线实现，换
//! spike-sh 用户 = /bin/sh 登录 shell）：
//!   sshd 夹具 → open_pty + request_shell（dash）→ forward_pty_loop +
//!   TextTail → [`ottr_lib::inject_shell_integration`]（$SHELL 探测识别
//!   sh → SH_SNIPPET 经两步隐身通道下发 → **验证窗等 `133;D;` 标记**）→
//!   跑 3 条命令 → 流重放断言退出码三元组 + **防提示符污染**（解码流不得
//!   出现 PS1 字面量残骸 `$(printf`——「不支持也不得引起其他错误」的硬约束）。
//!
//! 断言面：
//! * outcome == Injected("sh")——验证-回退护栏在真 dash 上判「注入成立」；
//! * 重放 exit 码 [0, 0, 1, 0]：首项为注入行自身的 D（stty 回显行，噪声过滤
//!   剔除——生产 record.ts 因 integrated=false 不入库，无此噪声）；
//! * `false` → D;1（诊断触发面：退出码准确到达标记流）；
//! * osc7_paths 为空（sh 片段不发 OSC 7，设计如此）。
//!
//! 运行：先 `bash scripts/spike-sshd.sh` 起夹具（容器内已有 spike-sh 用户，
//! 见 fixtures/sshd/entrypoint.sh），再 `cargo run -p ottr --example sh_inject_spike`。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::Notify;

use ottr_lib::{
    SessionCounters, ShellIntegrationOutcome, TextTail, forward_pty_loop, inject_shell_integration,
};
use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession, connect};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike-sh";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/known_hosts");

/// 输出静默多久视为命令已收尾。
const IDLE: Duration = Duration::from_millis(500);
/// 单命令捕获总上限。
const CMD_MAX: Duration = Duration::from_secs(8);

/// 从 known_hosts 提取 `[127.0.0.1]:2222` 指纹 pin（history_fixture 同款）。
fn pinned_host_key_policy() -> (HostKeyPolicy, String) {
    use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};
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

/// PTY 写端 + 解码输出累积（history_fixture 同款）。
struct Stage {
    decoded: Arc<Mutex<String>>,
    writer: Arc<tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>>,
}

impl Stage {
    async fn run_line(&self, line: &str) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let before = self.decoded.lock().unwrap().len();
        {
            let mut w = self.writer.lock().await;
            w.write_all(line.as_bytes())
                .await
                .map_err(|e| format!("write failed: {e}"))?;
            w.write_all(b"\r")
                .await
                .map_err(|e| format!("write failed: {e}"))?;
        }
        let deadline = tokio::time::Instant::now() + CMD_MAX;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("timeout ({CMD_MAX:?}) waiting output: {line:?}"));
            }
            tokio::time::sleep(IDLE).await;
            let len = self.decoded.lock().unwrap().len();
            if len == before {
                continue;
            }
            tokio::time::sleep(IDLE).await;
            let len2 = self.decoded.lock().unwrap().len();
            if len2 == len {
                return Ok(());
            }
        }
    }
}

/// 流重放（history_fixture 同款 CommandWatch 语义测试架：OSC 133 C/D;code +
/// D-only 回退；OSC 7 cwd）。
struct Replay {
    state: Sim,
    osc_body: String,
    pending_line: String,
    last_line: String,
    pending_cmd: Option<String>,
    /// (command 原样提取, exit_code)
    pub events: Vec<(String, Option<i64>)>,
    pub osc7_paths: Vec<String>,
}

#[derive(PartialEq)]
enum Sim {
    Text,
    Esc,
    Csi,
    Osc,
}

impl Replay {
    fn new() -> Self {
        Self {
            state: Sim::Text,
            osc_body: String::new(),
            pending_line: String::new(),
            last_line: String::new(),
            pending_cmd: None,
            events: Vec::new(),
            osc7_paths: Vec::new(),
        }
    }

    fn feed(&mut self, text: &str) {
        for ch in text.chars() {
            match self.state {
                Sim::Text => match ch {
                    '\x1b' => self.state = Sim::Esc,
                    '\r' | '\n' => {
                        let line = std::mem::take(&mut self.pending_line);
                        if !line.trim().is_empty() {
                            self.last_line = line;
                        }
                    }
                    c => self.pending_line.push(c),
                },
                Sim::Esc => match ch {
                    ']' => {
                        self.state = Sim::Osc;
                        self.osc_body.clear();
                    }
                    '[' => self.state = Sim::Csi,
                    _ => self.state = Sim::Text,
                },
                Sim::Csi => {
                    if ('\u{40}'..='\u{7e}').contains(&ch) {
                        self.state = Sim::Text;
                    }
                }
                Sim::Osc => {
                    if ch == '\u{7}' {
                        self.state = Sim::Text;
                        let body = std::mem::take(&mut self.osc_body);
                        self.handle_osc(&body);
                    } else {
                        self.osc_body.push(ch);
                    }
                }
            }
        }
    }

    fn handle_osc(&mut self, body: &str) {
        if let Some(rest) = body.strip_prefix("133;") {
            match rest {
                "A" => {}
                "C" => self.pending_cmd = Some(self.last_line.clone()),
                "D" => self.emit_done(None),
                d if d.starts_with("D;") => self.emit_done(d["D;".len()..].parse::<i64>().ok()),
                _ => {}
            }
        } else if let Some(rest) = body.strip_prefix("7;")
            && let Some(path) = rest.strip_prefix("file://")
            && let Some(slash) = path.find('/')
        {
            self.osc7_paths.push(path[slash..].to_string());
        }
    }

    fn emit_done(&mut self, exit_code: Option<i64>) {
        let cmd = self
            .pending_cmd
            .take()
            .unwrap_or_else(|| self.last_line.clone());
        self.events.push((cmd, exit_code));
    }
}

/// 提示符剥离（stripPromptPrefix 测试架同款）。
fn strip_prompt(line: &str) -> String {
    let trimmed = line.trim_start();
    if let Some((token, rest)) = trimmed.split_once(' ')
        && matches!(
            token.chars().next_back(),
            Some('$') | Some('#') | Some('%') | Some('>')
        )
        && token.chars().count() <= 128
    {
        return rest.trim_start().to_string();
    }
    trimmed.to_string()
}

/// 噪声过滤（record.ts is_integration_noise 同款 + sh 系注入流的三类残行：
/// 隐身通道 `stty -echo` 回显行、片段/恢复行自身 D 事件取到的纯提示符行
/// ——生产因 integrated=false 不入库，重放面在此显式剔除）。
fn is_noise(command: &str) -> bool {
    if command.contains("133;")
        || command.contains("PROMPT_COMMAND")
        || command.contains("osc133_preexec")
        || command.contains("precmd(){")
        || command.contains("stty -echo")
        // sh 系注入行（2026-10-20）：交互行只剩 `. /tmp/.ottr-xxxx.sh`
        || command.contains(".ottr-")
    {
        return true;
    }
    // 纯提示符字符行（$ # % > 空白）：无命令语义
    !command
        .chars()
        .any(|c| !matches!(c, '$' | '#' | '%' | '>' | ' ' | '\t'))
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("[sh-spike] FAIL: {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let (policy, pinned_fp) = pinned_host_key_policy();
    eprintln!("[sh-spike] connect {USER}@{HOST}:{PORT} (pinned {pinned_fp})");
    let session: SshSession = connect(
        HOST,
        PORT,
        USER,
        AuthMethod::Password(PASSWORD.into()),
        policy,
    )
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
    eprintln!("[sh-spike] pty 120x40 + shell running (login shell = /bin/sh = dash)");

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
    tauri::async_runtime::spawn(async move {
        let _ = forward_pty_loop(
            &mut channel,
            &on_data,
            &counters,
            &decoder,
            &forward_tail,
            &recorder_slot,
            "sh-inject-spike",
            &cancel_handle,
            &ottr_lib::SessionResizeSlot::default(),
        )
        .await;
    });
    let stage = Stage {
        decoded,
        writer: Arc::clone(&writer),
    };

    // 首窗吃掉 banner/提示符（注入前无 133 标记）
    stage.run_line("true").await?;

    // 诊断面：$SHELL 探测应答（注入核走同一 exec 面）
    match tokio::time::timeout(
        std::time::Duration::from_secs(5),
        session.exec("echo $SHELL"),
    )
    .await
    {
        Ok(Ok(out)) => println!(
            "[diag] $SHELL probe -> {:?}",
            String::from_utf8_lossy(&out.stdout)
        ),
        other => println!("[diag] $SHELL probe -> {other:?}"),
    }

    // --- 产线注入核（与 attach_host_session 同一函数）-----------------------
    // Injected("sh") 本身即验证-回退护栏的判定结果：窗口内真见到了 133;D; 标记。
    let outcome = inject_shell_integration(&writer, &session, &text_tail, true).await;
    println!("[inject] -> {outcome:?}");
    if outcome != ShellIntegrationOutcome::Injected("sh") {
        // 诊断面：回显注入后的解码流尾部与原始头部标记状态，便于定位
        let buf = stage.decoded.lock().unwrap();
        let tail: String = buf
            .chars()
            .rev()
            .take(800)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        println!("[diag] decoded tail after failed inject: {tail:?}");
        println!("[diag] raw head has 133 = {}", text_tail.raw_head_has_133());
        return Err(format!("expected Injected(\"sh\"), got {outcome:?}"));
    }

    // 三条用户命令：true / false / true
    for cmd in ["true", "false", "true"] {
        stage.run_line(cmd).await?;
        println!("[cmd] {cmd} done");
    }

    // 硬约束断言①：防提示符污染——解码流不得出现 PS1 字面量残骸（不支持
    // 命令替换的 shell 会把片段原文上屏，那是「引起其他错误」的形态）。
    {
        let buf = stage.decoded.lock().unwrap();
        for bad in ["$(printf", "__ottr_ps1", "case \""] {
            if buf.contains(bad) {
                return Err(format!("prompt pollution: decoded stream contains {bad:?}"));
            }
        }
    }

    // 重放断言：注入行 D（stty 噪声，剔除）+ 三条用户命令退出码 0/1/0
    let mut replay = Replay::new();
    {
        let buf = stage.decoded.lock().unwrap();
        replay.feed(&buf);
    }
    let mut rows: Vec<(String, Option<i64>)> = Vec::new();
    for (raw, code) in &replay.events {
        let cleaned = strip_prompt(raw);
        if cleaned.is_empty() || is_noise(&cleaned) || is_noise(raw) {
            continue;
        }
        println!("[replay] exit={code:?} command={cleaned:?}");
        rows.push((cleaned, *code));
    }
    if rows.len() != 3 {
        return Err(format!(
            "expected 3 user commands, got {}: {:?}",
            rows.len(),
            rows
        ));
    }
    let codes: Vec<Option<i64>> = rows.iter().map(|(_, c)| *c).collect();
    if codes != [Some(0), Some(1), Some(0)] {
        return Err(format!("exit codes mismatch: {codes:?} (want [0, 1, 0])"));
    }
    if rows[1].0 != "false" {
        return Err(format!(
            "rows[1] should be the failed command, got {:?}",
            rows[1]
        ));
    }

    // 硬约束断言②：sh 片段不发 OSC 7（cwd 只喂历史/⌘J，sh 系历史停用）
    if !replay.osc7_paths.is_empty() {
        return Err(format!(
            "unexpected OSC 7 paths from sh snippet: {:?}",
            replay.osc7_paths
        ));
    }

    // 幂等：二次注入 → 头部已有标记 → SkippedAlreadyIntegrated
    let replay_outcome = inject_shell_integration(&writer, &session, &text_tail, true).await;
    println!("[inject] second call -> {replay_outcome:?}");
    if replay_outcome != ShellIntegrationOutcome::SkippedAlreadyIntegrated {
        return Err(format!(
            "expected SkippedAlreadyIntegrated, got {replay_outcome:?}"
        ));
    }

    println!(
        "[PASS] sh_inject_spike: dash fixture -> inject(sh) verified by marker window -> \
true/false/true exit [0,1,0] (D;1 reached the marker stream for `false`) -> no prompt \
pollution -> no OSC 7 -> idempotent re-inject skipped"
    );
    cancel.notify_one();
    Ok(())
}
