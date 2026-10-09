//! 会话数据面：击键写入 / 字节计数 / 输出尾部 / PTY 尺寸变更 + 合批转发循环
//! （有字节即写、窗口默认 4ms 最长等待、64KB 先到即刷；取消/关闭/IPC 失败三态
//! 退出）。纯搬家拆分（原 session.rs 单文件）。

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};

use ottr_ssh::{PtyChannel, PtyEvent};
use ottr_term::encoding::StreamDecoder;
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

use crate::commands::state::{
    AppState, SessionCounters, SessionStats, TextTail, batch_limit, batch_window,
    flush_min_interval, snapshot,
};

/// 击键写入（输入方向，字节直传 PTY；spike 台账：传输编码允许 JSON 数组）。
#[tauri::command]
pub(crate) async fn write_session(
    state: State<'_, AppState>,
    id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let (writer, counters) = {
        let sessions = state.sessions.lock().unwrap();
        let entry = sessions
            .get(&id)
            .ok_or_else(|| format!("no such session: {id}"))?;
        (Arc::clone(&entry.writer), Arc::clone(&entry.counters))
    };
    let n = bytes.len();
    writer
        .lock()
        .await
        .write_all(&bytes)
        .await
        .map_err(|e| format!("pty write failed: {e}"))?;
    counters.input_bytes.fetch_add(n as u64, Ordering::Relaxed);
    counters.writes.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// Task 7 字节计数读数（Rust 侧转发计数）。
#[tauri::command]
pub(crate) fn session_stats(
    state: State<'_, AppState>,
    id: String,
) -> Result<SessionStats, String> {
    let sessions = state.sessions.lock().unwrap();
    sessions
        .get(&id)
        .map(|e| snapshot(&e.counters))
        .ok_or_else(|| format!("no such session: {id}"))
}

/// `session_tail` 单次取尾上限（1 MiB；诊断面 8KB，上限只防误传爆内存）。
const TAIL_MAX_BYTES: u32 = 1 << 20;

/// 会话输出尾部（Task 13，spec §6 AI 诊断取数面）：最后 `bytes` 字节的
/// 剥 ANSI 纯文本（UTF-8，\n 分行）。未知会话显式报错（标签已关/重连中）。
#[tauri::command]
pub(crate) fn session_tail(
    state: State<'_, AppState>,
    id: String,
    bytes: u32,
) -> Result<String, String> {
    let sessions = state.sessions.lock().unwrap();
    let entry = sessions
        .get(&id)
        .ok_or_else(|| format!("no such session: {id}"))?;
    Ok(entry.text_tail.tail(bytes.min(TAIL_MAX_BYTES) as usize))
}

// ---------------------------------------------------------------------------
// 合批转发循环：有字节即写、窗口（默认 4ms）为最长等待；64KB 先到者立即 flush。
// 取消：select 在 `cancel`（drop_session）上，到即就地退出（打 `session dropped`）。
// 返回退出原因：Cancelled（drop_session）/ Closed（对端关闭）/ IpcFailed（前端
// 通道不可达）——`ottr://session-closed` 事件的载荷（Cancelled = 主动关闭，前端
// 重连状态机不应反应；Closed/IpcFailed = 连接丢失，触发自动重连）。
// ---------------------------------------------------------------------------

/// 会话关闭原因（`ottr://session-closed` 载荷，serde snake_case）。pub 伴随
/// pub 的 `forward_pty_loop` 直驱面（驱动脚本/example 读返回值用）。
#[derive(Clone, Copy, PartialEq, Eq, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionCloseReason {
    /// drop_session 主动取消（关标签/手动断开）。
    Cancelled,
    /// 对端关闭（shell 退出 / 连接断开 / keepalive 超时）。
    Closed,
    /// 前端 IPC 通道 send 失败（M-2 失败策略）。
    IpcFailed,
}

