//! 会话录制真夹具端到端（Phase 3 Task 5 Step 4，简报裁定 #4 完整链）：
//! **真 ottr-sshd 容器**（2222，spike@127.0.0.1 / spike-pass）真 PTY 真交互——
//! open_pty + request_shell + 转发循环（生产同参调用，录制槽位挂真实
//! RecordingHandle）→ 逐条下发 3 条命令 → 循环收尾 auto-finalize（生产接线
//! 同一函数）→ 断言全链：
//!
//! 1. **文件存在**（recordings/ 目录、0600）；
//! 2. **格式合法**（ottr-term parse：v2 header + 3 命令输出逐条在事件流里，
//!    ANSI/OSC 原样保留——回放还原屏幕的前提）；
//! 3. **回放可见**（read_recording：header/事件/duration 全量出库；
//!    export_recording 重编码出的原文/脱敏两版都是合法 v2——前端 redact 面
//!    由 vitest 覆盖，这里锁 Rust 侧导出核）；
//! 4. **FTS 搜到**（Recordings::search 命中 3 命令关键字 + CJK 混排）；
//! 5. **录制开关不影响终端流纯净性**（T8 纪律：tee 开着，同批字节仍全部到达
//!    前端面捕获通道）。
//!
//! 夹具不可达即 SKIP（batch_fixture 同纪律）。硬超时纪律：连接/建通道/等输出
//! 全部带 deadline。start/stop 命令核的会话表路径（no-such-session 等）由 lib
//! 单测覆盖——本测试持真实 handle（SessionEntry 是 pub(crate) 面，外部测试
//! 不可构造），tee/收尾/入库与生产同函数同参数。
//!
//! Run: `cargo test -p ottr --test recording_fixture`
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use ottr_lib::{
    auto_finalize_on_exit, export_recording, forward_pty_loop, read_recording, ExportEvent,
    RecorderSlot, RecordingHandle, SessionCloseReason, SessionCounters, TextTail,
};
use ottr_ssh::{connect, AuthMethod, HostKeyPolicy};
use ottr_term::encoding::{Encoding, StreamDecoder};
use ottr_vault::{HostInput, Hosts, Recordings, Vault};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";

/// 3 条录制命令（输出可精确断言；第 3 条带 CJK + 单引号，压 FTS 分词与转义）。
const COMMANDS: [&str; 3] = [
    "echo ottr-rec-one",
    "echo ottr-rec-two-42",
    "echo 'ottr-录三-三'",
];

async fn fixture_up() -> bool {
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect((HOST, PORT)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

/// 夹具指纹 pin（fixtures/known_hosts 对应端点行的 SHA256 指纹）。
fn pinned_host_key_policy() -> HostKeyPolicy {
    let content = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/known_hosts"
    ))
    .expect("read fixtures/known_hosts（先跑 scripts/spike-sshd.sh）");
    let marker = format!("[{HOST}]:{PORT}");
    let base64_key = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .expect("known_hosts has entry for fixture endpoint")
        .split_whitespace()
        .nth(2)
        .expect("known_hosts line has base64 column")
        .to_string();
    let blob = base64::engine::general_purpose::STANDARD
        .decode(&base64_key)
        .expect("decode pinned key");
    use sha2::Digest;
    let digest = sha2::Sha256::digest(&blob);
    let expected = format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD
            .encode(digest)
            .trim_end_matches('=')
    );
    Arc::new(move |fingerprint: &str| fingerprint == expected)
}

