//! Task 6 / spike #11：OSC 133 自动注入与命令边界捕获的真机验证（headless）。
//!
//! 连接容器化 sshd 夹具（scripts/spike-sshd.sh，127.0.0.1:2222）→
//! `open_pty` + `request_shell` → **幂等探测**（发 marker 命令观察事件流里
//! 是否已有 OSC 133/7 输出，有则跳过注入）→ 按 shell 注入
//! [`ottr_ssh::shell_integration::inject_for`] 片段 → 跑 `false` / `true`
//! → 全部输出逐 chunk 喂 `ottr_term::osc133::Parser` → 事件序列以 **JSONL**
//! 打到 stdout（重定向存盘即证据文件），过程日志走 stderr。
//!
//! 场景（`cargo run -p ottr-ssh --example osc133_spike -- <scenario>`）：
//!
//! | scenario   | 内容 |
//! |------------|------|
//! | `bash`     | bash 注入 + `false`/`true`（基准路径） |
//! | `zsh`      | `exec zsh` 后注入 zsh 片段 + `false`/`true` |
//! | `fancy-ps1`| bash 注入后设置 powerline 风格多行 PS1 再跑 `false`/`true`（OSC 133 与 PS1 复杂度无关） |
//! | `probe-skip`| bash 注入后 `exec bash`（继承导出的 PROMPT_COMMAND）→ 探测应识别"已集成"并跳过二次注入 |
//!
//! 期望（bash/zsh/fancy-ps1）：`false` → `CommandEnd` 然后
//! `CommandDone{exit_code:1}`；`true` → `CommandDone{exit_code:0}`；
//! 每个提示符周期伴随 `PromptStart` 与指向 `$PWD` 的 `Cwd`。
//! 验证不达标时进程退出码非 0 并向 stderr dump 原始输出尾部。
//!
//! ```text
//! cargo run -p ottr-ssh --example osc133_spike -- bash      > /tmp/ottr-osc133-bash.jsonl
//! cargo run -p ottr-ssh --example osc133_spike -- zsh       > /tmp/ottr-osc133-zsh.jsonl
//! cargo run -p ottr-ssh --example osc133_spike -- fancy-ps1 > /tmp/ottr-osc133-fancyps1.jsonl
//! cargo run -p ottr-ssh --example osc133_spike -- probe-skip > /tmp/ottr-osc133-probe-skip.jsonl
//! ```

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::ChannelMsg;
use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

use ottr_ssh::shell_integration::{ShellKind, inject_for};
use ottr_ssh::{AuthMethod, HostKeyPolicy, SshSession, connect};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");

/// 输出静默多久视为提示符已就绪。
const IDLE: Duration = Duration::from_millis(500);
/// settle/probe 阶段总上限。
const SETTLE_MAX: Duration = Duration::from_secs(5);
/// 单命令等待 CommandDone 的总上限。
const CMD_MAX: Duration = Duration::from_secs(8);
/// 命令周期收尾（等 A/Cwd 落地）的静默窗。
const GRACE: Duration = Duration::from_millis(400);
/// 原始输出环形缓存上限（失败诊断用，只留尾部）。
const RAW_CAP: usize = 256 * 1024;
const RAW_TAIL: usize = 8 * 1024;

/// 探测 marker：同时覆盖简报的 `echo $SHELL` shell 探测与 133 幂等探测。
const PROBE_MARKER: &str = "echo __OTTR_OSC133_PROBE__ shell=$SHELL";

/// powerline 风格两行 PS1（无 powerline 字体依赖：标准 SGR + UTF-8 字形）。
/// `$'…'` 内 `\\u` 写双反斜杠（`\u` 是 ANSI-C 转义，单写会报 bad unicode escape）。
const FANCY_PS1: &str = "export PS1=$'\\[\\e[38;5;39m\\]\\\\u@\\h \\[\\e[48;5;234m\\]\\[\\e[38;5;208m\\] \\w \\[\\e[0m\\]\\[\\e[38;5;238m\\]─\\[\\e[0m\\]\\n\\[\\e[38;5;46m\\]❯\\[\\e[0m\\] '";

/// [`ottr_term::osc133::Event`] 的 owned 版本：`feed` 产出借用 chunk 的事件，
/// 读任务里立即转 owned 再跨线程发送。
#[derive(Debug, Clone, PartialEq, Eq)]
enum OwnedEvent {
    PromptStart,
    CommandStart,
    CommandEnd,
    CommandDone { exit_code: Option<i32> },
    Cwd(String),
    Text(Vec<u8>),
}