#[derive(Clone, serde::Serialize)]
pub(super) struct SessionClosedPayload {
    pub(super) id: String,
    pub(super) reason: SessionCloseReason,
}

#[allow(unused_assignments)] // last_flush 的最后一次赋值在 break 路径上不被读取（预期）
#[allow(clippy::too_many_arguments)] // recorder（Task 5）加入后 8 参——皆必需面（直驱契约不变）
/// 合批转发循环。pub = 驱动脚本/example 直驱面（T9 真夹具三段验证走本函数，
/// 与正式会话同一代码路径）；常规入口经 attach_*。
/// `text_tail`（Task 13）：每批解码后的文本剥 ANSI 副本入会话尾缓冲
/// （`session_tail` 命令的消费源，AI 诊断输出尾部 8KB）。
/// `recorder`（Phase 3 Task 5，B3）：录制激活时每批解码后文本 tee 副本入
/// asciinema 编码器（try_send 非阻塞，不影响转发；驱动面传空槽位即可）。
pub async fn forward_pty_loop(
    channel: &mut PtyChannel,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    decoder: &Mutex<StreamDecoder>,
    text_tail: &TextTail,
    recorder: &crate::commands::recording::RecorderSlot,
    session_id: &str,
    cancel: &Notify,
    resize: &crate::commands::state::SessionResizeSlot,
) -> SessionCloseReason {
    // 通道消息经 ottr_ssh::pty 收口层（PtyChannel/PtyEvent）：russh 类型不再
    // 直接进入本 crate（russh 已从 [dependencies] 移入 dev-dependencies，仅
    // 测试 mock sshd 使用）。
    let limit = batch_limit();
    let mut buf: Vec<u8> = Vec::with_capacity(limit);
    let mut deadline: Option<Instant> = None;
    let mut last_flush: Option<Instant> = None;

    // flush 前按 `flush_min_interval` 节流（背压旋钮，默认关）：间隔不足就等足。
    // 等待期间 russh channel 不被读取，SSH 窗口收紧 → sshd 端 cat 阻塞 → 端到端背压。
    macro_rules! paced_flush {
        () => {{
            if let Some(min) = flush_min_interval() {
                if let Some(t) = last_flush {
                    let elapsed = t.elapsed();
                    if elapsed < min {
                        tokio::time::sleep(min - elapsed).await;
                    }
                }
            }
            last_flush = Some(Instant::now());
            flush_batch(
                &mut buf,
                &mut deadline,
                limit,
                on_data,
                counters,
                decoder,
                text_tail,
                recorder,
                session_id,
            )
            .await
        }};
    }

    // send 失败 = 前端通道不可达（M-2 失败策略，见 flush_batch）：终止循环。
    loop {
        let msg = match deadline {
            Some(d) => {
                let remaining = d.saturating_duration_since(Instant::now());
                tokio::select! {
                    m = ottr_ssh::pty::next_pty_event(channel) => m,
                    _ = tokio::time::sleep(remaining) => {
                        if !paced_flush!() {
                            return SessionCloseReason::IpcFailed;
                        }
                        continue;
                    }
                    _ = cancel.notified() => {
                        // 会话被丢弃（关标签/drop_session）：进程端任务就地取消。
                        // 批内残余字节随之丢弃（不再转发）——账目恒等式显式失衡：
                        // pty_read − forwarded − send_failed = 批内残余。
                        eprintln!("[batcher:{session_id}] session dropped");
                        return SessionCloseReason::Cancelled;
                    }
                }
            }
            None => tokio::select! {
                m = ottr_ssh::pty::next_pty_event(channel) => m,
                // PTY 尺寸变更（缺陷 34）：命令面投槽 + 唤醒，这里就地取用下发
                // window_change——readline 收 SIGWINCH 重绘提示符/回显区（2×1
                // 退化 PTY 只发空重绘、提示符缺失的根因修复点）。
                _ = resize.notified() => {
                    if let Some((cols, rows)) = resize.take()
                        && let Err(e) = ottr_ssh::pty::resize(channel, cols, rows).await {
                            eprintln!("[batcher:{session_id}] window_change({cols}x{rows}) failed: {e}");
                        }
                    continue;
                }
                _ = cancel.notified() => {
                    eprintln!("[batcher:{session_id}] session dropped");
                    return SessionCloseReason::Cancelled;
                }
            },
        };

        match msg {
            Some(PtyEvent::Data(data)) => {
                counters
                    .pty_read_bytes
                    .fetch_add(data.len() as u64, Ordering::Relaxed);
                if buf.is_empty() {
                    deadline = Some(Instant::now() + batch_window());
                }
                buf.extend_from_slice(&data);
                if buf.len() >= limit && !paced_flush!() {
                    return SessionCloseReason::IpcFailed;
                }
            }
            Some(PtyEvent::ExitStatus(_)) => {}
            Some(PtyEvent::Eof) => {
                flush_decoder_tail(&mut buf, decoder);
                if !paced_flush!() {
                    return SessionCloseReason::IpcFailed;
                }
            }
            Some(PtyEvent::Close) | None => {
                flush_decoder_tail(&mut buf, decoder);
                paced_flush!();
                eprintln!("[batcher:{session_id}] pty closed");
                return SessionCloseReason::Closed;
            }
            _ => {}
        }
    }
}

