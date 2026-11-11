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
//!
//! 【退出收尾与孤儿归档（F-commands-2）】「审计痕迹不随连接死亡丢失」覆盖
//! 三种会话消亡形态：断线/关标签（转发循环收尾任务，register.rs/local_term.rs）、
//! **应用退出**（quit_app/托盘/⌘Q 全部 app.exit(0) 直杀，收尾任务来不及跑——
//! [`finalize_all_recordings_at_exit`] 在 lib.rs `RunEvent::Exit` 同步遍历两张
//! 会话表收尾；`AppHandle::restart()` 绕行道由 attach.rs 退出前显式补调）、
//! **强杀/断电**（任何进程内路径都无能为力——[`spawn_orphan_sweep`] 在下次
//! 启动扫 recordings/ 目录，把无库行的 .cast 流式重建元数据入库归档：
//! [`sweep_orphan_recordings`]，只归档不删除）。
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ottr_term::asciinema::{CastError, CastEvent, CastHeader, CastRecording, event_line, parse};
use ottr_vault::{Hosts, RecordingEntry, RecordingHit, RecordingInput, Recordings, Vault};

use super::state::SessionMap;
use crate::vault::VaultState;
use ottr_vault::settings::SETTING_RECORDING_SAVE_DIR;

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
    host_id: Option<i64>,
    started: Instant,
    /// tee 丢弃的批数（队列满/接收端已停）——finalize 时留痕日志。
    dropped: Arc<AtomicU64>,
}

