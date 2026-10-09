//! asciinema v2（JSON lines）录制格式的编码与解析（Phase 3 Task 5，B3）。
//!
//! 格式（https://docs.asciinema.org/manual/file-formats/asciicast-v2/）：
//! 首行 header `{"version": 2, "width": .., "height": .., "timestamp": .., ..}`，
//! 随后每行一个事件 `[elapsed_secs, "o", "data"]`（elapsed = 相对录制起点的
//! 浮点秒；"o" = stdout 输出）。本模块只产出/消费 **输出事件**：录制面 tee 的
//! 是转发管线的解码后文本（与前端 xterm 同源字节），**键入（"i"）永不录制**
//! （盲输密码等敏感输入不落盘，审计回放只需输出方向）；解析面容忍 "i"/"r"/"m"
//! 等外部事件行（跳过不报错—— Ottr 导出的文件可能被 asciinema 工具链加工过）。
//!
//! 精度：事件时间以微秒精度序列化（`{:.6}`）；解析回读 f64，≤6 位小数的时间
//! 编码/解析往返逐字节稳定（golden 断言）。
//!
//! 崩溃恢复语义：文件尾**最后一行**若被截断（写入中途进程消亡，无结尾换行），
//! 解析跳过该残行、其余照常回放——半行 JSON 换不来整场录制作废；中间行的
//! 损坏仍显式报错（审计面宁可报错不可静默吞内容）。

use std::fmt;

/// asciicast v2 header（首行）。`version` 恒 2；timestamp = 录制起点（秒级 Unix）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct CastHeader {
    pub version: u32,
    pub width: u32,
    pub height: u32,
    pub timestamp: i64,
    /// 终端环境（Ottr 固定面：录制不经真实 shell 环境下游，仅元数据）。
    #[serde(default)]
    pub env: CastEnv,
}

/// header 的 env 块（ Ottr 固定值；反序列化缺省兜底——外部文件可能省略 env）。
/// 键名跟随 asciinema 惯例大写（SHELL/TERM）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct CastEnv {
    #[serde(rename = "SHELL")]
    pub shell: String,
    #[serde(rename = "TERM")]
    pub term: String,
}

impl Default for CastEnv {
    fn default() -> Self {
        Self {
            shell: "ottr".into(),
            term: "xterm-256color".into(),
        }
    }
}

impl CastHeader {
    /// v2 header 构造（version 固定 2）。
    pub fn new(width: u32, height: u32, timestamp: i64) -> Self {
        Self {
            version: 2,
            width,
            height,
            timestamp,
            env: CastEnv::default(),
        }
    }

    /// 首行文本（含经典 v2 的 `", "`/`": "` 分隔形态；不含结尾换行）。
    pub fn header_line(&self) -> String {
        format!(
            "{{\"version\": {}, \"width\": {}, \"height\": {}, \"timestamp\": {}, \
             \"env\": {{\"SHELL\": {}, \"TERM\": {}}}}}",
            self.version,
            self.width,
            self.height,
            self.timestamp,
            serde_json::to_string(&self.env.shell).unwrap_or("\"ottr\"".into()),
            serde_json::to_string(&self.env.term).unwrap_or("\"xterm-256color\"".into()),
        )
    }
}

/// 一条输出事件（`time` = 相对录制起点的秒；`data` = 终端输出原文，转义序列保留
/// ——回放靠它们还原屏幕，FTS 索引面由录制器另行剥离）。serde 面供 desktop
/// recording_read/export 命令直接出/入参（snake_case 字段名即 serde 默认）。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CastEvent {
    pub time: f64,
    pub data: String,
}

/// 解析完成的整场录制。
#[derive(Debug, Clone, PartialEq)]
pub struct CastRecording {
    pub header: CastHeader,
    pub events: Vec<CastEvent>,
}

impl CastRecording {
    /// 时长 = 最后一个事件的时间（空录制 = 0；header 不承载 duration——v2
    /// 格式定案：时长由事件流推得）。
    pub fn duration(&self) -> f64 {
        self.events.last().map_or(0.0, |e| e.time)
    }