/// 会话收尾（Eof/Close）：Decoder 残字结算（不完整序列 → 替换符，字节永不
/// 静默丢弃），结算文本排在本批之前转发。
fn flush_decoder_tail(buf: &mut Vec<u8>, decoder: &Mutex<StreamDecoder>) {
    let tail = decoder.lock().unwrap().finish();
    if !tail.is_empty() {
        let mut merged = tail.into_bytes();
        merged.extend_from_slice(buf);
        *buf = merged;
    }
}

/// flush 一批到前端。返回 false = send 失败，调用方**必须**终止转发循环。
///
/// 【M-2 失败策略（T4 台账挂账：此前 send 失败仅 eprintln，字节静默丢失且循环
/// 空转继续丢）】send 失败意味着前端通道已不可达（webview 关闭/通道断开），
/// 重试无意义、继续循环只会静默丢字节并烧 CPU。三步定案：
/// ① 失败字节计入显式计数 `send_failed_bytes/frames`——失衡可见，绝不静默；
/// ② 置会话级失败标志 `failed`（`session_stats` 可读，前端轮询可见）；
/// ③ 返回 false 让转发循环终止，连接随后统一 disconnect（进程端任务取消）。
///
/// 【Task 9 解码接入】send 前经会话 Decoder（合批后、IPC 前）：buf 里的原始
/// PTY 字节解码为 UTF-8 文本再发。批尾不完整序列滞留 Decoder（≤3B）随下批
/// 转发；解码输出为空（全部滞留）时不发空帧。forwarded_bytes 按解码后文本
/// 字节记账（有损变换 + 残字滞留，与 pty_read_bytes 不再逐批恒等，见字段文档）。
#[allow(clippy::too_many_arguments)] // decoder/text_tail/recorder/session_id 皆必需面
async fn flush_batch(
    buf: &mut Vec<u8>,
    deadline: &mut Option<Instant>,
    limit: usize,
    on_data: &Channel<InvokeResponseBody>,
    counters: &SessionCounters,
    decoder: &Mutex<StreamDecoder>,
    text_tail: &TextTail,
    recorder: &crate::commands::recording::RecorderSlot,
    session_id: &str,
) -> bool {
    *deadline = None;
    if buf.is_empty() {
        return true;
    }
    let raw = std::mem::replace(buf, Vec::with_capacity(limit));
    // 解码（会话当前编码；切换由 set_session_encoding 即时生效，从下个 chunk 起）
    let text = decoder.lock().unwrap().decode_chunk(&raw);
    if text.is_empty() {
        return true; // 全部为批尾残字，滞留待下批（不丢，不发空帧）
    }
    // 文本尾缓冲（Task 13）：剥离副本入环（AI 诊断取数面，不影响前端转发）
    text_tail.push(text.as_bytes());
    // 录制 tee（Phase 3 Task 5，B3）：与前端 xterm 同源的解码文本副本入录制器
    // （try_send 非阻塞——队列满/已停 = 丢该批并计数，转发热路径零等待；
    // 录制开关不影响终端流纯净性：tee 只读副本，字节账面与不录完全一致）。
    if let Some(handle) = recorder.lock().unwrap().as_ref() {
        handle.send(text.as_bytes());
    }
    let n = text.len();
    let payload = text.into_bytes();
    match on_data.send(InvokeResponseBody::Raw(payload)) {
        Ok(()) => {
            counters
                .forwarded_bytes
                .fetch_add(n as u64, Ordering::Relaxed);
            counters.frames.fetch_add(1, Ordering::Relaxed);
            if std::env::var_os("OTTR_BATCH_DEBUG").is_some() {
                eprintln!("[batcher:{session_id}] flush {n} bytes");
            }
            true
        }
        Err(e) => {
            counters
                .send_failed_bytes
                .fetch_add(n as u64, Ordering::Relaxed);
            counters.send_failed_frames.fetch_add(1, Ordering::Relaxed);
            counters.failed.store(true, Ordering::Relaxed);
            eprintln!(
                "[batcher:{session_id}] session dropped (ipc send failed, {n} bytes lost): {e}"
            );
            false
        }
    }
}