impl RecordingHandle {
    /// 起一个录制：创建 0600 文件 + 写 v2 header + 起写盘线程。
    /// （fix round 1/5 M-2：`File::create` 以 0666&!umask 落盘再 chmod 收紧，
    /// 中间有宽权限窗口——改 `OpenOptions::mode(0o600)` 创建即按 0600 落盘，
    /// 原子收紧；finalize 的 restrict_permissions 保留作非 unix/兜底面。）
    pub fn start(
        path: PathBuf,
        cols: u16,
        rows: u16,
        host_id: Option<i64>,
    ) -> std::io::Result<Self> {
        let mut file = open_private_new(&path)?;
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
    pub fn finalize(mut self) -> (Option<i64>, PathBuf, f64, String) {
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

/// 剥离文本累计 sink（TEXT_CAP 截断）——写盘线程与孤儿扫描共用
/// （FTS 索引面口径一致：正常收尾与灾后归档检索命中的都是剥离纯文本）。
#[derive(Default)]
struct TextAcc {
    text: String,
    capped: bool,
}

impl ottr_term::stripper::TextSink for TextAcc {
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

/// 写盘线程：逐批编码 v2 事件行 + Stripper 副本收纯文本（TEXT_CAP 截断）。
/// sender 断开（finalize）或首错后，把队列排空语义转为：sender 断开才退出；
/// IO 首错置 error 后丢弃后续批次（盘满等场景不烧 CPU）。
fn worker_loop(
    rx: mpsc::Receiver<(f64, Vec<u8>)>,
    mut file: std::fs::File,
    dropped: Arc<AtomicU64>,
) -> WorkerOutcome {
    use ottr_term::stripper::Stripper;

    let mut stripper = Stripper::new();
    let mut acc = TextAcc::default();
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

/// 新建 0600 录制文件（unix：创建即按 0600 落盘，无宽权限窗口；`create_new`
/// 防碰撞误覆盖——文件名带毫秒+序号，撞名即报错安全侧）。非 unix：ACL 语义
/// 不同，普通创建 + restrict_permissions 兜底（同 restrict_db_permissions 口径）。
fn open_private_new(path: &Path) -> std::io::Result<std::fs::File> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
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
    local_sessions: &crate::commands::local_term::LocalTermMap,
    dir: &Path,
    vault: &Vault,
    rust_id: &str,
    host_id: Option<i64>,
) -> Result<PathBuf, String> {
    // 双表回退（2026-10-20 本地终端）：本地会话无主机行——host_id None =
    // 归属「本机」，跳过 Hosts::get 校验（0022 起 recordings.host_id 可空）。
    let slot = {
        let sessions = sessions.lock().unwrap();
        match sessions.get(rust_id) {
            Some(entry) => {
                if entry.recorder.lock().unwrap().is_some() {
                    return Err(format!("session {rust_id} is already recording"));
                }
                Some(Arc::clone(&entry.recorder))
            }
            None => None,
        }
    };
    let slot = match slot {
        Some(slot) => slot,
        None => {
            let local = local_sessions.lock().unwrap();
            let entry = local
                .get(rust_id)
                .ok_or_else(|| format!("no such session: {rust_id}"))?;
            if entry.recorder.lock().unwrap().is_some() {
                return Err(format!("session {rust_id} is already recording"));
            }
            Arc::clone(&entry.recorder)
        }
    };
    if let Some(host_id) = host_id
        && Hosts::get(vault, host_id)
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
        let ssh = sessions
            .lock()
            .unwrap()
            .get(rust_id)
            .map(|e| (e.cols, e.rows));
        match ssh {
            Some(size) => size,
            None => {
                let local = local_sessions.lock().unwrap();
                local
                    .get(rust_id)
                    .map(|e| (e.cols, e.rows))
                    .ok_or_else(|| format!("no such session: {rust_id}"))?
            }
        }
    };
    let handle = RecordingHandle::start(path.clone(), cols, rows, host_id)
        .map_err(|e| format!("create recording file: {e}"))?;
    *slot.lock().unwrap() = Some(handle);
    Ok(path)
}

/// 录制收尾核：从会话槽位取 handle → finalize → 入库（recordings + FTS）。
pub(crate) fn stop_recording_on(
    sessions: &SessionMap,
    local_sessions: &crate::commands::local_term::LocalTermMap,
    vault: &Vault,
    rust_id: &str,
) -> Result<RecordingEntry, String> {
    // 双表回退（本地终端同享录制停止）
    let slot = {
        let sessions = sessions.lock().unwrap();
        sessions.get(rust_id).map(|e| Arc::clone(&e.recorder))
    };
    let slot = match slot {
        Some(slot) => slot,
        None => {
            let local = local_sessions.lock().unwrap();
            local
                .get(rust_id)
                .map(|e| Arc::clone(&e.recorder))
                .ok_or_else(|| format!("no such session: {rust_id}"))?
        }
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

/// 应用退出收尾核（F-commands-2，lib.rs `RunEvent::Exit` 挂点 + attach.rs
/// restart 绕行道共用）：遍历 SSH 会话表与本地终端会话表的**全部**录制槽，
/// 逐个 [`auto_finalize_on_exit`]——quit_app/托盘退出/⌘Q 全部 `app.exit(0)`
/// 直杀，转发循环收尾任务与本地批量线程都不会再跑，进程退出时刻在录的
/// handle 只有在这里同步收尾才不丢（兑现 [`auto_finalize_on_exit`] 处
/// 「审计痕迹不随连接死亡丢失」的承诺对「应用退出」这一会话消亡形态同样成立）。
///
/// 幂等安全：槽 `take()` 的原子性保证与转发循环收尾任务/重复调用不双入库
/// （已自行收尾的会话槽位为空，此处 no-op）。返回清点的槽位数（含空槽）。
pub(crate) fn finalize_all_on_exit(
    sessions: &SessionMap,
    local_sessions: &crate::commands::local_term::LocalTermMap,
    vault: Option<&Vault>,
) -> usize {
    // 先清点后收尾：finalize（join 写盘线程 + SQLite 入库）是毫秒级阻塞面，
    // 绝不攥着会话表锁做——drop_session 等命令路径在同一把锁上。
    let mut slots = Vec::new();
    slots.extend(
        sessions
            .lock()
            .unwrap()
            .values()
            .map(|e| Arc::clone(&e.recorder)),
    );
    slots.extend(
        local_sessions
            .lock()
            .unwrap()
            .values()
            .map(|e| Arc::clone(&e.recorder)),
    );
    let count = slots.len();
    for slot in &slots {
        auto_finalize_on_exit(slot, vault);
    }
    count
}

/// Tauri 面封装：从 [`tauri::AppHandle`] 解析会话表与 vault（`try_state`——
/// vault 初始化失败的早期退出没有 VaultState，此时按「无库」口径落文件），
/// 转调 [`finalize_all_on_exit`]。调用点：lib.rs `RunEvent::Exit`（正常退出
/// 统一路）与 attach.rs `app_restart` 的 `AppHandle::restart()` 直杀路径
/// （restart 不经 run loop，Exit 不触发——2026-11-08 窗口状态记忆同款补丁点）。
pub(crate) fn finalize_all_recordings_at_exit(app: &tauri::AppHandle) {
    use tauri::Manager as _;

    let state = app.state::<crate::commands::state::AppState>();
    let vault = app.try_state::<VaultState>();
    let count = finalize_all_on_exit(
        &state.sessions,
        &state.local_sessions,
        vault.as_deref().map(|vs| vs.0.as_ref()),
    );
    if count > 0 {
        eprintln!("[recording] exit sweep checked {count} recorder slot(s)");
    }
}

// ---------------------------------------------------------------------------
// 启动孤儿归档兜底（F-commands-2 下半）：强杀/断电漏网的 .cast 入库归档
// ---------------------------------------------------------------------------

/// 孤儿归档安全窗：mtime 距今不足该值的 .cast 一律不碰。清扫跑在 vault 就绪
/// 后的后台线程，与「启动即连接 + 立即开录」存在理论竞态——新录制在停录前
/// 只有文件、没有库行，扫早了会把在录文件当孤儿重复归档。60s 窗口下竞态要求
/// 用户在启动后 60s 内完成连接并开录（文件 mtime ≥1s 的精度也一并被覆盖）；
/// 真孤儿来自已死进程、永不再写，晚一次启动归档即可，兜底语义允许收敛延迟。
const ORPHAN_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(60);

/// 孤儿归档核（可测面：不持 Tauri 状态；`min_age` 参数化供测试钉安全窗语义）。
/// 扫 dir 下全部 .cast，凡**无库行**且 mtime 早于 [`ORPHAN_MIN_AGE`] 的
/// （RunEvent::Exit 收尾对 SIGKILL/断电无能为力的漏网），按文件内容流式重建
/// 元数据入库归档——回到 UI 可见/可删/可检索的常态。返回归档条数。
///
/// 纪律：**只归档，不删除**。哪怕 header 都不完整的残档也入库（duration 0、
/// 无 FTS 文本，见 [`scan_cast_file`]），此后可经 recording_delete 由用户
/// 处置——清扫本身绝不销毁数据。已知边界：host_id 无法从文件名恢复，一律
/// None（0022 起可空，与本地终端录制同桶）；目录不存在（全新安装/重置后）
/// = 无孤儿可扫。
pub(crate) fn sweep_orphan_recordings(
    dir: &Path,
    vault: &Vault,
    min_age: std::time::Duration,
) -> usize {
    // 库行文件名集合（file_name 而非全路径对账——数据目录迁移后老行的路径
    // 前缀失配也不再误归档；rec-{ms}-{seq} 文件名进程内唯一，无歧义）。
    let known: std::collections::HashSet<String> = match Recordings::all_paths(vault) {
        Ok(paths) => paths
            .iter()
            .filter_map(|p| {
                Path::new(p)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
            })
            .collect(),
        Err(e) => {
            eprintln!("[recording] orphan sweep skipped (list db paths failed): {e}");
            return 0;
        }
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0; // 目录不存在 = 无孤儿可扫（非错误）
    };
    let now = SystemTime::now();
    let mut archived = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("cast") || !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if known.contains(&name) {
            continue;
        }
        // mtime 在未来（时钟回拨）按 0 龄处理 → 落进安全窗被跳过，安全侧。
        let age = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| now.duration_since(t).unwrap_or_default());
        let Ok(age) = age else {
            eprintln!(
                "[recording] orphan sweep: stat {} failed — skipped this run",
                path.display()
            );
            continue;
        };
        if age < min_age {
            continue; // 安全窗内：可能本进程在录，绝不碰
        }
        let (duration, text) = scan_cast_file(&path);
        let row = Recordings::insert(
            vault,
            &RecordingInput {
                host_id: None,
                path: path.to_string_lossy().into_owned(),
                duration,
                text,
            },
        );
        match row {
            Ok(row) => {
                archived += 1;
                restrict_permissions(&path); // finalize 同款复紧 0600（防外部改动过权限）
                eprintln!(
                    "[recording] orphan archived on startup: {} (id={}, {:.3}s)",
                    row.path, row.id, row.duration
                );
            }
            Err(e) => {
                eprintln!(
                    "[recording] orphan archive insert failed ({}): {e}",
                    path.display()
                );
            }
        }
    }
    archived
}

/// 流式扫一个 .cast 重建（duration, FTS 文本）：首行须为合法 v2 header；
/// 逐行取输出事件的时间与文本副本（Stripper 剥 ANSI、TEXT_CAP 截断）。
/// **不整档入内存**——孤儿录制可能很大（录制文件本体无上限，read 回放才有
/// READ_CAP），行级流式把内存钉在单行 + 文本上限。坏行（写入中途被杀的
/// 残行等）跳过、能救多少救多少——与 ottr-term parse 的「末行截断容忍」
/// 同语义。header 都不完整 → (0.0, None)（调用方仍归档：可见可删，不臆造
/// 元数据）。
fn scan_cast_file(path: &Path) -> (f64, Option<String>) {
    use ottr_term::stripper::Stripper;
    use std::io::{BufRead as _, BufReader};

    let Ok(file) = std::fs::File::open(path) else {
        eprintln!(
            "[recording] orphan scan open failed ({}) — archiving metadata only",
            path.display()
        );
        return (0.0, None);
    };
    let mut reader = BufReader::new(file);
    let mut header_line = String::new();
    match reader.read_line(&mut header_line) {
        Ok(0) | Err(_) => return (0.0, None), // 空文件/读失败：无从重建
        Ok(_) => {}
    }
    let header = serde_json::from_str::<CastHeader>(header_line.trim()).ok();
    match header {
        Some(h) if h.version == 2 => {}
        _ => return (0.0, None), // 非法 header（残档/他格式）：不臆造元数据
    }
    let mut stripper = Stripper::new();
    let mut acc = TextAcc::default();
    let mut duration = 0.0f64;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break, // EOF / 读失败：就此收档
            Ok(_) => {}
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 行级宽松：`[time,"o",data]` 之外（残行/中间损坏/非输出 kind）跳过。
        let ev = serde_json::from_str::<serde_json::Value>(trimmed).ok();
        let Some(arr) = ev.as_ref().and_then(|v| v.as_array()) else {
            continue;
        };
        let (Some(time), Some("o"), Some(data)) = (
            arr.first().and_then(|t| t.as_f64()),
            arr.get(1).and_then(|k| k.as_str()),
            arr.get(2).and_then(|d| d.as_str()),
        ) else {
            continue;
        };
        // 与 worker_loop 同口径（{:.6} 微秒量化）——归档行 duration 与回放
        // 解析 duration 一致。
        duration = (time * 1.0e6).round() / 1.0e6;
        stripper.feed(data.as_bytes(), &mut acc);
    }
    stripper.finish(&mut acc);
    let text = (!acc.text.is_empty()).then(|| std::mem::take(&mut acc.text));
    (duration, text)
}

/// 孤儿清扫挂点（lib.rs vault 就绪成功分支调用）：独立后台线程跑
/// [`sweep_orphan_recordings`]（best-effort——列目录/解析/入库失败只留日志，
/// 绝不影响启动链路）。vault 未就绪/初始化失败时本函数不被调，孤儿留待
/// 下次成功启动归档——兜底语义允许延迟收敛。
pub(crate) fn spawn_orphan_sweep(app: tauri::AppHandle) {
    use tauri::Manager as _;

    std::thread::Builder::new()
        .name("recording-orphan-sweep".into())
        .spawn(move || {
            let dir = crate::paths::data_root(&app).map(|d| d.join("recordings"));
            let Ok(dir) = dir else {
                eprintln!("[recording] orphan sweep skipped (no data root)");
                return;
            };
            let Some(vault_state) = app.try_state::<VaultState>() else {
                eprintln!("[recording] orphan sweep skipped (vault not managed)");
                return;
            };
            let archived = sweep_orphan_recordings(&dir, &vault_state.0, ORPHAN_MIN_AGE);
            if archived > 0 {
                eprintln!("[recording] orphan sweep archived {archived} recording(s)");
            }
        })
        .expect("spawn recording-orphan-sweep thread");
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
/// （fix round 1/5 M-3：先 `fs::metadata` 预检大小再读——`fs::read` 是读完后
/// 才看长度，超限文件已整个进了内存，预检让上限真正防爆内存。TOCTOU 窗口
/// （预检后文件变大）由解析端 UTF-8/大小共同兜底，属可接受余量。）
pub fn read_recording(vault: &Vault, id: i64) -> Result<RecordingData, String> {
    let entry = Recordings::get(vault, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("recording id={id} not found"))?;
    let size = std::fs::metadata(&entry.path)
        .map_err(|e| format!("stat {}: {e}", entry.path))?
        .len();
    if size > READ_CAP {
        return Err(format!(
            "recording file too large ({size} bytes > {READ_CAP})"
        ));
    }
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

/// 录制目录 = app 数据目录 recordings/ 子目录（简报裁定）。目录权限跟随
/// app 数据目录/umask，**不刻意收紧**（fix round 1/5 M-2 注释更正：原「0700
/// 继承」表述失准——目录名不敏感、敏感面在文件内容，文件本体创建即 0600
/// 原子收紧，见 `open_private_new`）。
fn recordings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    crate::paths::data_root(app).map(|d| d.join("recordings"))
}

/// 开录（Terminal 工具栏按钮）。`host_id` 由前端会话表给出（录制归属主机）。
#[tauri::command]
pub(crate) fn recording_start(
    state: tauri::State<'_, crate::commands::state::AppState>,
    vault: tauri::State<'_, VaultState>,
    app: tauri::AppHandle,
    rust_id: String,
    host_id: Option<i64>,
) -> Result<String, String> {
    let dir = recordings_dir(&app)?;
    start_recording_on(
        &state.sessions,
        &state.local_sessions,
        &dir,
        &vault.0,
        &rust_id,
        host_id,
    )
    .map(|p| p.to_string_lossy().into_owned())
}

/// 停录结果：库行 + 保存目录副本路径（未启用目录 = None）。
#[derive(serde::Serialize, specta::Type)]
pub struct RecordingStopOutcome {
    #[serde(flatten)]
    pub entry: RecordingEntry,
    /// 停录时按「录制默认保存目录」设置落盘的 .cast 副本（best-effort，失败 = None）。
    pub saved_path: Option<String>,
}

/// 停录并入库（返回完整行——前端可提示「已保存 N 秒」）；随后按
/// 「录制默认保存目录」设置将 .cast 副本落盘到用户可见目录
/// （未配置兜底 = 下载目录 Ottr 录制；副本失败不影响停录本身）。
#[tauri::command]
pub(crate) fn recording_stop(
    state: tauri::State<'_, crate::commands::state::AppState>,
    vault: tauri::State<'_, VaultState>,
    app: tauri::AppHandle,
    rust_id: String,
) -> Result<RecordingStopOutcome, String> {
    let entry = stop_recording_on(&state.sessions, &state.local_sessions, &vault.0, &rust_id)?;
    let saved_path = save_cast_copy(&vault.0, &app, &entry);
    Ok(RecordingStopOutcome { entry, saved_path })
}

/// 按「录制默认保存目录」设置把 .cast 副本复制到用户可见目录：
/// 设置 recording.saveDir 优先；未配置兜底 = 下载目录/Ottr 录制（建目录）。
/// 任何失败 = None（best-effort，不影响停录入库主链路）。
fn save_cast_copy(vault: &Vault, app: &tauri::AppHandle, entry: &RecordingEntry) -> Option<String> {
    use std::path::{Path, PathBuf};
    use tauri::Manager as _;

    let configured = ottr_vault::Settings::get_str(vault, SETTING_RECORDING_SAVE_DIR)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let dir: PathBuf = match configured {
        Some(d) => PathBuf::from(d),
        None => {
            let downloads = app.path().download_dir().ok()?;
            downloads.join("Ottr 录制")
        }
    };
    std::fs::create_dir_all(&dir).ok()?;
    let name = Path::new(&entry.path)
        .file_name()?
        .to_string_lossy()
        .into_owned();
    let target = dir.join(&name);
    std::fs::copy(&entry.path, &target).ok()?;
    Some(target.to_string_lossy().into_owned())
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
    let app_dir =
        crate::paths::data_root(&app).map_err(|e| format!("resolve app data dir: {e}"))?;
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
        let handle = RecordingHandle::start(path.clone(), 100, 30, Some(host_id)).unwrap();
        handle.send(b"\x1b]133;A\x07root@web:~$ ");
        handle.send(b"echo \xe9\x83\xa8\xe7\xbd\xb2"); // 部署（UTF-8）
        handle.send(b"\r\ndone\r\n");
        let (hid, fpath, duration, text) = handle.finalize();
        assert_eq!(hid, Some(host_id));
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
                host_id: Some(host_id),
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
        let handle = RecordingHandle::start(path.clone(), 80, 24, Some(host_id)).unwrap();
        let (_, _, duration, text) = handle.finalize();
        assert_eq!(duration, 0.0);
        assert_eq!(text, "");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(parse(&raw).unwrap().events.len(), 0);
        let entry = Recordings::insert(
            &v,
            &RecordingInput {
                host_id: Some(host_id),
                path: path.to_string_lossy().into_owned(),
                duration,
                text: Some(text),
            },
        )
        .unwrap();
        assert!(Recordings::search(&v, "", None, 10).unwrap().is_empty());
        assert_eq!(Recordings::list(&v, None, 10).unwrap(), vec![entry]);
    }

    /// start/stop 命令核对不存在会话的显式报错（SSH 表与本地表均空——
    /// 双表回退的两条都走到底才算收敛）。
    #[test]
    fn start_stop_on_unknown_session_errors() {
        let v = vault();
        let sessions: SessionMap = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let local: crate::commands::local_term::LocalTermMap =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            start_recording_on(&sessions, &local, dir.path(), &v, "ghost", Some(1)).unwrap_err(),
            "no such session: ghost"
        );
        assert_eq!(
            stop_recording_on(&sessions, &local, &v, "ghost").unwrap_err(),
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
        let handle = RecordingHandle::start(path.clone(), 120, 40, Some(host_id)).unwrap();
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
                        host_id: Some(host_id),
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

    // --- F-commands-2：应用退出收尾 + 启动孤儿归档 ---------------------------

    /// 退出收尾核（RunEvent::Exit 挂点共用）：本地会话在途录制被收尾入库、
    /// 槽位清空、重复调用幂等（与转发循环收尾任务的竞态面不双入库）。
    /// SSH 表单测无法构造（SessionEntry 持真连接句柄），但核的两表分支是
    /// 同一行 Arc clone——用真 PTY 本地会话（`cat` 假身，local_term 单测
    /// 同款）驱动同一核；SSH 分支由 tests/recording_fixture.rs 真容器链覆盖。
    #[cfg(unix)]
    #[test]
    fn finalize_all_on_exit_finalizes_local_session_recording() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        let local: crate::commands::local_term::LocalTermMap =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let on_data = Channel::new(|_: InvokeResponseBody| Ok(()));
        let id = crate::commands::local_term::local_term_open_with(
            Arc::clone(&local),
            None,
            Some("cat"),
            false,
            80,
            24,
            on_data,
        )
        .expect("open local term (cat)");

        let v = vault();
        let dir = tempfile::tempdir().unwrap();
        let sessions: SessionMap = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let path = start_recording_on(&sessions, &local, dir.path(), &v, &id, None)
            .expect("start recording on local session");

        // 退出收尾：清点 1 个槽位，录制入库（host_id None = 本地/未知桶）。
        assert_eq!(finalize_all_on_exit(&sessions, &local, Some(&v)), 1);
        let rows = Recordings::list(&v, None, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, path.to_string_lossy());
        assert!(rows[0].host_id.is_none());

        // 幂等：槽已空，重复调用（退出竞态面）不双入库。
        assert_eq!(finalize_all_on_exit(&sessions, &local, Some(&v)), 1);
        assert_eq!(Recordings::list(&v, None, 10).unwrap().len(), 1);

        // 收尾即空槽：recording_start 语义上不再报 already recording（直接
        // 开一把新录制验证槽位真被清掉——本地会话仍活着）。
        assert!(start_recording_on(&sessions, &local, dir.path(), &v, &id, None).is_ok());
        // 两次收尾 + 一次重开 = 2 行；第二次在途录制由会话消亡路径收尾。
        assert_eq!(finalize_all_on_exit(&sessions, &local, Some(&v)), 1);
        assert_eq!(Recordings::list(&v, None, 10).unwrap().len(), 2);

        // 清理会话（cancel + kill，与 drop_session 本地分支同款两步）——批量
        // 线程收尾时槽位已被上面最后一次收尾清空，no-op 不双入库。
        {
            let m = local.lock().unwrap();
            let e = m.get(&id).expect("entry");
            e.cancel.store(true, std::sync::atomic::Ordering::Relaxed);
            let _ = e.killer.lock().unwrap().kill();
        }
    }

    /// 孤儿归档核：无行 .cast 入库归档（duration/FTS 文本从文件重建）、
    /// 已知文件跳过、安全窗内绝不碰（防误伤本进程在录文件）、残档/空文件
    /// 也归档（只归档不删除——可见 + recording_delete 可删）、目录缺失非错。
    #[test]
    fn sweep_orphan_archives_only_rowless_aged_casts() {
        let v = vault();
        let dir = tempfile::tempdir().unwrap();
        let str_of = |p: &Path| p.to_string_lossy().into_owned();

        // ① 真孤儿：正常 start + send + finalize（不 insert）→ 有文件无库行。
        let orphan = dir.path().join("rec-1.cast");
        let handle = RecordingHandle::start(orphan.clone(), 80, 24, None).unwrap();
        handle.send(b"crashed session output ");
        std::thread::sleep(std::time::Duration::from_millis(20));
        handle.send("部署中\x1b[31m".as_bytes());
        handle.finalize();

        // ② 残档：非法内容（header 都没有）→ 归档为 duration 0 / 无 FTS。
        let garbage = dir.path().join("rec-2.cast");
        std::fs::write(&garbage, b"truncated junk\n").unwrap();

        // ③ 空文件：start 与 header 落盘之间被杀的极端形态 → 同样归档。
        let empty = dir.path().join("rec-3.cast");
        std::fs::write(&empty, b"").unwrap();

        // ④ 有库行的正常文件：不在孤儿之列。
        let known = dir.path().join("rec-4.cast");
        let kh = RecordingHandle::start(known.clone(), 80, 24, None).unwrap();
        kh.finalize();
        Recordings::insert(
            &v,
            &RecordingInput {
                host_id: None,
                path: str_of(&known),
                duration: 1.0,
                text: Some("known".into()),
            },
        )
        .unwrap();

        // 安全窗内（文件都刚写）：一个都不碰。
        assert_eq!(
            sweep_orphan_recordings(dir.path(), &v, std::time::Duration::from_secs(60)),
            0,
            "安全窗内绝不归档（防误伤本进程在录文件）"
        );

        // 窗外（min_age = 0）：三个孤儿归档，已知文件跳过。
        assert_eq!(
            sweep_orphan_recordings(dir.path(), &v, std::time::Duration::ZERO),
            3
        );
        let rows = Recordings::list(&v, None, 50).unwrap();
        assert_eq!(rows.len(), 4);

        // 真孤儿的元数据从文件重建：duration = 末事件时间、host_id None、
        // FTS 文本可检索（含 CJK，ANSI 已剥）。
        let orphan_path = str_of(&orphan);
        let orphan_row = rows.iter().find(|r| r.path == orphan_path).unwrap();
        assert!(orphan_row.duration > 0.0, "duration = 末事件时间");
        assert!(orphan_row.host_id.is_none());
        let hits = Recordings::search(&v, "部署", None, 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.id, orphan_row.id);
        assert!(!hits[0].snippet.contains('\x1b'), "snippet 是剥离文本");

        // 残档/空文件：duration 0、不进 FTS，但库行在（可见 + 可删）。
        let garbage_path = str_of(&garbage);
        let empty_path = str_of(&empty);
        for p in [garbage_path.as_str(), empty_path.as_str()] {
            let row = rows.iter().find(|r| r.path == p).unwrap();
            assert_eq!(row.duration, 0.0);
        }
        let fts_rows = Recordings::search(&v, "", None, 50).unwrap();
        assert!(
            fts_rows
                .iter()
                .all(|h| h.entry.path != garbage_path && h.entry.path != empty_path),
            "残档/空文件只入元数据，不进 FTS"
        );

        // 目录不存在：非错误，0。
        assert_eq!(
            sweep_orphan_recordings(&dir.path().join("nope"), &v, std::time::Duration::ZERO),
            0
        );
    }

    /// 残行容忍（写入中途被杀的典型残迹）：完整事件之后跟着半行落盘
    /// （JSON 不完整、无换行）→ 收档于最后**完整**事件，半截不计。
    #[test]
    fn scan_cast_file_tolerates_torn_tail() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("torn.cast");
        let mut content =
            ottr_term::asciinema::CastHeader::new(80, 24, 1_760_000_000).header_line();
        content.push('\n');
        content.push_str(&ottr_term::asciinema::event_line(1.5, "kept"));
        content.push('\n');
        content.push_str("[1.9999,\"o\",\"par"); // 半行：无换行、JSON 不完整
        std::fs::write(&path, content).unwrap();

        let (duration, text) = scan_cast_file(&path);
        assert_eq!(duration, 1.5, "残行不计，收档于最后完整事件");
        assert_eq!(text.as_deref(), Some("kept"));
    }
}
