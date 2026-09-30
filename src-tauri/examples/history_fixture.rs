//! Task 15（spec §5 文本层消费方③）：历史入库链路的**真夹具三命令验证**。
//!
//! 链路证据（生产入库源 = 前端 CommandWatch，本 example 是其语义的**流重放**——
//! 正式面的提取逻辑单测在 src/terminal/CommandWatch.test.ts，两者消费同一批
//! 真实标记字节）：
//!   容器化 sshd 夹具（scripts/spike-sshd.sh，127.0.0.1:2222，pinned 指纹）
//!   → open_pty + request_shell → 注入 ottr-ssh shell_integration 的 bash 片段
//!   （T6 真机验证终稿，与未来注入任务同源）→ 跑 3 条命令 → 经正式转发循环
//!   （forward_pty_loop，真合批/解码）捕获含 OSC 133 A/C/D + OSC 7 的解码流
//!   → 流重放出 (command, exit_code, cwd) 三元组（CommandWatch 语义）
//!   → ottr-vault History::insert 真库落账（tempfile + InMemoryStorage）
//!   → History::search 检索断言（「跑 3 命令 → ⌘R 搜到」的 Rust 侧闭环）。
//!
//! 场景：`echo ottr-hist-alpha`（exit 0）/ `false`（exit 1）/ `cd /tmp`（exit 0，
//! 下个提示符的 OSC 7 应上报 /tmp——cwd 跟踪证据）。
//! 断言不达标进程退出码非 0；stdout 证据供报告原样抄录。
//!
//! 运行：先 `bash scripts/spike-sshd.sh` 起夹具，再
//! `cargo run -p ottr --example history_fixture`。

use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::Notify;

use ottr_lib::{forward_pty_loop, SessionCounters, TextTail};
use ottr_ssh::shell_integration::{inject_for, ShellKind};
use ottr_ssh::{connect, AuthMethod, HostKeyPolicy};
use ottr_vault::{History, HistoryInput, HostInput, Hosts};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/known_hosts");

/// 输出静默多久视为命令已收尾。
const IDLE: Duration = Duration::from_millis(500);
/// 单命令捕获总上限。
const CMD_MAX: Duration = Duration::from_secs(8);

/// 从 known_hosts 提取 `[127.0.0.1]:2222` 指纹 pin（同 encoding_fixture）。
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

/// PTY 写端 + 解码输出累积。
struct Stage {
    decoded: Arc<Mutex<String>>,
    writer: tokio::sync::Mutex<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
}

impl Stage {
    /// 发一行并等解码输出静默（连续 IDLE 无增长），返回本窗新增文本。
    async fn run_line(&self, line: &str) -> Result<String, String> {
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

/// 流重放（CommandWatch 语义的测试架复刻，喂解码后文本）：
/// OSC 133 A（记提示符行，重放无需行号）/ C（最后提交行 = 命令回显）/
/// D;code（命令完成）/ OSC 7 file://host/path（cwd 跟踪）。
/// 转义面近似：ESC ] → OSC 收集（BEL 终止）；ESC [ → CSI 吞到终字节
/// （0x40..=0x7E，如 bracketed-paste 的 `[?2004l`）——xterm 真解析器把这些
/// 渲染为不可见，命令文本里不该有它们的残骸；其余 ESC 两字节转义吞后字节。
struct StreamReplay {
    state: Sim,
    osc_body: String,
    pending_line: String,
    last_line: String,
    pending_cmd: Option<String>,
    last_cwd: Option<String>,
    /// (command 原样提取, exit_code, cwd)
    pub events: Vec<(String, Option<i64>, Option<String>)>,
    /// OSC 7 上报过的路径（cwd 跟踪证据）。
    pub osc7_paths: Vec<String>,
}

#[derive(PartialEq)]
enum Sim {
    Text,
    Esc,
    Csi,
    Osc,
}

impl StreamReplay {
    fn new() -> Self {
        Self {
            state: Sim::Text,
            osc_body: String::new(),
            pending_line: String::new(),
            last_line: String::new(),
            pending_cmd: None,
            last_cwd: None,
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
                    _ => self.state = Sim::Text, // 两字节转义（字体内不可见）
                },
                // CSI：终字节 0x40..=0x7E 收尾（参数/中间字节全吞）
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
                "A" => {} // 提示符行号在重放中无需缓冲坐标
                "C" => self.pending_cmd = Some(self.last_line.clone()),
                "D" => self.emit_done(None),
                d if d.starts_with("D;") => {
                    self.emit_done(d["D;".len()..].parse::<i64>().ok())
                }
                _ => {}
            }
        } else if let Some(rest) = body.strip_prefix("7;") {
            // file://<host><path> → 剥 host 留 path（parseOsc7Cwd 同语义）
            if let Some(path) = rest.strip_prefix("file://") {
                if let Some(slash) = path.find('/') {
                    let cwd = path[slash..].to_string();
                    self.last_cwd = Some(cwd.clone());
                    self.osc7_paths.push(cwd);
                }
            }
        }
    }

