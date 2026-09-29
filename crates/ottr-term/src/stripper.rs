//! ANSI 剥离：转义序列与控制字符出，合法 UTF-8 纯文本入。
//!
//! [`Stripper`] 复用 [`crate::osc133::Parser`] 的单遍状态机剔除转义序列，
//! 再做两件收尾：
//! 1. C0 控制字符过滤——仅保留 `\t` `\n` `\r`，丢弃其余（含 BEL、DEL 0x7F）；
//! 2. 增量 UTF-8 校验——跨 chunk 撕裂的多字节字符先缓存在 carry 里，
//!    非法字节以显式替换符 U+FFFD 输出，保证 sink 收到的永远是合法 UTF-8。
//!
//! [`strip`] 是一次性便捷函数；流式场景对每个 chunk 调用 [`Stripper::feed`]，
//! 流结束时调 [`Stripper::finish`] flush 残缺的尾部 UTF-8。
//! 纯同步函数，无 runtime、无传输层类型。

use crate::osc133::{self, Parser};

/// 剥离文本的接收端。回调收到的字符串保证：
/// 合法 UTF-8、无转义序列、除 `\t` `\n` `\r` 外无 C0 控制字符。
pub trait TextSink {
    fn text(&mut self, s: &str);
}

/// 常用实现：直接追加到 `String`。
impl TextSink for String {
    fn text(&mut self, s: &str) {
        self.push_str(s);
    }
}

/// 一次性剥离：新建状态、喂入、flush 尾部，一步到位。
pub fn strip(bytes: &[u8], sink: &mut dyn TextSink) {
    let mut stripper = Stripper::new();
    stripper.feed(bytes, sink);
    stripper.finish(sink);
}

/// 流式剥离器。状态（转义序列状态机 + UTF-8 carry）跨 chunk 存续。
#[derive(Debug)]
pub struct Stripper {
    parser: Parser,
    carry: Vec<u8>,
}

impl Default for Stripper {
    fn default() -> Self {
        Self::new()
    }
}

impl Stripper {
    pub fn new() -> Self {
        Stripper {
            parser: Parser::new(),
            carry: Vec::new(),
        }
    }

    /// 喂入一个 chunk，把其中剥离出的文本推给 sink。
    pub fn feed(&mut self, bytes: &[u8], sink: &mut dyn TextSink) {
        for event in self.parser.feed(bytes) {
            if let osc133::Event::Text(t) = event {
                for &b in t {
                    // C0 过滤：保留 \t \n \r 与 >= 0x20（再排除 DEL 0x7F）。
                    if matches!(b, b'\t' | b'\n' | b'\r') || (b >= 0x20 && b != 0x7F) {
                        self.carry.push(b);
                    }
                }
                self.drain_carry(sink);
            }
        }
    }

    /// 流结束：把 carry 中残缺的尾部 UTF-8 以显式替换符 U+FFFD 输出。
    pub fn finish(&mut self, sink: &mut dyn TextSink) {
        if self.carry.is_empty() {
            return;
        }
        let lossy = String::from_utf8_lossy(&self.carry);
        if !lossy.is_empty() {
            sink.text(&lossy);
        }
        self.carry.clear();
    }

    /// 校验 carry 中的合法 UTF-8 前缀并输出；非法序列替换为 U+FFFD；
    /// 末尾残缺的多字节序列留在 carry 等下一个 chunk。
    fn drain_carry(&mut self, sink: &mut dyn TextSink) {
        loop {
            match std::str::from_utf8(&self.carry) {
                Ok(s) => {
                    if !s.is_empty() {
                        sink.text(s);
                    }
                    self.carry.clear();
                    return;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    if valid > 0 {
                        // 已通过 UTF-8 校验，unwrap 安全。
                        sink.text(std::str::from_utf8(&self.carry[..valid]).unwrap());
                    }
                    match e.error_len() {
                        Some(n) => {
                            sink.text("\u{FFFD}");
                            self.carry.drain(..valid + n);
                        }
                        None => {
                            // 残缺尾序列：留待下一个 chunk 续上。
                            self.carry.drain(..valid);
                            return;
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip_str(bytes: &[u8]) -> String {
        let mut out = String::new();
        strip(bytes, &mut out);
        out
    }

    #[test]
    fn removes_escapes_keeps_text() {
        assert_eq!(strip_str(b"he\x1b[31mllo\x1b[0m!"), "hello!");
    }

    #[test]
    fn keeps_tab_newline_cr_only() {
        // a \x00 b \x07 c \x7F d \t e \r f \n g → 仅 \x00/\x07/\x7F 被丢弃。
        assert_eq!(strip_str(b"a\x00b\x07c\x7Fd\te\rf\ng"), "abcd\te\rf\ng");
    }

    #[test]
    fn c0_filter_precise() {
        // \x00 BEL \x7F 丢弃；\t \n \r 保留。
        assert_eq!(strip_str(b"x\x00\x07\x7Fy"), "xy");
        assert_eq!(strip_str(b"a\tb\nc\rd"), "a\tb\nc\rd");
    }

    #[test]
    fn torn_utf8_across_feeds() {
        let mut st = Stripper::new();
        let mut out = String::new();
        st.feed(b"ab\xe4", &mut out);
        assert_eq!(out, "ab"); // \xE4 挂起
        st.feed(b"\xb8\xadcd", &mut out);
        assert_eq!(out, "ab中cd");
        st.finish(&mut out);
        assert_eq!(out, "ab中cd");
    }

    #[test]
    fn invalid_utf8_becomes_replacement() {
        // std 的恢复粒度不是 Unicode  maximal subpart：E4 B8 FF 的 error_len=Some(2)，
        // 故前 3 字节产出 2 个替换符；drain_carry 与 finish 的 from_utf8_lossy 同源，行为一致。
        assert_eq!(strip_str(b"a\xffb"), "a\u{FFFD}b");
        assert_eq!(strip_str(b"\xe4\xb8\xff\xe4\xb8\xad"), "\u{FFFD}\u{FFFD}中");
    }

    #[test]
    fn incomplete_utf8_at_finish_becomes_replacement() {
        let mut st = Stripper::new();
        let mut out = String::new();
        st.feed(b"ok\xe4\xb8", &mut out);
        assert_eq!(out, "ok"); // 尚未 complete
        st.finish(&mut out);
        assert_eq!(out, "ok\u{FFFD}");
    }

    #[test]
    fn empty_input_no_output() {
        assert_eq!(strip_str(b""), "");
        assert_eq!(strip_str(b"\x1b[31m\x1b]0;t\x07"), "");
    }
}
