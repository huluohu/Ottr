//! 会话录制命令域（Phase 3 Task 5，B3 录制审计回放）：录制开关 → asciinema
//! v2 落盘（vault 数据目录 recordings/，0600）→ 停止时入库（0015 recordings +
//! recordings_fts 文本索引）+ 回放取数（recording_read）/检索/删除/导出。
//!
//! 【tee 挂接】转发循环（flush_batch）在解码后、IPC 前把文本**副本**交给
//! [`RecordingHandle`]（与前端 xterm 同源字节——回放还原的屏幕 = 用户当时看到
//! 的屏幕，GBK 会话回放同样正确）。tee 是 `try_send` 非阻塞副本：队列满/通道
//! 断 = 丢该批（dropped 计数 finalize 留痕），转发热路径零等待，终端流纯净性
//! 不受录制开关影响（T8 纪律——录不录，字节账面一个样）。
//!
//! 【安全面】录制含终端全量输出（含盲输的密码回显面），默认**不**自动开启
//! （会话级开关，Terminal 工具栏按钮）；键入方向（"i"）永不录制；文件 0600
//! （创建即收紧，finalize 复紧）；导出分享默认经前端 redact（T13 引擎），
//! 原文导出需显式二次确认（前端职责，本域只管把 events 重编码成合法 v2）。
//!
//! 锁定语义：recordings 是明文面（0007 history 同一裁定，0015 迁移文件头），
//! 全部命令不过 ensure_unlocked 门卫——录制是会话进行中的落盘，自动锁定不能
//! 让它半途丢账。
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ottr_term::asciinema::{event_line, parse, CastError, CastEvent, CastHeader, CastRecording};
use ottr_vault::{Hosts, RecordingEntry, RecordingHit, RecordingInput, Recordings, Vault};

use super::state::SessionMap;
use crate::vault::VaultState;

/// tee 队列容量（批上限 256KB × 64 ≈ 16MB 洪峰缓冲；满即丢批不阻塞转发）。
const CHANNEL_CAP: usize = 64;
/// FTS 索引文本上限（剥离后纯文本；防 `yes` 类洪流把库撑爆，录制文件本体不设限）。
const TEXT_CAP: usize = 8 * 1024 * 1024;
/// recording_read 单次取文件上限（回放取数面防误传爆内存）。
const READ_CAP: u64 = 64 * 1024 * 1024;
/// 录制文件名序号（进程内单调，配合毫秒时间戳防碰撞）。
static RECORDING_SEQ: AtomicU64 = AtomicU64::new(0);

/// 会话表项里的录制器槽位（None = 未录制；命令域与转发循环共享）。
pub type RecorderSlot = Arc<Mutex<Option<RecordingHandle>>>;

/// 写盘线程的产出（finalize join 时回收）。
struct WorkerOutcome {
    /// 最后一个事件的相对秒（空录制 = 0）。
    duration: f64,
    /// 剥离 ANSI 后的录制纯文本（FTS 索引面；TEXT_CAP 截断）。
    text: String,
    /// 写盘 IO 错误（首错留痕；此后批次继续丢弃，不 panic 不阻塞）。
    error: Option<String>,
}

/// 进行中的录制（会话表项持有）。发送侧只做 `try_send`（零阻塞）；真正
/// 的编码/剥离/写盘都在独立 OS 线程（简报裁定：异步写盘不阻塞转发）。
/// pub = 夹具集成测试直驱面（tests/recording_fixture.rs；run_batch 同惯例）。
pub struct RecordingHandle {
    tx: Option<mpsc::SyncSender<(f64, Vec<u8>)>>,
    worker: Option<std::thread::JoinHandle<WorkerOutcome>>,
    path: PathBuf,
    host_id: i64,
    started: Instant,
    /// tee 丢弃的批数（队列满/接收端已停）——finalize 时留痕日志。
    dropped: Arc<AtomicU64>,
}