#[tokio::test(flavor = "multi_thread")]
async fn recording_full_chain_fixture() {
    if !fixture_up().await {
        println!("SKIP recording_full_chain_fixture: fixture down —— 先跑 scripts/spike-sshd.sh");
        return;
    }
    let session = tokio::time::timeout(
        Duration::from_secs(15),
        connect(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
        ),
    )
    .await
    .expect("connect within 15s")
    .expect("connect fixture");

    // 生产 register_opened 同款：open_pty(10s) → request_shell(10s)；写端在
    // channel 进转发循环前摘出（register_opened 同序）。
    let mut channel = tokio::time::timeout(Duration::from_secs(10), session.open_pty(80, 24))
        .await
        .expect("open_pty within 10s")
        .expect("open_pty");
    tokio::time::timeout(Duration::from_secs(10), channel.request_shell(true))
        .await
        .expect("request_shell within 10s")
        .expect("request_shell");
    let mut writer = channel.make_writer();

    // vault + 录制目录（tempdir；生产 = app 数据目录 recordings/）。
    let vault_dir = tempfile::tempdir().expect("vault dir");
    let vault = Vault::open_with(
        vault_dir.path(),
        &ottr_vault::master_key::InMemoryStorage::new(),
    )
    .expect("open vault");
    let host_id = Hosts::create(
        &vault,
        HostInput {
            name: "web-01".into(),
            group_id: None,
            tags: vec![],
            address: HOST.into(),
            port: PORT as i64,
            username: Some(USER.into()),
            protocol: ottr_vault::HostProtocol::Ssh,
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            is_production: false,
            notes: None,
        },
    )
    .expect("create host")
    .id;
    let rec_dir = vault_dir.path().join("recordings");
    std::fs::create_dir_all(&rec_dir).expect("recordings dir");

    // 开录（RecordingHandle::start = recording_start 命令核的落文件面；0600 +
    // v2 header），handle 挂进转发循环的录制槽位（生产 SessionEntry.recorder
    // 同一挂法）。
    let cast_path = rec_dir.join("e2e.cast");
    let started = Instant::now();
    let handle = RecordingHandle::start(cast_path.clone(), 80, 24, host_id).expect("start");
    assert!(started.elapsed() < Duration::from_secs(5), "开录即时返回");
    let recorder: RecorderSlot = Arc::new(Mutex::new(Some(handle)));

    // 转发循环（生产同参）+ 前端面捕获通道。
    let captured: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&captured);
    let chan = tauri::ipc::Channel::new(move |body: tauri::ipc::InvokeResponseBody| {
        if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
            sink.lock().unwrap().extend_from_slice(&bytes);
        }
        Ok(())
    });
    // counters 进 Arc（fix round 1/5 M-6：循环退出后读数做 tee 字节账比对）。
    let counters = Arc::new(SessionCounters::default());
    let decoder = Mutex::new(StreamDecoder::new(Encoding::Utf8));
    let text_tail = TextTail::new();
    let cancel = Arc::new(tokio::sync::Notify::new());
    let cancel_loop = Arc::clone(&cancel);
    let loop_recorder = Arc::clone(&recorder);
    let loop_counters = Arc::clone(&counters);
    let loop_task = tokio::spawn(async move {
        forward_pty_loop(
            &mut channel,
            &chan,
            &loop_counters,
            &decoder,
            &text_tail,
            &loop_recorder,
            "rec-fixture",
            &cancel_loop,
            &ottr_lib::SessionResizeSlot::default(),
        )
        .await
    });

    // 等首提示符（banner + prompt 落定），再逐条下发 3 条命令；每条等输出到达
    // （有界等待，不靠固定 sleep 猜时长）。
    tokio::time::sleep(Duration::from_millis(1200)).await;
    for cmd in COMMANDS {
        use tokio::io::AsyncWriteExt;
        writer
            .write_all(format!("{cmd}\n").as_bytes())
            .await
            .expect("write command");
        let marker = cmd.trim_start_matches("echo ").trim_matches('\'');
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let guard = captured.lock().unwrap();
            let text = String::from_utf8_lossy(&guard);
            if text.contains(marker) {
                break;
            }
            drop(guard);
            assert!(
                Instant::now() < deadline,
                "timeout waiting for output of {cmd}"
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    // 尾部输出落定（末条命令的回显/换行进 tee 与转发面）。
    tokio::time::sleep(Duration::from_millis(700)).await;

    // 收尾：取消循环（drop_session 同款）→ auto-finalize（生产接线同函数）。
    cancel.notify_one();
    let reason = tokio::time::timeout(Duration::from_secs(10), loop_task)
        .await
        .expect("loop exits within 10s")
        .expect("loop task");
    assert_eq!(reason, SessionCloseReason::Cancelled);
    auto_finalize_on_exit(&recorder, Some(&vault));

    // --- 断言 1：文件存在、0600、目录里恰一个 .cast -------------------------
    let mut casts: Vec<_> = std::fs::read_dir(&rec_dir)
        .expect("read recordings dir")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "cast").unwrap_or(false))
        .collect();
    assert_eq!(casts.len(), 1, "恰一个录制文件");
    let cast_path = casts.pop().unwrap();

    // --- 断言 2：格式合法（v2 解析 + 3 命令输出在事件流、回显原样）-----------
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&cast_path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "录制文件 0600");
    }
    let raw = std::fs::read_to_string(&cast_path).expect("read cast");
    let rec = ottr_term::asciinema::parse(&raw).expect("valid asciinema v2");
    assert_eq!(rec.header.version, 2);
    assert_eq!(rec.header.width, 80);
    assert_eq!(rec.header.height, 24);
    let all_output: String = rec.events.iter().map(|e| e.data.as_str()).collect();
    for cmd in COMMANDS {
        let marker = cmd.trim_start_matches("echo ").trim_matches('\'');
        assert!(
            all_output.contains(marker),
            "事件流缺命令输出 {marker:?}——tee 丢字节"
        );
    }
    assert!(
        all_output.contains("echo ottr-rec-one"),
        "命令回显应原样在流里（回放还原屏幕的前提）"
    );
    assert!(rec.duration() > 0.0);

    // --- 断言 3：录制不影响终端流纯净性（同批字节全部到达前端面）------------
    let forwarded = String::from_utf8_lossy(&captured.lock().unwrap()).into_owned();
    for cmd in COMMANDS {
        let marker = cmd.trim_start_matches("echo ").trim_matches('\'');
        assert!(
            forwarded.contains(marker),
            "前端面缺 {marker:?}——tee 侵占转发"
        );
    }
    // 字节账比对（fix round 1/5 M-6）：转发言账一致（forwarded_bytes == 实收
    // 捕获通道字节），且 tee 面与转发面同源同量（录制事件数据总字节 ==
    // forwarded_bytes——录制覆盖全程，tee 无丢批时两者必须严格相等）。
    let stats = ottr_lib::snapshot(&counters);
    assert_eq!(
        stats.forwarded_bytes as usize,
        captured.lock().unwrap().len(),
        "转发言账失衡——字节在计数与 IPC 通道之间丢失"
    );
    let recorded_total: usize = rec.events.iter().map(|e| e.data.len()).sum();
    assert_eq!(
        recorded_total, stats.forwarded_bytes as usize,
        "tee 面与转发面不同量——tee 侵占或丢批"
    );

    // --- 断言 4：入库行 + FTS 搜到（ASCII / 数字 / CJK 子串）----------------
    let rows = Recordings::list(&vault, Some(host_id), 10).expect("list");
    assert_eq!(rows.len(), 1, "auto-finalize 入库恰一行");
    let entry = &rows[0];
    assert_eq!(entry.path, cast_path.to_string_lossy());
    assert_eq!(
        entry.text_index_path,
        format!("recordings_fts:{}", entry.id)
    );
    for query in ["ottr-rec-one", "ottr-rec-two-42", "录三"] {
        let hits = Recordings::search(&vault, query, None, 10).expect("search");
        assert_eq!(hits.len(), 1, "FTS 未命中: {query}");
        assert_eq!(hits[0].entry.id, entry.id);
        assert!(!hits[0].snippet.contains('\x1b'), "索引面是剥离文本");
    }

    // --- 断言 5：回放取数核 + 导出核（原文/脱敏重编码都是合法 v2）------------
    let data = read_recording(&vault, entry.id).expect("read_recording");
    assert_eq!(data.header.width, 80);
    assert_eq!(data.events.len(), rec.events.len());
    assert_eq!(data.duration, rec.duration());

    let events: Vec<ExportEvent> = data
        .events
        .iter()
        .map(|e| ExportEvent {
            time: e.time,
            data: e.data.clone(),
        })
        .collect();

    // 原文导出：事件流逐条原样（header 保真）。
    let out_raw = vault_dir.path().join("export-raw.cast");
    let raw_path = export_recording(
        &vault,
        vault_dir.path(),
        None,
        entry.id,
        events.clone(),
        Some(out_raw.to_string_lossy().into_owned()),
    )
    .expect("export raw");
    let raw_rec = ottr_term::asciinema::parse(&std::fs::read_to_string(raw_path).unwrap())
        .expect("exported raw is valid v2");
    assert_eq!(raw_rec.events, rec.events, "原文导出事件流零损耗");
    assert_eq!(raw_rec.header.width, 80);

    // 「脱敏导出」Rust 侧核：生产里事件流先经前端 redact（T13；vitest 覆盖），
    // 这里用等价替换模拟脱敏后的事件流，导出件仍合法 v2 且不含原词。
    let redacted: Vec<ExportEvent> = data
        .events
        .iter()
        .map(|e| ExportEvent {
            time: e.time,
            data: e.data.replace(&format!("{USER}@"), "[REDACTED]@"),
        })
        .collect();
    let out_red = vault_dir.path().join("export-red.cast");
    export_recording(
        &vault,
        vault_dir.path(),
        None,
        entry.id,
        redacted,
        Some(out_red.to_string_lossy().into_owned()),
    )
    .expect("export redacted");
    let red_rec = ottr_term::asciinema::parse(&std::fs::read_to_string(out_red).unwrap())
        .expect("exported redacted is valid v2");
    assert!(
        red_rec
            .events
            .iter()
            .all(|e| !e.data.contains(&format!("{USER}@"))),
        "脱敏导出不含原 host 前缀"
    );
    assert!(
        red_rec
            .events
            .iter()
            .any(|e| e.data.contains("[REDACTED]@")),
        "脱敏导出带占位符"
    );

    // 会话收尾（生产断开纪律：Handle::drop 不关连接，必须显式断）。
    let _ = session.disconnect().await;
}
