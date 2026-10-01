//! 编码命令域（Task 0 拆分，纯搬家）：会话编码切换 + 编码字符串解析 +
//! `ottr://encoding-hint` 事件载荷（发出点在 session::open_and_register 的
//! LANG 探测内，消费见 session.rs）。
use ottr_term::encoding::Encoding;
use tauri::State;

use super::state::AppState;

/// 编码字符串（host 表 `encoding_override` / `set_session_encoding` 入参）→
/// [`Encoding`]。支持集 = 简报定值 UTF-8/GBK/GB18030（GB2312 按 GBK 处理，
/// 与 ottr-term detect_hint 同口径）；无法识别 → None（调用方兜底 UTF-8 /
/// 显式报错）。**不支持** big5/shift_jis/euc-kr（Decoder 无对应解码器，宁可
/// 报错也不静默按错误编码出乱码）。
pub(crate) fn encoding_from_str(s: &str) -> Option<Encoding> {
    match s.trim().to_ascii_lowercase().as_str() {
        "utf-8" | "utf8" => Some(Encoding::Utf8),
        "gbk" | "gb2312" => Some(Encoding::Gbk),
        "gb18030" => Some(Encoding::Gb18030),
        _ => None,
    }
}

/// `ottr://encoding-hint` 事件载荷（serde 同构前端 EncodingHintPayload）。
/// 仅在 detect_hint 命中 GBK 家族时发出（UTF-8 兜底不打扰，前端不提示）。
#[derive(Clone, serde::Serialize)]
pub(crate) struct EncodingHintPayload {
    /// Rust 会话 id（前端按 rustId 反查标签会话）。
    pub(crate) id: String,
    /// 固定 "gbk"（与 ottr-term detect_hint 的提示粒度一致）。
    pub(crate) encoding: String,
}

/// 会话编码切换（Task 9，A9 收口）：即切即生效，从下个转发 chunk 起。
/// 返回值 = 切换瞬间 Decoder 残字节的按**旧编码**结算文本（通常为空；
/// 残留的不完整序列按切换前契约出替换符）——前端把这段文本写进终端即完成
/// 残字落账，字节永不静默丢弃。不支持集（big5 等）显式报错，不静默转码。
#[tauri::command]
pub(crate) fn set_session_encoding(
    state: State<'_, AppState>,
    id: String,
    encoding: String,
) -> Result<String, String> {
    let enc = encoding_from_str(&encoding)
        .ok_or_else(|| format!("unsupported encoding: {encoding} (utf-8/gbk/gb18030)"))?;
    let sessions = state.sessions.lock().unwrap();
    let entry = sessions
        .get(&id)
        .ok_or_else(|| format!("no such session: {id}"))?;
    let flushed = entry.decoder.lock().unwrap().set_encoding(enc);
    Ok(flushed)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 编码字符串解析表：支持集 UTF-8/GBK/GB18030（GB2312 按 GBK），大小写/
    /// 空白宽容；不支持的候选（T8 菜单遗留面）显式 None。
    #[test]
    fn encoding_from_str_supports_brief_set_only() {
        assert_eq!(encoding_from_str("utf-8"), Some(Encoding::Utf8));
        assert_eq!(encoding_from_str("UTF8"), Some(Encoding::Utf8));
        assert_eq!(encoding_from_str(" gbk "), Some(Encoding::Gbk));
        assert_eq!(encoding_from_str("GB2312"), Some(Encoding::Gbk));
        assert_eq!(encoding_from_str("gb18030"), Some(Encoding::Gb18030));
        assert_eq!(encoding_from_str("GB18030"), Some(Encoding::Gb18030));
        for bad in ["", "big5", "shift_jis", "euc-kr", "latin1", "gbk;rm -rf"] {
            assert_eq!(encoding_from_str(bad), None, "{bad:?} must be rejected");
        }
    }
}
