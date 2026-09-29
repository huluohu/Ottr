//! Task 10 / spike #9：GBK 编码显示与切换的真机验证（headless，无 GUI）。
//!
//! 连接容器化 sshd 夹具（scripts/spike-sshd.sh，127.0.0.1:2222）→
//! `open_pty` + `request_shell` → 原始字节按窗捕获 → 喂
//! [`ottr_term::Decoder`]（Task 10 交付的会话级解码器）做三段解码与
//! LANG 检测提示。过程日志走 stderr，证据打 stdout。
//!
//! 注意：`lang` 场景要求夹具 home 可写且有 `.profile→.bashrc` 链——本任务
//! 已修复 entrypoint（预建 home 属 root 且 useradd -m 不拷 skel）；修复前
//! 启动的旧容器须 `bash scripts/spike-sshd.sh` 重建后再跑。
//!
//! 场景（`cargo run -p ottr-ssh --example gbk_spike -- <scenario>`）：
//!
//! | scenario  | 内容 |
//! |-----------|------|
//! | `gbk`     | 跑夹具 `gbk-echo`（GBK 裸字节 17B，D6 D0 开头），对**同一字节流**三段解码：默认 UTF-8（乱码/替换符）→ 切 GBK（「中文测试 GBK 输出」）→ 切回 UTF-8（再乱码）——简报 Step 2 的切换语义 |
//! | `lang`    | LANG 检测提示四态（真机实测基线为**空**，非简报所记 C.UTF-8）：baseline 空 → `detect_hint`=UTF-8（兜底）；标记行注入 `C.UTF-8` → 重连 → UTF-8（正例）；标记行注入 `zh_CN.GBK` → 重连 → GBK；`sed` 还原后重连 → 回基线（夹具不残留）——简报 Step 3 |
//! | `all`     | 依次跑 `gbk` + `lang`（默认） |
//!
//! 断言不达标时进程退出码非 0，错误信息附窗口尾部转录。
//!
//! ```text
//! cargo run -p ottr-ssh --example gbk_spike -- all 2>/tmp/ottr-gbk-log.txt
//! ```

use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::keys::{parse_public_key_base64, HashAlg, PublicKey};
use russh::ChannelMsg;
use tokio::io::AsyncWriteExt;

use ottr_term::{Decoder, Encoding};

use ottr_ssh::{connect, AuthMethod, HostKeyPolicy, SshSession};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");

/// 输出静默多久视为命令已收尾。
const IDLE: Duration = Duration::from_millis(500);
/// 单命令捕获总上限。
const CMD_MAX: Duration = Duration::from_secs(8);
/// 原始输出缓存上限（失败诊断用）。
const RAW_CAP: usize = 256 * 1024;

/// 夹具 `gbk-echo` 应输出的 GBK 字节（「中文测试 GBK 输出」，17B）。
const EXPECTED_GBK: &[u8] = &[
    0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0x20, 0x47, 0x42, 0x4B, 0x20, 0xCA, 0xE4, 0xB3,
    0xF6,
];
const EXPECTED_TEXT: &str = "中文测试 GBK 输出";

/// 输出窗定界标记（ASCII，便于在原始字节流里定位）。
const MARKER: &str = "===OTTRGBK===";

/// `.bashrc` 注入行与还原锚点（用完即弃，不污染夹具）。
const LANG_TAG: &str = "# OTTR_LANG_SPIKE";

/// 从 known_hosts 提取 `[127.0.0.1]:2222` 条目生成指纹 pin 策略（同 osc133_spike）。
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

/// 一条 PTY 会话：连接 → open_pty → request_shell → 后台任务把原始输出
/// 追加进共享缓冲。`run_line` 发命令并等输出静默，返回本窗原始字节。
/// 关闭 = drop（连接断开，sshd 侧回收会话）。
struct Pty {
    raw: Arc<Mutex<Vec<u8>>>,
    writer: Box<dyn tokio::io::AsyncWrite + Unpin + Send>,
}