    fn emit_done(&mut self, exit_code: Option<i64>) {
        // C 缺失形态回退取最后提交行（CommandWatch 同语义）
        let cmd = self
            .pending_cmd
            .take()
            .unwrap_or_else(|| self.last_line.clone());
        self.events.push((cmd, exit_code, self.last_cwd.clone()));
    }
}

/// 提示符剥离（src/history/format.ts stripPromptPrefix 的测试架同款保守
/// 启发式）：行首无空白 token 以提示符字符结尾再随空白 → 剥到命令本体。
fn strip_prompt(line: &str) -> String {
    let trimmed = line.trim_start();
    if let Some((token, rest)) = trimmed.split_once(' ') {
        let ends_prompt = matches!(
            token.chars().next_back(),
            Some('$') | Some('#') | Some('%') | Some('>')
        );
        if ends_prompt && token.chars().count() <= 128 {
            return rest.trim_start().to_string();
        }
    }
    trimmed.to_string()
}

/// 注入行回声/完成事件的噪声过滤（src/history/record.ts isIntegrationNoise
/// 的测试架同款 + 注入片段换行回声的片段特征；生产不注入，这里注入故从严）。
fn is_integration_noise(command: &str) -> bool {
    [
        "133;",
        "PROMPT_COMMAND",
        "osc133_preexec",
        "precmd(){",
        "file://%s",
        "$HOSTNAME",
    ]
    .iter()
    .any(|m| command.contains(m))
}