    /// 编码为 v2 文本（每行一个 JSON、行尾换行——文件形态与 [`parse`] 互逆）。
    pub fn encode(&self) -> String {
        let mut out = self.header.header_line();
        out.push('\n');
        for e in &self.events {
            out.push_str(&event_line(e.time, &e.data));
            out.push('\n');
        }
        out
    }
}

/// 一条输出事件行（`[{time:.6},"o",{data}]`；data 经 serde_json 转义——引号/
/// 反斜杠/控制字符/非 ASCII 语义与 asciinema 工具链一致）。
pub fn event_line(time: f64, data: &str) -> String {
    let encoded = serde_json::to_string(data).unwrap_or_else(|_| "\"\"".into());
    format!("[{time:.6},\"o\",{encoded}]")
}

/// 解析错误（Display 面向用户可读；审计面显式报错，绝不静默丢事件）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CastError {
    /// 首行不是合法 v2 header（含 version != 2）。
    BadHeader(String),
    /// 第 `line` 行（1 起，header 为第 1 行）事件损坏。
    BadEvent { line: usize, msg: String },
}

impl fmt::Display for CastError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::BadHeader(msg) => write!(f, "asciinema header invalid: {msg}"),
            Self::BadEvent { line, msg } => {
                write!(f, "asciinema event invalid at line {line}: {msg}")
            }
        }
    }
}

impl std::error::Error for CastError {}

/// 解析 v2 文本（[`CastRecording::encode`] 的逆）。规则：
/// * 首行必须解析为 header 且 `version == 2`；
/// * 空行跳过；`[time, "o", data]` 收录；其余 kind（"i"/"r"/"m"…）跳过；
/// * **末行截断容忍**：最后一行非空但坏 JSON 且无换行结尾 → 跳过（崩溃残行）；
///   其余位置损坏 → [`CastError::BadEvent`]。
pub fn parse(text: &str) -> Result<CastRecording, CastError> {
    let mut lines = text.lines();
    let header_line = lines
        .next()
        .ok_or_else(|| CastError::BadHeader("empty file".into()))?;
    let header: CastHeader =
        serde_json::from_str(header_line).map_err(|e| CastError::BadHeader(e.to_string()))?;
    if header.version != 2 {
        return Err(CastError::BadHeader(format!(
            "unsupported version {}",
            header.version
        )));
    }

    let raw_lines: Vec<&str> = lines.collect();
    let last_idx = raw_lines.len().saturating_sub(1);
    let mut events = Vec::new();
    for (i, line) in raw_lines.iter().enumerate() {
        let line_no = i + 2; // header 占第 1 行
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match parse_event(trimmed) {
            Ok(Some(ev)) => events.push(ev),
            Ok(None) => {} // 非 "o" 事件：跳过
            Err(msg) => {
                // 末行截断容忍：无结尾换行的残行丢弃，其余显式报错。
                if i == last_idx && !text.ends_with('\n') {
                    continue;
                }
                return Err(CastError::BadEvent { line: line_no, msg });
            }
        }
    }
    Ok(CastRecording { header, events })
}