impl Pty {
    async fn open(session: &SshSession) -> Result<Self, String> {
        let mut channel = session
            .open_pty(120, 40)
            .await
            .map_err(|e| format!("open_pty: {e}"))?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("request_shell: {e}"))?;
        let raw: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let raw_bg = Arc::clone(&raw);
        let writer =
            Box::new(channel.make_writer()) as Box<dyn tokio::io::AsyncWrite + Unpin + Send>;
        tokio::spawn(async move {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let mut buf = raw_bg.lock().unwrap_or_else(|p| p.into_inner());
                        buf.extend_from_slice(&data);
                        let len = buf.len();
                        if len > RAW_CAP {
                            buf.drain(..len - RAW_CAP);
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => return,
                    _ => {}
                }
            }
        });
        Ok(Self { raw, writer })
    }

    /// 发一行命令，泵到输出静默，返回本窗原始字节。
    async fn run_line(&mut self, line: &str) -> Result<Vec<u8>, String> {
        let before = self.raw.lock().unwrap_or_else(|p| p.into_inner()).len();
        self.writer
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        self.writer
            .write_all(b"\r")
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        let deadline = tokio::time::Instant::now() + CMD_MAX;
        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(format!(
                    "timeout ({CMD_MAX:?}) waiting output to settle: {line:?}"
                ));
            }
            let len_now = self.raw.lock().unwrap_or_else(|p| p.into_inner()).len();
            tokio::time::sleep(IDLE).await;
            let len_after = self.raw.lock().unwrap_or_else(|p| p.into_inner()).len();
            if len_after == len_now {
                let buf = self.raw.lock().unwrap_or_else(|p| p.into_inner());
                return Ok(buf[before..].to_vec());
            }
        }
    }
}