#[tokio::main]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("[fixture] FAIL: {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
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

    // 正式转发路径：真合批/解码；捕获含 OSC 标记的解码流（前端 xterm 同样直接
    // 消费这些帧——CommandWatch 正是从这些字节里提取命令事件）
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
    let writer = tokio::sync::Mutex::new(
        Box::new(channel.make_writer()) as Box<dyn tokio::io::AsyncWrite + Unpin + Send>
    );
    tauri::async_runtime::spawn(async move {
        let text_tail = TextTail::new();
        let _ = forward_pty_loop(
            &mut channel,
            &on_data,
            &counters,
            &decoder,
            &text_tail,
            "history-fixture",
            &cancel_handle,
        )
        .await;
    });
    let stage = Stage {
        decoded,
        writer,
    };

    // 首窗吃掉 banner/提示符（注入前无 133 标记）
    stage.run_line("true").await?;

    // 注入 shell 集成片段（ottr-ssh T6 真机验证终稿的 bash 片段）；注入窗
    // （回声 + 首个 D;0/A/7 突发）同样喂给重放——生产是连续流，首个 cwd 就位
    // 后第一条用户命令即携带；窗口边界是测试架的人为产物，不喂会漏首个 OSC7。
    let inject_win = stage.run_line(inject_for(ShellKind::Bash)).await?;

    // 真会话跑 3 条命令（重放只消费新增窗口）
    let mut replay = StreamReplay::new();
    let mut windows = vec![inject_win];
    for cmd in [
        "echo ottr-hist-alpha",
        "false",
        "cd /tmp",
    ] {
        let win = stage.run_line(cmd).await?;
        println!("[cmd] {cmd} -> window {} bytes", win.len());
        windows.push(win);
    }
    for win in &windows {
        replay.feed(win);
    }

    // 噪声过滤 + 提示符剥离 → 入库载荷（record.ts + App 侧 strip 同语义）
    let mut rows = Vec::new();
    for (raw, code, cwd) in &replay.events {
        let cleaned = strip_prompt(raw);
        if cleaned.is_empty() || is_integration_noise(&cleaned) || is_integration_noise(raw) {
            continue;
        }
        println!("[replay] exit={code:?} cwd={cwd:?} command={cleaned:?}");
        rows.push((cleaned, *code, cwd.clone()));
    }
    if rows.len() != 3 {
        return Err(format!(
            "expected 3 user commands from replay, got {}: {:?}",
            rows.len(),
            replay.events
        ));
    }
    let codes: Vec<Option<i64>> = rows.iter().map(|(_, c, _)| *c).collect();
    if codes != [Some(0), Some(1), Some(0)] {
        return Err(format!("exit codes mismatch: {codes:?} (want [0, 1, 0])"));
    }
    if !replay.osc7_paths.iter().any(|p| p == "/tmp") {
        return Err(format!(
            "OSC 7 cwd tracking: /tmp not reported: {:?}",
            replay.osc7_paths
        ));
    }

    // 真库落账（tempfile + InMemoryStorage，测试纪律同 ottr-vault tests）
    let dir = tempfile::tempdir().map_err(|e| format!("tempdir: {e}"))?;
    let vault = ottr_vault::Vault::open_with(dir.path(), &ottr_vault::master_key::InMemoryStorage::new())
        .map_err(|e| format!("open vault: {e}"))?;
    let host = Hosts::create(
        &vault,
        HostInput {
            name: "fixture-web01".into(),
            group_id: None,
            tags: vec![],
            address: HOST.into(),
            port: PORT as i64,
            username: Some(USER.into()),
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            notes: None,
        },
    )
    .map_err(|e| format!("create host: {e}"))?;
    for (command, exit_code, cwd) in &rows {
        History::insert(
            &vault,
            &HistoryInput {
                host_id: host.id,
                command: command.clone(),
                cwd: cwd.clone(),
                exit_code: *exit_code,
                session_id: Some("fixture-tab".into()),
            },
        )
        .map_err(|e| format!("insert {command:?}: {e}"))?;
    }

    // ⌘R 检索断言（Rust 侧闭环；前端面板消费同一命令面）
    let all = History::search(&vault, "", None, 10).map_err(|e| e.to_string())?;
    assert_eq!(all.len(), 3, "跑 3 命令 → 3 行（got {all:?}）");
    let hit = History::search(&vault, "ottr-hist", None, 50).map_err(|e| e.to_string())?;
    assert_eq!(hit.len(), 1, "FTS 「ottr-hist」应命中 echo 行");
    assert_eq!(hit[0].command, "echo ottr-hist-alpha");
    assert_eq!(hit[0].exit_code, Some(0));
    let failed = History::search(&vault, "false", None, 50).map_err(|e| e.to_string())?;
    assert_eq!(failed.len(), 1, "FTS 「false」应命中失败命令");
    assert_eq!(failed[0].exit_code, Some(1));
    let by_host = History::search(&vault, "cd", Some(host.id), 50).map_err(|e| e.to_string())?;
    assert_eq!(by_host.len(), 1, "LIKE 兜底 + host 过滤应命中 cd /tmp");
    assert_eq!(by_host[0].command, "cd /tmp");

    println!(
        "[PASS] history_fixture: 3 commands -> 3 rows; search(\"ottr-hist\")={:?} (exit 0); \
search(\"false\") exit={} ; search(\"cd\", host)={:?}; OSC7 cwd reported {:?}",
        hit[0].command,
        failed[0].exit_code.unwrap(),
        by_host[0].command,
        replay.osc7_paths
    );
    cancel.notify_one();
    Ok(())
}