/// 单行事件解析：`Some(event)` = 输出事件；`None` = 其他 kind（跳过）。
fn parse_event(line: &str) -> Result<Option<CastEvent>, String> {
    let v: serde_json::Value = serde_json::from_str(line).map_err(|e| format!("bad json: {e}"))?;
    let arr = v.as_array().ok_or("event is not an array")?;
    if arr.len() != 3 {
        return Err(format!("expected 3 elements, got {}", arr.len()));
    }
    let time = arr[0].as_f64().ok_or("time is not a number")?;
    let kind = arr[1].as_str().ok_or("kind is not a string")?;
    let data = arr[2].as_str().ok_or("data is not a string")?;
    if kind != "o" {
        return Ok(None);
    }
    Ok(Some(CastEvent {
        time,
        data: data.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_line_matches_classic_v2_shape() {
        let h = CastHeader::new(80, 24, 1_760_000_000);
        assert_eq!(
            h.header_line(),
            "{\"version\": 2, \"width\": 80, \"height\": 24, \"timestamp\": 1760000000, \
             \"env\": {\"SHELL\": \"ottr\", \"TERM\": \"xterm-256color\"}}"
        );
    }

    #[test]
    fn event_line_escapes_quotes_backslashes_and_unicode() {
        assert_eq!(event_line(0.0, "plain"), "[0.000000,\"o\",\"plain\"]");
        assert_eq!(
            event_line(1.5, "a\"b\\c\n中"),
            "[1.500000,\"o\",\"a\\\"b\\\\c\\n中\"]"
        );
        // 负时间不会出现（录制起点即 0），但格式器不崩
        assert!(event_line(-0.5, "x").starts_with("[-0.500000,"));
    }

    #[test]
    fn encode_parse_roundtrip_is_exact() {
        let rec = CastRecording {
            header: CastHeader::new(120, 40, 123),
            events: vec![
                CastEvent {
                    time: 0.0,
                    data: "$ ".into(),
                },
                CastEvent {
                    time: 0.250001,
                    data: "echo \"hi\"\r\nhi\r\n".into(),
                },
                CastEvent {
                    time: 12.999999,
                    data: "\u{1b}]133;D;0\u{7}".into(),
                },
            ],
        };
        let text = rec.encode();
        let parsed = parse(&text).expect("roundtrip parse");
        assert_eq!(parsed, rec);
        assert_eq!(parsed.duration(), 12.999999);
    }

    #[test]
    fn parse_skips_non_output_events_and_blank_lines() {
        let text = concat!(
            "{\"version\": 2, \"width\": 80, \"height\": 24, \"timestamp\": 1}\n",
            "[0.1,\"i\",\"secret-typing\"]\n",
            "\n",
            "[0.2,\"r\",\"80x24\"]\n",
            "[0.3,\"o\",\"out\"]\n",
        );
        let rec = parse(text).expect("tolerant parse");
        assert_eq!(
            rec.events,
            vec![CastEvent {
                time: 0.3,
                data: "out".into()
            }]
        );
    }

    #[test]
    fn parse_tolerates_truncated_last_line_only() {
        let full = "{\"version\": 2, \"width\": 80, \"height\": 24, \"timestamp\": 1}\n[0.1,\"o\",\"ok\"]\n";
        let truncated = "{\"version\": 2, \"width\": 80, \"height\": 24, \"timestamp\": 1}\n[0.1,\"o\",\"ok\"]\n[1.0,\"o\",\"par";
        let rec = parse(truncated).expect("truncated tail tolerated");
        assert_eq!(rec.events.len(), 1);
        assert_eq!(parse(full).expect("full fine").events.len(), 1);

        // 中间行损坏：显式报错（带行号），带换行结尾的末行损坏同样报错
        let mid_broken = "{\"version\": 2, \"width\": 80, \"height\": 24, \"timestamp\": 1}\n[0.1,\"o\"]\n[0.2,\"o\",\"x\"]\n";
        match parse(mid_broken) {
            Err(CastError::BadEvent { line, .. }) => assert_eq!(line, 2),
            other => panic!("expected BadEvent, got {other:?}"),
        }
        let tail_broken_with_nl = "{\"version\": 2, \"width\": 80, \"height\": 24, \"timestamp\": 1}\n[0.1,\"o\",\"ok\"]\n[1.0,\"o\"]\n";
        assert!(matches!(
            parse(tail_broken_with_nl),
            Err(CastError::BadEvent { line: 3, .. })
        ));
    }

    #[test]
    fn parse_rejects_bad_headers() {
        assert!(matches!(parse(""), Err(CastError::BadHeader(_))));
        assert!(matches!(parse("not json\n"), Err(CastError::BadHeader(_))));
        assert!(matches!(
            parse("{\"version\": 1, \"width\": 80, \"height\": 24, \"timestamp\": 1}\n"),
            Err(CastError::BadHeader(_))
        ));
    }

    #[test]
    fn duration_of_empty_recording_is_zero() {
        let rec = parse("{\"version\": 2, \"width\": 80, \"height\": 24, \"timestamp\": 1}\n")
            .expect("header only");
        assert_eq!(rec.duration(), 0.0);
        assert_eq!(
            rec.encode(),
            "{\"version\": 2, \"width\": 80, \"height\": 24, \"timestamp\": 1, \
             \"env\": {\"SHELL\": \"ottr\", \"TERM\": \"xterm-256color\"}}\n"
        );
    }
}
