//! OSC 133 / OSC 7 命令流解析器。
//!
//! 单遍字节状态机：`Ground / Esc / Csi / Osc { params } / OscEsc { params }`。
//!
//! - OSC 以 BEL(0x07) 或 ST(ESC \) 结束；
//! - `133;A/B/C` 映射为 [`Event::PromptStart/CommandStart/CommandEnd`]，
//!   `133;D[;code]` 映射为 [`Event::CommandDone`]，
//!   `7;file://host/path` 映射为 [`Event::Cwd`]（`file://` 前缀剥去，host 后第一个 `/` 起为路径）；
//! - 其余 OSC（窗口标题等）与全部 CSI 序列被静默吞掉；
//! - 文本以 [`Event::Text`] 引用喂入的 chunk 返回（零拷贝，转义序列已剔除）。
//!
//! 状态可跨 chunk 存续：任何转义序列被从中间切开喂入都能正确续上。
//! 纯同步函数，无 runtime、无传输层类型。

/// [`Parser::feed`] 产出的一个事件。
///
/// [`Event::Text`] 借用当次喂入的字节切片；其余变体为 owned。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event<'a> {
    /// OSC 133;A — 提示符开始。
    PromptStart,
    /// OSC 133;B — 提示符结束，用户命令输入开始。
    CommandStart,
    /// OSC 133;C — 命令输出开始。
    CommandEnd,
    /// OSC 133;D[;code] — 命令结束，附带 shell 上报的退出码（缺省/非法时为 `None`）。
    CommandDone { exit_code: Option<i32> },
    /// OSC 7;file://host/path — shell 上报的当前工作目录。
    Cwd(String),
    /// 连续的纯文本片段（转义序列已剔除），借用自当次喂入的 chunk。
    Text(&'a [u8]),
}

/// 单个 OSC 参数串的累积上限：超过后不再追加（仍监视终止符），
/// 防止无终止符的畸形流无限占用内存。
const OSC_PARAM_CAP: usize = 8192;

#[derive(Debug)]
enum State {
    /// 地面态：`text_start` 为当前文本 run 在本次 chunk 中的起点。
    Ground { text_start: Option<usize> },
    /// 吃到 ESC。
    Esc,
    /// ESC [ 之后，直到 0x40..=0x7E 的 final byte。
    Csi,
    /// ESC ] 之后，累积 OSC 参数直到 BEL / ST。
    Osc { params: Vec<u8> },
    /// OSC 中途吃到 ESC：若下一字节是 `\` 则 ST 终止，`[` 则开始新 CSI。
    OscEsc { params: Vec<u8> },
}

/// OSC 133 / OSC 7 状态机。按 chunk 调用 [`Parser::feed`]，收集事件。
#[derive(Debug)]
pub struct Parser {
    state: State,
}

impl Default for Parser {
    fn default() -> Self {
        Self::new()
    }
}

impl Parser {
    pub fn new() -> Self {
        Parser {
            state: State::Ground { text_start: None },
        }
    }

    /// 喂入一个 chunk，返回其中解析出的事件（顺序与字节流一致）。
    ///
    /// 每个 feed 结束时会 flush 未完成的文本 run；
    /// 未终止的 OSC / CSI 状态保留到下一次 feed。
    pub fn feed<'a>(&mut self, bytes: &'a [u8]) -> Vec<Event<'a>> {
        let mut events = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            self.state =
                match std::mem::replace(&mut self.state, State::Ground { text_start: None }) {
                    State::Ground { text_start } => {
                        let b = bytes[i];
                        i += 1;
                        match b {
                            0x1B => {
                                if let Some(s) = text_start {
                                    events.push(Event::Text(&bytes[s..i - 1]));
                                }
                                State::Esc
                            }
                            0x07 => {
                                // BEL 不是文本：切断文本 run 并丢弃。
                                if let Some(s) = text_start {
                                    events.push(Event::Text(&bytes[s..i - 1]));
                                }
                                State::Ground { text_start: None }
                            }
                            _ => State::Ground {
                                text_start: Some(text_start.unwrap_or(i - 1)),
                            },
                        }
                    }
                    State::Esc => {
                        let b = bytes[i];
                        i += 1;
                        match b {
                            b'[' => State::Csi,
                            b']' => State::Osc { params: Vec::new() },
                            _ => State::Ground { text_start: None }, // 两字节转义（ESC 7、ESC c 等），吞掉
                        }
                    }
                    State::Csi => {
                        let b = bytes[i];
                        i += 1;
                        match b {
                            0x1B => State::Esc,                                // ESC 取消当前 CSI
                            0x40..=0x7E => State::Ground { text_start: None }, // final byte
                            _ => State::Csi,
                        }
                    }
                    State::Osc { mut params } => {
                        let b = bytes[i];
                        i += 1;
                        match b {
                            0x07 => {
                                if let Some(ev) = dispatch(&params) {
                                    events.push(ev);
                                }
                                State::Ground { text_start: None }
                            }
                            0x1B => State::OscEsc { params },
                            _ => {
                                if params.len() < OSC_PARAM_CAP {
                                    params.push(b);
                                }
                                State::Osc { params }
                            }
                        }
                    }
                    State::OscEsc { params } => {
                        let b = bytes[i];
                        i += 1;
                        match b {
                            b'\\' => {
                                if let Some(ev) = dispatch(&params) {
                                    events.push(ev);
                                }
                                State::Ground { text_start: None }
                            }
                            0x1B => State::OscEsc { params },
                            b'[' => State::Csi, // OSC 被中止，转入新 CSI
                            _ => State::Ground { text_start: None },
                        }
                    }
                };
        }
        // feed 结束：flush 未完成的文本 run（文本不跨 chunk 悬挂）。
        if let State::Ground {
            text_start: Some(s),
        } = self.state
        {
            events.push(Event::Text(&bytes[s..]));
            self.state = State::Ground { text_start: None };
        }
        events
    }
}