impl From<ottr_term::osc133::Event<'_>> for OwnedEvent {
    fn from(ev: ottr_term::osc133::Event<'_>) -> Self {
        match ev {
            ottr_term::osc133::Event::PromptStart => Self::PromptStart,
            ottr_term::osc133::Event::CommandStart => Self::CommandStart,
            ottr_term::osc133::Event::CommandEnd => Self::CommandEnd,
            ottr_term::osc133::Event::CommandDone { exit_code } => Self::CommandDone { exit_code },
            ottr_term::osc133::Event::Cwd(path) => Self::Cwd(path),
            ottr_term::osc133::Event::Text(bytes) => Self::Text(bytes.to_vec()),
        }
    }
}

impl OwnedEvent {
    /// OSC 133/7 事件（幂等探测判据；Text 不算集成信号）。
    fn is_shell_integration(&self) -> bool {
        matches!(
            self,
            Self::PromptStart
                | Self::CommandStart
                | Self::CommandEnd
                | Self::CommandDone { .. }
                | Self::Cwd(_)
        )
    }

    fn jsonl(&self) -> String {
        match self {
            Self::PromptStart => r#"{"event":"PromptStart"}"#.into(),
            Self::CommandStart => r#"{"event":"CommandStart"}"#.into(),
            Self::CommandEnd => r#"{"event":"CommandEnd"}"#.into(),
            Self::CommandDone { exit_code } => match exit_code {
                Some(code) => format!(r#"{{"event":"CommandDone","exit_code":{code}}}"#),
                None => r#"{"event":"CommandDone","exit_code":null}"#.into(),
            },
            Self::Cwd(path) => format!(r#"{{"event":"Cwd","path":"{}"}}"#, json_escape(path)),
            Self::Text(bytes) => format!(
                r#"{{"event":"Text","text":"{}"}}"#,
                json_escape(&String::from_utf8_lossy(bytes))
            ),
        }
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// JSONL 汇（逐行落 stdout 并保留全量副本供断言）。
#[derive(Default)]
struct Sink {
    seen: Vec<OwnedEvent>,
}

impl Sink {
    fn push(&mut self, ev: OwnedEvent) {
        println!("{}", ev.jsonl());
        // 证据文件逐行 flush：即便后续失败/被杀，已产出事件仍完整落盘。
        use std::io::Write;
        let _ = std::io::stdout().flush();
        self.seen.push(ev);
    }

    fn count(&self, pred: impl Fn(&OwnedEvent) -> bool) -> usize {
        self.seen.iter().filter(|e| pred(e)).count()
    }
}

/// 从 known_hosts 提取 `[127.0.0.1]:2222` 条目生成指纹 pin 策略（同 real_fixture）。
fn pinned_host_key_policy() -> (HostKeyPolicy, String) {
    let content =
        std::fs::read_to_string(KNOWN_HOSTS).unwrap_or_else(|e| panic!("read {KNOWN_HOSTS}: {e}"));
    let marker = format!("[{HOST}]:{PORT}");
    let line = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .unwrap_or_else(|| panic!("known_hosts has no entry for {marker}"));
    let base64 = line
        .split_whitespace()
        .nth(2)
        .unwrap_or_else(|| panic!("malformed known_hosts line: {line}"));
    let pinned: PublicKey = parse_public_key_base64(base64).expect("parse pinned host key");
    let pinned_fp = pinned.fingerprint(HashAlg::Sha256).to_string();
    let pinned_fp_for_cb = pinned_fp.clone();
    let policy: HostKeyPolicy = Arc::new(move |fingerprint: &str| fingerprint == pinned_fp_for_cb);
    (policy, pinned_fp)
}

type Rx = UnboundedReceiver<Option<OwnedEvent>>;

/// 泵事件直到输出静默 `idle` 或超过 `max`。EOF/通道断开 → Err。
async fn pump(rx: &mut Rx, sink: &mut Sink, idle: Duration, max: Duration) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + max;
    loop {
        if tokio::time::Instant::now() >= deadline {
            return Ok(());
        }
        match tokio::time::timeout(idle, rx.recv()).await {
            Ok(Some(Some(ev))) => sink.push(ev),
            Ok(Some(None)) => return Err("channel EOF: shell exited unexpectedly".into()),
            Ok(None) => return Err("event channel closed".into()),
            Err(_) => return Ok(()), // 静默窗到期 → 提示符就绪
        }
    }
}

/// 发送一行（自动补 `\r`）。
async fn send_line(
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    line: &str,
) -> Result<(), String> {
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    writer
        .write_all(b"\r")
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

/// 发送命令并等待其提示符周期结束（见到 CommandDone 后再泵到静默），
/// 返回该周期的退出码。
async fn send_command(
    rx: &mut Rx,
    sink: &mut Sink,
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
    line: &str,
) -> Result<Option<i32>, String> {
    send_line(writer, line).await?;
    let code: Option<i32> = loop {
        match tokio::time::timeout(CMD_MAX, rx.recv()).await {
            Ok(Some(Some(ev))) => {
                if let OwnedEvent::CommandDone { exit_code } = ev {
                    sink.push(OwnedEvent::CommandDone { exit_code });
                    break exit_code;
                }
                sink.push(ev);
            }
            Ok(Some(None)) => {
                return Err(format!(
                    "channel EOF while waiting for CommandDone after {line:?}"
                ));
            }
            Ok(None) => return Err("event channel closed".into()),
            Err(_) => {
                return Err(format!(
                    "timeout ({CMD_MAX:?}) waiting for CommandDone after {line:?}"
                ));
            }
        }
    };
    pump(rx, sink, GRACE, SETTLE_MAX).await?;
    Ok(code)
}

/// 幂等探测：发 marker 命令并泵到静默；marker 周期内出现任何 OSC 133/7
/// 事件即视为已集成（简报："注入前先检查是否已有 133 输出"）。
async fn probe_integration(
    rx: &mut Rx,
    sink: &mut Sink,
    writer: &mut (impl tokio::io::AsyncWrite + Unpin),
) -> Result<bool, String> {
    let start = sink.seen.len();
    send_line(writer, PROBE_MARKER).await?;
    pump(rx, sink, IDLE, SETTLE_MAX).await?;
    let integrated = sink.seen[start..]
        .iter()
        .any(OwnedEvent::is_shell_integration);
    Ok(integrated)
}

async fn run(scenario: &str, raw: &Arc<Mutex<Vec<u8>>>) -> Result<String, String> {
    let (policy, pinned_fp) = pinned_host_key_policy();
    eprintln!("[conn] {USER}@{HOST}:{PORT} (pinned {pinned_fp})");
    let session: SshSession = connect(
        HOST,
        PORT,
        USER,
        AuthMethod::Password(PASSWORD.to_string()),
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

    // 读任务独占 Channel::wait；主流程经 make_writer 注入按键。
    // raw：原始输出环形缓存（main 在失败时 dump 尾部做诊断）。
    let mut writer = channel.make_writer();
    let (tx, mut rx) = unbounded_channel::<Option<OwnedEvent>>();
    let raw_for_reader = Arc::clone(raw);
    tokio::spawn(async move {
        let mut parser = ottr_term::osc133::Parser::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    {
                        let mut buf = raw_for_reader.lock().unwrap_or_else(|p| p.into_inner());
                        buf.extend_from_slice(&data);
                        let len = buf.len();
                        if len > RAW_CAP {
                            buf.drain(..len - RAW_CAP);
                        }
                    }
                    for ev in parser.feed(&data) {
                        if tx.send(Some(OwnedEvent::from(ev))).is_err() {
                            return;
                        }
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    let _ = tx.send(None);
                    return;
                }
                _ => {}
            }
        }
    });

    let mut sink = Sink::default();

    // 初始 settle：banner + 首个提示符。
    pump(&mut rx, &mut sink, IDLE, SETTLE_MAX).await?;

    let mut expect_integrated = false;
    match scenario {
        "bash" | "fancy-ps1" => {}
        "zsh" => {
            eprintln!("[zsh] exec zsh");
            send_line(&mut writer, "exec zsh").await?;
            pump(&mut rx, &mut sink, IDLE, SETTLE_MAX).await?;
        }
        "probe-skip" => {
            // 场景准备：先注入一次制造"已集成环境"，再 exec bash 重启 shell——
            // 新 bash 继承**导出的** PROMPT_COMMAND（133 输出仍在），
            // 但 DEBUG trap 与函数均不被继承（exec 语义，真实重连场景的近似）。
            eprintln!("[probe-skip] seeding: inject bash, then exec bash");
            send_line(&mut writer, inject_for(ShellKind::Bash)).await?;
            pump(&mut rx, &mut sink, IDLE, SETTLE_MAX).await?;
            send_line(&mut writer, "exec bash").await?;
            pump(&mut rx, &mut sink, IDLE, SETTLE_MAX).await?;
            expect_integrated = true;
        }
        other => {
            return Err(format!(
                "unknown scenario {other:?} (use bash | zsh | fancy-ps1 | probe-skip)"
            ));
        }
    }

    // 幂等探测（简报 Step 1：注入前先检查是否已有 133 输出）。
    eprintln!("[probe] marker: {PROBE_MARKER:?}");
    let integrated = probe_integration(&mut rx, &mut sink, &mut writer).await?;
    let shell = match scenario {
        "zsh" => ShellKind::Zsh,
        _ => ShellKind::Bash,
    };
    if integrated {
        eprintln!("[probe] existing OSC 133 output detected -> SKIP injection (idempotent guard)");
    } else {
        eprintln!(
            "[probe] no OSC 133 output -> injecting {} snippet",
            shell_kind_name(shell)
        );
        send_line(&mut writer, inject_for(shell)).await?;
        pump(&mut rx, &mut sink, IDLE, SETTLE_MAX).await?;
    }

    // 简报 Step 4：花哨 PS1 降级路径（OSC 是独立通道，与 PS1 无关）。
    if scenario == "fancy-ps1" {
        eprintln!("[ps1] setting powerline-style two-line PS1");
        send_line(&mut writer, FANCY_PS1).await?;
        pump(&mut rx, &mut sink, IDLE, SETTLE_MAX).await?;
    }

    // 简报 Step 2/3：跑 `false`、`true`（`exit 3` 会终止会话，按裁定只跑前两条）。
    eprintln!("[cmd] false");
    let code_false = send_command(&mut rx, &mut sink, &mut writer, "false").await?;
    eprintln!("[cmd] true");
    let code_true = send_command(&mut rx, &mut sink, &mut writer, "true").await?;

    // 断言 + 摘要。
    let cwd_ok = sink
        .seen
        .iter()
        .any(|e| matches!(e, OwnedEvent::Cwd(p) if p == "/home/spike"));
    let n_prompt = sink.count(|e| matches!(e, OwnedEvent::PromptStart));
    let n_end = sink.count(|e| matches!(e, OwnedEvent::CommandEnd));
    let n_done = sink.count(|e| matches!(e, OwnedEvent::CommandDone { .. }));
    let n_cwd = sink.count(|e| matches!(e, OwnedEvent::Cwd(_)));
    let n_text = sink.count(|e| matches!(e, OwnedEvent::Text(_)));

    let mut problems: Vec<String> = Vec::new();
    match scenario {
        "probe-skip" => {
            if !integrated {
                problems
                    .push("probe-skip: integration was NOT detected (expected skip path)".into());
            }
        }
        _ => {
            if integrated != expect_integrated {
                problems.push("integration detection mismatch".into());
            }
        }
    }
    if code_false != Some(1) {
        problems.push(format!(
            "false -> CommandDone exit_code={code_false:?}, expected Some(1)"
        ));
    }
    if code_true != Some(0) {
        problems.push(format!(
            "true -> CommandDone exit_code={code_true:?}, expected Some(0)"
        ));
    }
    if !cwd_ok {
        problems.push(r#"no Cwd event pointing at /home/spike ($PWD)"#.into());
    }
    if scenario != "probe-skip" && n_end < 2 {
        problems.push(format!("expected >=2 CommandEnd events, got {n_end}"));
    }

    let summary = format!(
        "scenario={scenario}: PromptStart={n_prompt} CommandEnd={n_end} CommandDone={n_done} Cwd={n_cwd} Text={n_text}; false->exit_code={code_false:?}, true->exit_code={code_true:?}; cwd~/home/spike={cwd_ok}; injection={}",
        if integrated {
            "skipped(detected)"
        } else {
            "injected"
        }
    );
    eprintln!("[summary] {summary}");
    if !problems.is_empty() {
        return Err(problems.join("; "));
    }
    Ok(summary)
}

fn shell_kind_name(shell: ShellKind) -> &'static str {
    match shell {
        ShellKind::Bash => "bash",
        ShellKind::Zsh => "zsh",
    }
}

fn dump_raw_tail(raw: &Arc<Mutex<Vec<u8>>>) {
    let buf = raw.lock().unwrap_or_else(|p| p.into_inner());
    let start = buf.len().saturating_sub(RAW_TAIL);
    eprintln!(
        "[raw tail {} bytes]\n{}",
        buf.len() - start,
        String::from_utf8_lossy(&buf[start..])
    );
}

#[tokio::main]
async fn main() {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "bash".into());
    let raw: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    match run(&scenario, &raw).await {
        Ok(summary) => {
            println!(); // JSONL 尾部换行兜底
            eprintln!("[PASS] {summary}");
        }
        Err(err) => {
            eprintln!("[FAIL] scenario={scenario}: {err}");
            dump_raw_tail(&raw);
            std::process::exit(1);
        }
    }
}
