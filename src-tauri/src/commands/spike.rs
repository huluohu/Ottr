//! spike 命令域（Task 0 拆分，纯搬家）：Phase 0 spike 测量/取数命令面
//! （latency 落盘 / log / keyring 三件 / notify / report_file / channel 探针）。
//! 前端 UI 分支已随多标签重构删除（App.tsx 注释在位）——本模块仅 scripts/验收
//! 驱动面使用；生产闸门（#[cfg(debug_assertions)]）由 Task 0 Step 4 单独提交。
use base64::Engine as _;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use super::state::{batch_limit, batch_window, flush_min_interval, snapshot, AppState};

/// 延迟测量取数通道：前端测完 POST JSON，这里合并 Rust 侧计数后落盘。
/// 路径可用 `OTTR_SPIKE_REPORT` 覆盖，默认 /tmp/ottr-latency.json（驱动脚本轮询此文件）。
#[tauri::command]
pub(crate) fn spike_report_latency(
    state: State<'_, AppState>,
    payload: String,
) -> Result<String, String> {
    let mut report: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("bad report json: {e}"))?;
    let sessions = state.sessions.lock().unwrap();
    let rust_side: serde_json::Map<String, serde_json::Value> = sessions
        .iter()
        .map(|(id, e)| {
            let stats = snapshot(&e.counters);
            (id.clone(), serde_json::to_value(&stats).unwrap_or_default())
        })
        .collect();
    report["rust"] = serde_json::json!({
        "batch_window_ms": batch_window().as_millis() as u64,
        "batch_limit_bytes": batch_limit(),
        "flush_min_interval_ms": flush_min_interval().map(|d| d.as_millis() as u64).unwrap_or(0),
        "sessions": rust_side,
    });

    let path =
        std::env::var("OTTR_SPIKE_REPORT").unwrap_or_else(|_| "/tmp/ottr-latency.json".into());
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write {path}: {e}"))?;
    Ok(path)
}

/// 自动化排障：前端关键阶段打点 → dev log（页面侧无 stdout，这条是唯一可观测通道）。
#[tauri::command]
pub(crate) fn spike_log(msg: String) {
    eprintln!("[spike-page] {msg}");
}

// ---------------------------------------------------------------------------
// Task 11 / Spike #7：keyring 读写（service 用 "ottr.spike" 与正式数据隔离）
// ---------------------------------------------------------------------------

/// spike 固定 service/account；account 只是条目第二键，取固定值即可。
const KEYRING_SERVICE: &str = "ottr.spike";
const KEYRING_ACCOUNT: &str = "spike-account";

#[tauri::command]
pub(crate) fn spike_keyring_set(value: String) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("entry new: {e}"))?;
    entry.set_password(&value).map_err(|e| format!("set: {e}"))
}

#[tauri::command]
pub(crate) fn spike_keyring_get() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("entry new: {e}"))?;
    entry.get_password().map_err(|e| format!("get: {e}"))
}

#[tauri::command]
pub(crate) fn spike_keyring_del() -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|e| format!("entry new: {e}"))?;
    // keyring v3：delete_credential（v2 的 delete_password 已改名）。
    entry.delete_credential().map_err(|e| format!("del: {e}"))
}

// ---------------------------------------------------------------------------
// Task 11 / Spike #8：系统通知（tauri-plugin-notification，Rust 侧 API）
// ---------------------------------------------------------------------------

/// 发系统通知。macOS 首次调用触发系统授权框；未授权时 show() 仍成功、通知被
/// 系统静默丢弃——本命令只能证明「插件 API 调用成功」，弹窗与点击回焦列入
/// T13 runbook 人工验证（Windows Toast 应用身份 / Linux libnotify 同理）。
#[tauri::command]
pub(crate) fn spike_notify(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| format!("notify: {e}"))
}

/// Task 11 取数通道：spike 页 POST JSON 落盘（keyring/notify 页复用）。
/// 路径白名单 /tmp/ottr-*.json（spike 报告约定目录，防 webview 任意写文件）；
/// 含 `..` 一律拒绝（否则 /tmp/ottr-../../x.json 可同时满足前后缀逃逸白名单）。
#[tauri::command]
pub(crate) fn spike_report_file(path: String, payload: String) -> Result<String, String> {
    if !path.starts_with("/tmp/ottr-") || !path.ends_with(".json") || path.contains("..") {
        return Err(format!("report path not allowed: {path}"));
    }
    let report: serde_json::Value =
        serde_json::from_str(&payload).map_err(|e| format!("bad report json: {e}"))?;
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("write {path}: {e}"))?;
    Ok(path)
}

/// 二进制通道定案探针：同一 `Channel<InvokeResponseBody>` 上发三种帧，
/// 前端记录 `typeof`/长度做对账——
/// 1) `Raw`(16B)：走 eval 直执行路径（<1024B 阈值）；
/// 2) `Raw`(2048B)：走 fetch 二进制路径（octet-stream）；
/// 3) `Json`(base64 字符串)：对照组——若走 JSON 字符串方案前端会收到什么。
#[tauri::command]
pub(crate) async fn spike_probe_channel(
    on_probe: Channel<InvokeResponseBody>,
) -> Result<(), String> {
    let small: Vec<u8> = (0u8..16).collect();
    let big: Vec<u8> = (0..2048u32).map(|i| (i % 251) as u8).collect();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&small);

    on_probe
        .send(InvokeResponseBody::Raw(small))
        .map_err(|e| e.to_string())?;
    on_probe
        .send(InvokeResponseBody::Raw(big))
        .map_err(|e| e.to_string())?;
    on_probe
        .send(InvokeResponseBody::Json(
            serde_json::to_string(&b64).unwrap(),
        ))
        .map_err(|e| e.to_string())?;
    Ok(())
}