impl RecordingHandle {
    /// 起一个录制：创建 0600 文件 + 写 v2 header + 起写盘线程。
    pub fn start(path: PathBuf, cols: u16, rows: u16, host_id: i64) -> std::io::Result<Self> {
        let mut file = std::fs::File::create(&path)?;
        restrict_permissions(&path);
        writeln!(
            file,
            "{}",
            CastHeader::new(cols as u32, rows as u32, unix_now()).header_line()
        )?;
        let (tx, rx) = mpsc::sync_channel::<(f64, Vec<u8>)>(CHANNEL_CAP);
        let dropped = Arc::new(AtomicU64::new(0));
        let dropped_for_worker = Arc::clone(&dropped);
        let worker = std::thread::Builder::new()
            .name("ottr-recording".into())
            .spawn(move || worker_loop(rx, file, dropped_for_worker))?;
        Ok(Self {
            tx: Some(tx),
            worker: Some(worker),
            path,
            host_id,
            started: Instant::now(),
            dropped,
        })
    }

    /// tee 一批解码后文本（转发热路径调用——try_send 满即丢，绝不等待）。
    pub fn send(&self, bytes: &[u8]) {
        let Some(tx) = self.tx.as_ref() else {
            return;
        };
        let elapsed = self.started.elapsed().as_secs_f64();
        if tx.try_send((elapsed, bytes.to_vec())).is_err() {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// 收尾：断开发送端（线程排空队列后退出）→ join → 复紧 0600。
    /// 返回（host_id, path, duration, text）供入库；调用方负责 `Recordings::insert`。
    pub fn finalize(mut self) -> (i64, PathBuf, f64, String) {
        self.tx.take(); // drop sender → worker recv 断开 → 排空退出
        let outcome = self
            .worker
            .take()
            .and_then(|h| h.join().ok())
            .unwrap_or(WorkerOutcome {
                duration: 0.0,
                text: String::new(),
                error: Some("recording worker panicked".into()),
            });
        restrict_permissions(&self.path);
        let dropped = self.dropped.load(Ordering::Relaxed);
        if dropped > 0 {
            eprintln!(
                "[recording] {} : {dropped} batch(es) dropped (tee queue full) — file shorter than session",
                self.path.display()
            );
        }
        if let Some(e) = &outcome.error {
            eprintln!("[recording] {} : io error: {e}", self.path.display());
        }
        (self.host_id, self.path, outcome.duration, outcome.text)
    }
}

/// 写盘线程：逐批编码 v2 事件行 + Stripper 副本收纯文本（TEXT_CAP 截断）。
/// sender 断开（finalize）或首错后，把队列排空语义转为：sender 断开才退出；
/// IO 首错置 error 后丢弃后续批次（盘满等场景不烧 CPU）。
fn worker_loop(
    rx: mpsc::Receiver<(f64, Vec<u8>)>,
    mut file: std::fs::File,
    dropped: Arc<AtomicU64>,
) -> WorkerOutcome {
    use ottr_term::stripper::{Stripper, TextSink};

    struct TextAcc {
        text: String,
        capped: bool,
    }
    impl TextSink for TextAcc {
        fn text(&mut self, s: &str) {
            if self.capped {
                return;
            }
            if self.text.len() + s.len() > TEXT_CAP {
                self.capped = true;
                return;
            }
            self.text.push_str(s);
        }
    }

    let mut stripper = Stripper::new();
    let mut acc = TextAcc {
        text: String::new(),
        capped: false,
    };
    let mut duration = 0.0f64;
    let mut error: Option<String> = None;
    for (t, bytes) in rx {
        // 与文件事件行同口径（{:.6} 微秒量化）——入库 duration == 回放解析
        // duration，⌘R/回放的时间轴不会差亚微秒尾巴。
        duration = (t * 1.0e6).round() / 1.0e6;
        if error.is_some() {
            continue; // 盘已报错：丢批保活（计数照走，语义=文件截断）
        }
        stripper.feed(&bytes, &mut acc);
        let data = String::from_utf8_lossy(&bytes);
        if let Err(e) = writeln!(file, "{}", event_line(t, &data)) {
            error = Some(e.to_string());
            dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
    stripper.finish(&mut acc);
    let _ = file.flush();
    WorkerOutcome {
        duration,
        text: acc.text,
        error,
    }
}

/// 文件权限收紧 0600（unix；Windows ACL 语义不同，no-op 同 restrict_db_permissions 口径）。
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
            eprintln!("[recording] chmod 0600 failed ({}): {e}", path.display());
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ---------------------------------------------------------------------------
// 命令核（可测面：不持 State，会话表/目录/vault 由调用方给）
// ---------------------------------------------------------------------------

/// 录制起点核：会话在线 → host 存在 → 未在录 → 起 handle 入会话槽位。
/// 返回落盘路径。录制目录不存在则创建（0700 语义由 app 数据目录继承）。
pub(crate) fn start_recording_on(
    sessions: &SessionMap,
    dir: &Path,
    vault: &Vault,
    rust_id: &str,
    host_id: i64,
) -> Result<PathBuf, String> {
    let slot = {
        let sessions = sessions.lock().unwrap();
        let entry = sessions
            .get(rust_id)
            .ok_or_else(|| format!("no such session: {rust_id}"))?;
        if entry.recorder.lock().unwrap().is_some() {
            return Err(format!("session {rust_id} is already recording"));
        }
        Arc::clone(&entry.recorder)
    };
    if Hosts::get(vault, host_id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err(format!("host id={host_id} not found"));
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("create recordings dir: {e}"))?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let seq = RECORDING_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("rec-{ms}-{seq:04}.cast"));
    let (cols, rows) = {
        let sessions = sessions.lock().unwrap();
        sessions
            .get(rust_id)
            .map(|e| (e.cols, e.rows))
            .ok_or_else(|| format!("no such session: {rust_id}"))?
    };
    let handle = RecordingHandle::start(path.clone(), cols, rows, host_id)
        .map_err(|e| format!("create recording file: {e}"))?;
    *slot.lock().unwrap() = Some(handle);
    Ok(path)
}

/// 录制收尾核：从会话槽位取 handle → finalize → 入库（recordings + FTS）。
pub(crate) fn stop_recording_on(
    sessions: &SessionMap,
    vault: &Vault,
    rust_id: &str,
) -> Result<RecordingEntry, String> {
    let slot = {
        let sessions = sessions.lock().unwrap();
        let entry = sessions
            .get(rust_id)
            .ok_or_else(|| format!("no such session: {rust_id}"))?;
        Arc::clone(&entry.recorder)
    };
    let Some(handle) = slot.lock().unwrap().take() else {
        return Err(format!("session {rust_id} is not recording"));
    };
    insert_finalized(vault, handle)
}

/// finalize + 入库共用尾段（stop 命令与转发循环退出自动收尾同一路径）。
pub(crate) fn insert_finalized(
    vault: &Vault,
    handle: RecordingHandle,
) -> Result<RecordingEntry, String> {
    let (host_id, path, duration, text) = handle.finalize();
    Recordings::insert(
        vault,
        &RecordingInput {
            host_id,
            path: path.to_string_lossy().into_owned(),
            duration,
            text: Some(text),
        },
    )
    .map_err(|e| e.to_string())
}

/// 循环退出自动收尾（register_opened 与夹具测试共用）：会话消亡（断线/关标签）
/// 时录制自动保存——审计痕迹不随连接死亡丢失。无 vault 可入库（spike 面
/// close_event=None）时只落文件留日志。
pub fn auto_finalize_on_exit(slot: &RecorderSlot, vault: Option<&Vault>) {
    let Some(handle) = slot.lock().unwrap().take() else {
        return;
    };
    match vault {
        Some(v) => match insert_finalized(v, handle) {
            Ok(entry) => eprintln!(
                "[recording] auto-saved on session exit: {} (id={}, {:.3}s)",
                entry.path, entry.id, entry.duration
            ),
            Err(e) => eprintln!("[recording] auto-save insert failed: {e}"),
        },
        None => {
            let (_, path, duration, _) = handle.finalize();
            eprintln!(
                "[recording] finalized without vault (no ui_face): {path:?} ({duration:.3}s)"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 回放/检索/导出命令面
// ---------------------------------------------------------------------------

/// recording_read 载荷（serde snake_case，与 api.ts `RecordingData` 同构）。
#[derive(serde::Serialize)]
pub struct RecordingData {
    pub entry: RecordingEntry,
    pub header: CastHeader,
    pub events: Vec<CastEvent>,
    pub duration: f64,
}

/// 导出事件（前端脱敏/原文选择后回传的事件流；Rust 侧重编码保证合法 v2）。
/// pub = 夹具集成测试面（ExportEvent 复用为导出核入参）。
#[derive(serde::Deserialize, Clone)]
pub struct ExportEvent {
    pub time: f64,
    pub data: String,
}

/// 回放取数：读 .cast 文件（上限 [`READ_CAP`]）→ ottr-term 解析（v2 合法性
/// 校验即在此）→ header/events/duration 全量给前端回放器。
pub fn read_recording(vault: &Vault, id: i64) -> Result<RecordingData, String> {
    let entry = Recordings::get(vault, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("recording id={id} not found"))?;
    let bytes = std::fs::read(&entry.path).map_err(|e| format!("read {}: {e}", entry.path))?;
    if bytes.len() as u64 > READ_CAP {
        return Err(format!(
            "recording file too large ({} bytes > {READ_CAP})",
            bytes.len()
        ));
    }
    let text = String::from_utf8(bytes).map_err(|_| "recording file is not utf-8".to_string())?;
    let rec: CastRecording = parse(&text).map_err(|e: CastError| e.to_string())?;
    let duration = rec.duration();
    Ok(RecordingData {
        entry,
        header: rec.header,
        events: rec.events,
        duration,
    })
}

/// 导出核：以**存档文件的 header**（原始宽高/时间戳）+ 前端给定的（可脱敏）
/// 事件流重编码 v2，写入目标路径（缺省 = 下载目录 ottr-recording-{id}.cast，
/// download_dir 不可用退 app 数据目录）。返回落盘路径。文件 0600。
pub fn export_recording(
    vault: &Vault,
    app_dir: &Path,
    download_dir: Option<PathBuf>,
    id: i64,
    events: Vec<ExportEvent>,
    path: Option<String>,
) -> Result<String, String> {
    let entry = Recordings::get(vault, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("recording id={id} not found"))?;
    // header 取自原档（宽高/时间戳保真）；原档不可读则按元数据兜底重建
    let header = std::fs::read(&entry.path)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|t| parse(&t).ok())
        .map(|r| r.header)
        .unwrap_or_else(|| CastHeader::new(80, 24, entry.created_at));
    let rec = CastRecording {
        header,
        events: events
            .into_iter()
            .map(|e| CastEvent {
                time: e.time,
                data: e.data,
            })
            .collect(),
    };
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => download_dir
            .unwrap_or_else(|| app_dir.to_path_buf())
            .join(format!("ottr-recording-{id}.cast")),
    };
    std::fs::write(&target, rec.encode())
        .map_err(|e| format!("write {}: {e}", target.display()))?;
    restrict_permissions(&target);
    Ok(target.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Tauri 命令（薄封装：目录解析 + State 拆包）
// ---------------------------------------------------------------------------

/// 录制目录 = app 数据目录 recordings/ 子目录（简报裁定；0700 继承自父目录）。
fn recordings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager as _;
    app.path()
        .app_data_dir()
        .map(|d| d.join("recordings"))
        .map_err(|e| format!("resolve app data dir: {e}"))
}

/// 开录（Terminal 工具栏按钮）。`host_id` 由前端会话表给出（录制归属主机）。
#[tauri::command]
pub(crate) fn recording_start(
    state: tauri::State<'_, crate::commands::state::AppState>,
    vault: tauri::State<'_, VaultState>,
    app: tauri::AppHandle,
    rust_id: String,
    host_id: i64,
) -> Result<String, String> {
    let dir = recordings_dir(&app)?;
    start_recording_on(&state.sessions, &dir, &vault.0, &rust_id, host_id)
        .map(|p| p.to_string_lossy().into_owned())
}

/// 停录并入库（返回完整行——前端可提示「已保存 N 秒」）。
#[tauri::command]
pub(crate) fn recording_stop(
    state: tauri::State<'_, crate::commands::state::AppState>,
    vault: tauri::State<'_, VaultState>,
    rust_id: String,
) -> Result<RecordingEntry, String> {
    stop_recording_on(&state.sessions, &vault.0, &rust_id)
}

/// 最近录制（⌘R「录制」页签初始态）；`host_id` 缺省 = 跨主机。
#[tauri::command]
pub(crate) fn recording_list(
    vault: tauri::State<'_, VaultState>,
    host_id: Option<i64>,
    limit: Option<u32>,
) -> Result<Vec<RecordingEntry>, String> {
    Recordings::list(
        &vault.0,
        host_id,
        limit.unwrap_or(ottr_vault::RECORDINGS_SEARCH_LIMIT as u32) as usize,
    )
    .map_err(|e| e.to_string())
}

/// 全文检索（≥3 字符 FTS trigram / 超短 LIKE 兜底，Rust 层分派）。
#[tauri::command]
pub(crate) fn recording_search(
    vault: tauri::State<'_, VaultState>,
    query: String,
    host_id: Option<i64>,
    limit: Option<u32>,
) -> Result<Vec<RecordingHit>, String> {
    Recordings::search(
        &vault.0,
        &query,
        host_id,
        limit.unwrap_or(ottr_vault::RECORDINGS_SEARCH_LIMIT as u32) as usize,
    )
    .map_err(|e| e.to_string())
}

/// 回放取数（v2 解析在 Rust 层，非法文件显式报错）。
#[tauri::command]
pub(crate) fn recording_read(
    vault: tauri::State<'_, VaultState>,
    id: i64,
) -> Result<RecordingData, String> {
    read_recording(&vault.0, id)
}

/// 删除录制（库行 + .cast 文件 best-effort；FTS 由触发器同清）。
#[tauri::command]
pub(crate) fn recording_delete(vault: tauri::State<'_, VaultState>, id: i64) -> Result<(), String> {
    let entry = Recordings::get(&vault.0, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("recording id={id} not found"))?;
    Recordings::delete(&vault.0, id).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::remove_file(&entry.path) {
        eprintln!("[recording] remove file failed ({}): {e}", entry.path);
    }
    Ok(())
}

/// 导出（前端已按需脱敏；Rust 侧只重编码 + 落盘 0600）。
#[tauri::command]
pub(crate) fn recording_export(
    vault: tauri::State<'_, VaultState>,
    app: tauri::AppHandle,
    id: i64,
    events: Vec<ExportEvent>,
    path: Option<String>,
) -> Result<String, String> {
    use tauri::Manager as _;
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("resolve app data dir: {e}"))?;
    let download_dir = app.path().download_dir().ok();
    export_recording(&vault.0, &app_dir, download_dir, id, events, path)
}

// ---------------------------------------------------------------------------
// 测试（tee 完整性 / finalize 入库 / 0600 / 导出重编码；无需 Tauri 运行时）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> Vault {
        let dir = tempfile::tempdir().unwrap();
        Vault::open_with(dir.path(), &ottr_vault::master_key::InMemoryStorage::new())
            .expect("open in-memory vault")
    }

    fn mk_host(v: &Vault) -> i64 {
        ottr_vault::Hosts::create(
            v,
            ottr_vault::HostInput {
                name: "web-01".into(),
                group_id: None,
                tags: vec![],
                address: "10.0.0.1".into(),
                port: 22,
                username: Some("spike".into()),
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
        .unwrap()
        .id
    }

    /// tee → finalize 全链：send 的字节按序编码为 v2 事件、duration=末事件、
    /// 剥离文本进 FTS（检索命中）、文件 0600。
    #[test]
    fn tee_finalize_persists_searchable_v2_file() {
        let v = vault();
        let host_id = mk_host(&v);
        let dir = tempfile::tempdir().unwrap();
        let rec_dir = dir.path().join("recordings");
        std::fs::create_dir_all(&rec_dir).unwrap();
        let path = rec_dir.join("x.cast");
        let handle = RecordingHandle::start(path.clone(), 100, 30, host_id).unwrap();
        handle.send(b"\x1b]133;A\x07root@web:~$ ");
        handle.send(b"echo \xe9\x83\xa8\xe7\xbd\xb2"); // 部署（UTF-8）
        handle.send(b"\r\ndone\r\n");
        let (hid, fpath, duration, text) = handle.finalize();
        assert_eq!(hid, host_id);
        assert_eq!(fpath, path);
        assert!(duration > 0.0, "末事件时间推进");
        // 文件 v2 合法：header + 3 事件，输出原文（含 OSC/ANSI）逐批保序
        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed = parse(&raw).expect("v2 valid");
        assert_eq!(parsed.header.width, 100);
        assert_eq!(parsed.header.height, 30);
        assert_eq!(parsed.events.len(), 3);
        assert_eq!(parsed.events[1].data, "echo 部署");
        assert_eq!(parsed.duration(), duration);
        // FTS 面：剥离 ANSI 的纯文本入库可搜
        let entry = Recordings::insert(
            &v,
            &RecordingInput {
                host_id,
                path: path.to_string_lossy().into_owned(),
                duration,
                text: Some(text),
            },
        )
        .unwrap();
        let hits = Recordings::search(&v, "部署", Some(host_id), 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.id, entry.id);
        assert!(!hits[0].snippet.contains('\x1b'), "snippet 是剥离文本");
        // 0600
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "录制文件 0600");
        }
    }

    /// 空录制（开即停）：文件只有 header、duration 0、FTS 无行可搜、列表可见。
    #[test]
    fn empty_recording_still_finalizes() {
        let v = vault();
        let host_id = mk_host(&v);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("e.cast");
        let handle = RecordingHandle::start(path.clone(), 80, 24, host_id).unwrap();
        let (_, _, duration, text) = handle.finalize();
        assert_eq!(duration, 0.0);
        assert_eq!(text, "");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(parse(&raw).unwrap().events.len(), 0);
        let entry = Recordings::insert(
            &v,
            &RecordingInput {
                host_id,
                path: path.to_string_lossy().into_owned(),
                duration,
                text: Some(text),
            },
        )
        .unwrap();
        assert!(Recordings::search(&v, "", None, 10).unwrap().is_empty());
        assert_eq!(Recordings::list(&v, None, 10).unwrap(), vec![entry]);
    }

    /// start/stop 命令核对不存在会话的显式报错（空会话表）。
    #[test]
    fn start_stop_on_unknown_session_errors() {
        let v = vault();
        let sessions: SessionMap = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            start_recording_on(&sessions, dir.path(), &v, "ghost", 1).unwrap_err(),
            "no such session: ghost"
        );
        assert_eq!(
            stop_recording_on(&sessions, &v, "ghost").unwrap_err(),
            "no such session: ghost"
        );
    }

    /// 导出核：以原档 header + 给定事件流重编码（原文/脱敏都能出合法 v2）。
    #[test]
    fn export_reencodes_with_original_header() {
        let v = vault();
        let host_id = mk_host(&v);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("src.cast");
        let handle = RecordingHandle::start(path.clone(), 120, 40, host_id).unwrap();
        handle.send(b"password=hunter2 token=abc");
        handle.finalize();

        let out = dir.path().join("out.cast");
        let got = export_recording(
            &v,
            dir.path(),
            None,
            {
                let entry = Recordings::insert(
                    &v,
                    &RecordingInput {
                        host_id,
                        path: path.to_string_lossy().into_owned(),
                        duration: 1.0,
                        text: Some("password=hunter2".into()),
                    },
                )
                .unwrap();
                entry.id
            },
            vec![
                ExportEvent {
                    time: 0.0,
                    data: "password=[REDACTED_PASSWORD_1]".into(),
                },
                ExportEvent {
                    time: 0.5,
                    data: "\r\n".into(),
                },
            ],
            Some(out.to_string_lossy().into_owned()),
        )
        .unwrap();
        let parsed = parse(&std::fs::read_to_string(got).unwrap()).unwrap();
        assert_eq!(parsed.header.width, 120, "header 来自原档");
        assert_eq!(parsed.events.len(), 2);
        assert_eq!(parsed.events[0].data, "password=[REDACTED_PASSWORD_1]");
    }
}