/// PTY 尺寸变更（缺陷 34）：前端 fit 后把真实 cols/rows 投进会话的挂起槽，
/// 转发循环 select 唤醒后下发 `window_change`——readline 收 SIGWINCH 重绘
/// 提示符/回显区。attach 期（终端窗格未布局）尺寸可能退化为 2×1，没有这条
/// 接线 PTY 终身保持退化尺寸（提示符行缺失的根因，见 state.rs 契约测试）。
/// 会话不存在（刚断开）/ 无端点：静默忽略（fit 是视觉层语义，失败不打扰）。
#[tauri::command]
pub(crate) fn resize_session(
    state: State<'_, AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let entry = state
        .sessions
        .lock()
        .unwrap()
        .get(&id)
        .map(|e| Arc::clone(&e.resize));
    match entry {
        Some(resize) => {
            resize.set(cols, rows);
            Ok(())
        }
        None => Err(format!("no such session: {id}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ottr_term::encoding::Encoding;

    /// 测试用空录制槽位（不录制的 flush_batch 调用共用）。
    fn empty_recorder() -> crate::commands::recording::RecorderSlot {
        Arc::new(Mutex::new(None))
    }
    // --- Task 9（A9）：编码切换与转发路径解码 ---------------------------------

    /// flush_batch 转发路径解码：GBK 原始批 → IPC 帧是 UTF-8 文本（mock 会话流，
    /// Channel::new 捕获 Raw 帧）；forwarded 按解码后字节记账。
    #[test]
    fn flush_batch_decodes_gbk_batch_before_ipc() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        const GBK: &[u8] = &[
            0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0x20, 0x47, 0x42, 0x4B, 0x20, 0xCA,
            0xE4, 0xB3, 0xF6,
        ];
        let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&captured);
        let chan = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().extend_from_slice(&bytes);
            }
            Ok(())
        });
        let counters = SessionCounters::default();
        let text_tail = TextTail::new();
        // 默认 UTF-8：GBK 批 → 替换符乱码（ASCII 段保真）
        let decoder = Mutex::new(StreamDecoder::default());
        let mut buf = GBK.to_vec();
        let mut deadline = Some(Instant::now());
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            1024,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            &empty_recorder(),
            "t-utf8",
        ));
        assert!(ok);
        assert!(buf.is_empty());
        let out = captured.lock().unwrap().clone();
        let text = String::from_utf8(out).unwrap();
        assert!(
            text.contains('\u{FFFD}'),
            "utf-8 default must mojibake: {text:?}"
        );
        assert!(text.contains(" GBK "));
        assert_eq!(
            counters.forwarded_bytes.load(Ordering::Relaxed) as usize,
            text.len()
        );
        assert_eq!(counters.frames.load(Ordering::Relaxed), 1);

        // 切 GBK（set_session_encoding 的 Decoder 侧动作）→ 同批字节解出原文
        captured.lock().unwrap().clear();
        decoder.lock().unwrap().set_encoding(Encoding::Gbk);
        let mut buf = GBK.to_vec();
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            1024,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            &empty_recorder(),
            "t-gbk",
        ));
        assert!(ok);
        assert_eq!(
            String::from_utf8(captured.lock().unwrap().clone()).unwrap(),
            "中文测试 GBK 输出"
        );

        // 切回 UTF-8 后的批尾撕裂序列滞留（无空帧）；下批补齐重组
        captured.lock().unwrap().clear();
        decoder.lock().unwrap().set_encoding(Encoding::Utf8);
        let mut buf = vec![0xE4, 0xB8]; // 「中」的前 2/3（UTF-8 不完整序列）
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            1024,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            &empty_recorder(),
            "t-torn",
        ));
        assert!(ok);
        assert!(captured.lock().unwrap().is_empty(), "残批不发空帧");
        let mut buf = vec![0xAD, 0x21]; // 补齐「中」+ '!'
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            1024,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            &empty_recorder(),
            "t-torn2",
        ));
        assert!(ok);
        assert_eq!(
            String::from_utf8(captured.lock().unwrap().clone()).unwrap(),
            "中!"
        );
    }

    /// flush_batch 把解码后文本剥 ANSI 推进 TextTail：session_tail 的取数面。
    /// GBK 批解出的中文 + ANSI 颜色序列 → 尾缓冲里是纯文本。
    #[test]
    fn flush_batch_feeds_stripped_text_into_text_tail() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        let captured = Arc::new(Mutex::new(Vec::<u8>::new()));
        let sink = Arc::clone(&captured);
        let chan = Channel::new(move |body: InvokeResponseBody| {
            if let InvokeResponseBody::Raw(bytes) = body {
                sink.lock().unwrap().extend_from_slice(&bytes);
            }
            Ok(())
        });
        let counters = SessionCounters::default();
        let text_tail = TextTail::new();
        let decoder = Mutex::new(StreamDecoder::default());
        let mut deadline = Some(Instant::now());

        // 含 OSC133（133;D;1）+ CSI 颜色的批：前端照常转发（OSC 由 xterm 消费），
        // 尾缓冲里只剩纯文本行。
        let payload = b"\x1b]133;D;1\x07ls: cannot access '/x'\n\x1b[31mExit 1\x1b[0m\n";
        let mut buf = payload.to_vec();
        let ok = tauri::async_runtime::block_on(flush_batch(
            &mut buf,
            &mut deadline,
            4096,
            &chan,
            &counters,
            &decoder,
            &text_tail,
            &empty_recorder(),
            "t-tail",
        ));
        assert!(ok);
        // 前端转发面不受影响（剥 ANSI 前的原样解码文本）
        let forwarded = String::from_utf8(captured.lock().unwrap().clone()).unwrap();
        assert!(forwarded.contains("133;D;1"));
        // 尾缓冲：纯文本、无转义序列
        let tail = text_tail.tail(8192);
        assert_eq!(tail, "ls: cannot access '/x'\nExit 1");
        assert!(!tail.contains('\x1b'));
        // 字节口径截尾
        assert_eq!(text_tail.tail(6), "Exit 1");
        // 空环 / limit=0
        assert_eq!(TextTail::new().tail(100), "");
        assert_eq!(text_tail.tail(0), "");
    }
}