/// 在原始字节里找 ASCII 子串（丢失偏移无所谓，marker 是 ASCII）。
fn find_sub(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

/// 供报告原样抄录的转义：U+FFFD 显式标注，其余控制字符 \\xNN。
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

/// 从命令窗提取 marker 之间的原始字节（gbk-echo 输出体）。
/// 注意：回显的命令行本身含 marker，故取**最后两次**出现（真正的输出对）。
fn extract_payload(window: &[u8]) -> Result<Vec<u8>, String> {
    let m = MARKER.as_bytes();
    let last = find_sub(window, m, 0).ok_or("marker not found in output window")?;
    let (mut last, mut prev) = match find_sub(window, m, last + m.len()) {
        Some(next) => (next, last),
        None => return Err("only one marker occurrence in output window".into()),
    };
    while let Some(next) = find_sub(window, m, last + m.len()) {
        prev = last;
        last = next;
    }
    let mut payload = window[prev + m.len()..last].to_vec();
    // 掐掉 marker 行两侧的换行（\r\n 或 \n；GBK 载荷本身无 \r/\n）。
    while matches!(payload.first(), Some(b'\n') | Some(b'\r')) {
        payload.remove(0);
    }
    while matches!(payload.last(), Some(b'\n') | Some(b'\r')) {
        payload.pop();
    }
    Ok(payload)
}

/// 场景 `gbk`：三段解码（简报 Step 2 的切换语义，headless 重解码同一字节流）。
fn scenario_gbk(window: &[u8]) -> Result<String, String> {
    let payload = extract_payload(window)?;
    let hex: Vec<String> = payload.iter().map(|b| format!("{b:02X}")).collect();
    println!("[gbk] payload: {} bytes [{}]", payload.len(), hex.join(" "));
    if payload != EXPECTED_GBK {
        return Err(format!(
            "gbk-echo payload mismatch: got {} bytes, expected {} bytes (D6 D0 ...)",
            payload.len(),
            EXPECTED_GBK.len()
        ));
    }

    let mut dec = Decoder::default();
    let seg1 = dec.decode(&payload);
    println!(
        "[gbk] seg1 encoding={} dec=\"{}\"",
        dec.encoding().name(),
        escaped(&seg1)
    );

    dec.set_encoding(Encoding::Gbk);
    let seg2 = dec.decode(&payload);
    println!(
        "[gbk] seg2 encoding={} dec=\"{}\"",
        dec.encoding().name(),
        escaped(&seg2)
    );

    dec.set_encoding(Encoding::Utf8);
    let seg3 = dec.decode(&payload);
    println!(
        "[gbk] seg3 encoding={} dec=\"{}\"",
        dec.encoding().name(),
        escaped(&seg3)
    );

    println!("[gbk] verbatim seg1: {seg1}");
    println!("[gbk] verbatim seg2: {seg2}");
    println!("[gbk] verbatim seg3: {seg3}");

    let mut problems = Vec::new();
    if seg2 != EXPECTED_TEXT {
        problems.push(format!("seg2 (GBK) = {seg2:?}, expected {EXPECTED_TEXT:?}"));
    }
    if !seg1.contains('\u{FFFD}') {
        problems.push("seg1 (UTF-8 default) has no U+FFFD".into());
    }
    if seg1 == EXPECTED_TEXT || seg3 == EXPECTED_TEXT {
        problems.push("UTF-8 decode of GBK bytes unexpectedly equalled the CJK text".into());
    }
    if seg1 != seg3 {
        problems.push("seg1 != seg3 (switch back to UTF-8 must reproduce mojibake)".into());
    }
    if !problems.is_empty() {
        problems.push(format!(
            "raw window tail: {:?}",
            escaped(&String::from_utf8_lossy(
                &window[window.len().saturating_sub(512)..]
            ))
        ));
        return Err(problems.join("; "));
    }
    Ok(format!(
        "seg1(UTF-8)=\"{}\" -> seg2(GBK)=\"{EXPECTED_TEXT}\" -> seg3(UTF-8)=\"{}\"",
        escaped(&seg1),
        escaped(&seg3)
    ))
}

/// 取 LANG 探针命令窗里的 `LANG=<value>` 输出行。
/// 输出行常带前置转义序列（`\x1b[?2004l` 等），故在行内搜 `LANG=`；
/// 回显的命令行含未展开的 `$LANG`（带 `$`），据此排除。
fn extract_lang(window: &[u8]) -> Result<String, String> {
    let text = String::from_utf8_lossy(window);
    for line in text.lines() {
        if let Some(pos) = line.find("LANG=") {
            let rest = &line[pos + "LANG=".len()..];
            if !rest.contains('$') {
                return Ok(rest.trim_end_matches('\r').trim().to_string());
            }
        }
    }
    Err(format!(
        "no LANG= output line in window: {:?}",
        escaped(&text)
    ))
}

/// 连接并探针 `echo LANG=$LANG`，返回（LANG 值, detect_hint 结果）。
async fn probe_lang(policy: &HostKeyPolicy, tag: &str) -> Result<(String, Encoding), String> {
    eprintln!("[lang] connect ({tag})");
    let session = connect(
        HOST,
        PORT,
        USER,
        AuthMethod::Password(PASSWORD.into()),
        policy.clone(),
    )
    .await
    .map_err(|e| format!("connect: {e}"))?;
    let mut pty = Pty::open(&session).await?;
    let lang = extract_lang(&pty.run_line("echo LANG=$LANG").await?)?;
    let hint = Decoder::detect_hint(&lang);
    println!(
        "[lang] {tag}: echo $LANG = {lang:?} -> detect_hint = {} ({:?})",
        hint.name(),
        hint
    );
    Ok((lang, hint))
}

/// 场景 `lang`：LANG 检测提示（简报 Step 3）。
///
/// 实测基线与简报预期不同：夹具 PTY shell 的 `$LANG` 为**空**（debian-slim
/// 无 locale 配置），走 detect_hint 的 UTF-8 兜底；C.UTF-8 正例改用与 GBK
/// 相同的标记行注入机制真机验证。全程用完即弃，结束复核夹具不残留。
async fn scenario_lang() -> Result<String, String> {
    let (policy, pinned_fp) = pinned_host_key_policy();
    eprintln!("[lang] pinned {pinned_fp}");

    // 态 0：夹具基线。
    let (lang0, hint0) = probe_lang(&policy, "phase0 baseline").await?;
    if hint0 != Encoding::Utf8 {
        return Err(format!(
            "phase0: detect_hint({lang0:?}) = {hint0:?}, expected Utf8"
        ));
    }

    let mut connect_n = 1;
    let mut problems = Vec::new();

    // 一次性会话里追加一行标记 export（用完即弃，sed 按标记还原）。
    async fn inject_line(policy: &HostKeyPolicy, line: &str) -> Result<(), String> {
        let session = connect(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            policy.clone(),
        )
        .await
        .map_err(|e| format!("connect: {e}"))?;
        let mut pty = Pty::open(&session).await?;
        pty.run_line(line).await?;
        Ok(())
    }
    inject_line(
        &policy,
        &format!("echo 'export LANG=C.UTF-8 {LANG_TAG}' >> ~/.bashrc"),
    )
    .await?;
    let (lang1, hint1) = probe_lang(&policy, "phase1 C.UTF-8 injected").await?;
    connect_n += 2;
    if lang1 != "C.UTF-8" || hint1 != Encoding::Utf8 {
        problems.push(format!(
            "phase1: LANG={lang1:?} hint={hint1:?}, expected (\"C.UTF-8\", Utf8)"
        ));
    }

    // 态 2：注入 zh_CN.GBK → 重连。
    inject_line(
        &policy,
        &format!("echo 'export LANG=zh_CN.GBK {LANG_TAG}' >> ~/.bashrc"),
    )
    .await?;
    let (lang2, hint2) = probe_lang(&policy, "phase2 zh_CN.GBK injected").await?;
    connect_n += 2;
    if lang2 != "zh_CN.GBK" || hint2 != Encoding::Gbk {
        problems.push(format!(
            "phase2: LANG={lang2:?} hint={hint2:?}, expected (\"zh_CN.GBK\", Gbk)"
        ));
    }

    // 还原（在态 2 会话里删光标记行并复核）。
    {
        let session = connect(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            policy.clone(),
        )
        .await
        .map_err(|e| format!("connect: {e}"))?;
        let mut pty = Pty::open(&session).await?;
        pty.run_line(&format!("sed -i '/{LANG_TAG}/d' ~/.bashrc"))
            .await?;
        let check = pty
            .run_line(&format!("grep -c '{LANG_TAG}' ~/.bashrc || echo CLEAN"))
            .await?;
        if !String::from_utf8_lossy(&check).contains("CLEAN") {
            problems.push(format!(".bashrc still contains {LANG_TAG:?} after revert"));
        }
    }
    connect_n += 1;

    // 态 3：还原后重连复核，夹具回到基线。
    let (lang3, _hint3) = probe_lang(&policy, "phase3 after revert").await?;
    connect_n += 1;
    if lang3 != lang0 {
        problems.push(format!(
            "phase3: LANG={lang3:?}, expected baseline {lang0:?} (fixture polluted?)"
        ));
    }
    eprintln!("[lang] total fresh sessions this scenario: {connect_n}");

    if !problems.is_empty() {
        return Err(problems.join("; "));
    }
    Ok(format!(
        "baseline {lang0:?}(empty)->UTF-8 fallback; C.UTF-8->UTF-8; zh_CN.GBK->GBK; reverted {lang3:?}->UTF-8 (fixture clean)"
    ))
}

#[tokio::main]
async fn main() {
    let scenario = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    let mut failures: Vec<String> = Vec::new();

    if matches!(scenario.as_str(), "gbk" | "all") {
        let (policy, pinned_fp) = pinned_host_key_policy();
        let result = async {
            eprintln!("[gbk] connect (pinned {pinned_fp})");
            let session = connect(
                HOST,
                PORT,
                USER,
                AuthMethod::Password(PASSWORD.into()),
                policy,
            )
            .await
            .map_err(|e| format!("connect: {e}"))?;
            let mut pty = Pty::open(&session).await?;
            pty.run_line("true").await?; // 首窗吃掉 banner/提示符
            let window = pty
                .run_line(&format!("echo {MARKER}; gbk-echo; echo {MARKER}"))
                .await?;

            scenario_gbk(&window)
        }
        .await;
        match result {
            Ok(summary) => eprintln!("[PASS] gbk: {summary}"),
            Err(err) => {
                eprintln!("[FAIL] gbk: {err}");
                failures.push(format!("gbk: {err}"));
            }
        }
    }

    if matches!(scenario.as_str(), "lang" | "all") {
        match scenario_lang().await {
            Ok(summary) => eprintln!("[PASS] lang: {summary}"),
            Err(err) => {
                eprintln!("[FAIL] lang: {err}");
                failures.push(format!("lang: {err}"));
            }
        }
    }

    if failures.is_empty() {
        eprintln!("[PASS] scenario={scenario}: all assertions green");
    } else {
        eprintln!(
            "[FAIL] scenario={scenario}: {} failing part(s)",
            failures.len()
        );
        std::process::exit(1);
    }
}