/// 把终止的 OSC 参数串映射为事件；不认识的 code / 畸形 payload 返回 `None`。
fn dispatch(params: &[u8]) -> Option<Event<'static>> {
    let s = std::str::from_utf8(params).ok()?;
    let (code, payload) = match s.split_once(';') {
        Some((c, p)) => (c, p),
        None => (s, ""),
    };
    match code {
        "133" => match payload.as_bytes().first() {
            Some(b'A') => Some(Event::PromptStart),
            Some(b'B') => Some(Event::CommandStart),
            Some(b'C') => Some(Event::CommandEnd),
            Some(b'D') => {
                // payload 形如 "D"、"D;0"、"D;127"、"D;-1"。
                let exit_code = payload
                    .split_once(';')
                    .and_then(|(_, rest)| rest.trim().parse::<i32>().ok());
                Some(Event::CommandDone { exit_code })
            }
            _ => None,
        },
        "7" => {
            // file://host/path → path（host 后第一个 / 起）。file:///path（空 host）也成立。
            let rest = payload.strip_prefix("file://")?;
            let slash = rest.find('/')?;
            Some(Event::Cwd(rest[slash..].to_string()))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(events: &[Event<'_>]) -> Vec<&'static str> {
        events
            .iter()
            .map(|e| match e {
                Event::PromptStart => "PromptStart",
                Event::CommandStart => "CommandStart",
                Event::CommandEnd => "CommandEnd",
                Event::CommandDone { .. } => "CommandDone",
                Event::Cwd(_) => "Cwd",
                Event::Text(_) => "Text",
            })
            .collect()
    }

    #[test]
    fn osc133_bel_and_st_terminated() {
        let mut p = Parser::new();
        let ev = p.feed(b"\x1b]133;A\x07x\x1b]133;D;0\x1b\\y");
        assert_eq!(kinds(&ev), ["PromptStart", "Text", "CommandDone", "Text"]);
        assert_eq!(ev[0], Event::PromptStart);
        assert_eq!(ev[1], Event::Text(b"x"));
        assert_eq!(ev[2], Event::CommandDone { exit_code: Some(0) });
        assert_eq!(ev[3], Event::Text(b"y"));
    }

    #[test]
    fn done_variants() {
        let mut p = Parser::new();
        let ev = p.feed(b"\x1b]133;D\x07\x1b]133;D;abc\x07\x1b]133;D;-1\x07");
        assert_eq!(
            ev,
            vec![
                Event::CommandDone { exit_code: None },
                Event::CommandDone { exit_code: None },
                Event::CommandDone {
                    exit_code: Some(-1)
                },
            ]
        );
    }

    #[test]
    fn cwd_variants() {
        let mut p = Parser::new();
        let ev = p.feed(b"\x1b]7;file://host/a/b\x07\x1b]7;file:///root\x07\x1b]7;http://x/y\x07\x1b]7;nopath\x07");
        assert_eq!(
            ev,
            vec![Event::Cwd("/a/b".into()), Event::Cwd("/root".into())]
        );
    }

    #[test]
    fn unknown_osc_and_malformed_ignored() {
        let mut p = Parser::new();
        let ev = p.feed(b"a\x1b]0;title\x07b\x1b]133;X\x07c\x1b]133\x07d");
        assert_eq!(
            ev,
            vec![
                Event::Text(b"a"),
                Event::Text(b"b"),
                Event::Text(b"c"),
                Event::Text(b"d")
            ]
        );
    }

    #[test]
    fn csi_torn_across_feeds_completes() {
        let mut p = Parser::new();
        let ev1 = p.feed(b"ab\x1b[3");
        assert_eq!(ev1, vec![Event::Text(b"ab")]);
        let ev2 = p.feed(b";4mcd");
        assert_eq!(ev2, vec![Event::Text(b"cd")]);
    }

    #[test]
    fn osc_torn_across_feeds_emits_once() {
        let mut p = Parser::new();
        assert!(p.feed(b"\x1b]133;D").is_empty());
        let ev = p.feed(b";42\x07tail");
        assert_eq!(
            ev,
            vec![
                Event::CommandDone {
                    exit_code: Some(42)
                },
                Event::Text(b"tail")
            ]
        );
    }

    #[test]
    fn esc_inside_osc_aborts_then_csi() {
        let mut p = Parser::new();
        // OSC 中途出现 ESC [ → OSC 作废，新 CSI 被完整消费，不泄漏 "31m" 为文本。
        let ev = p.feed(b"\x1b]133;A\x1b[31mx");
        assert_eq!(ev, vec![Event::Text(b"x")]);
    }

    #[test]
    fn bel_splits_text_runs() {
        let mut p = Parser::new();
        let ev = p.feed(b"ab\x07cd");
        assert_eq!(ev, vec![Event::Text(b"ab"), Event::Text(b"cd")]);
    }
}
