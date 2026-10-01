//! 按行存储的定容环形缓冲（统一历史 / 录制的行视图）。
//!
//! - [`RingBuffer::push`] 喂入任意字节块：以 `\n` 切行，完整行入环，
//!   尾部未换行的残行挂在 `pending` 等下一个 chunk 续上；
//! - [`RingBuffer::tail`] 返回最后 n 个完整行，以 `\n` 拼接（无尾随换行）；
//! - 容量满时从队首逐出行（默认 [`DEFAULT_CAPACITY`] = 10_000 行）。
//!
//! 行内容保留原始字节（含 `\r`，不做 CRLF 规范化）——剥离/清洗由上层决定。
//! 纯同步，无 runtime、无传输层类型。

use std::collections::VecDeque;

/// [`RingBuffer`] 直挂 [`crate::stripper::TextSink`]（Task 13：转发循环解码后的
/// 文本经 Stripper 剥 ANSI 后直接入环——ottr-term 内部胶水，避免上层手写中转缓冲）。
impl crate::stripper::TextSink for RingBuffer {
    fn text(&mut self, s: &str) {
        self.push(s.as_bytes());
    }
}

/// 默认容量：10_000 行。
pub const DEFAULT_CAPACITY: usize = 10_000;

/// 单个未换行残行的字节上限：无 `\n` 的病态流不会让内存无限增长。
const MAX_PENDING: usize = 1 << 20; // 1 MiB

/// 定容行环形缓冲。
#[derive(Debug)]
pub struct RingBuffer {
    lines: VecDeque<Vec<u8>>,
    pending: Vec<u8>,
    capacity: usize,
}

impl Default for RingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl RingBuffer {
    /// 默认容量（10_000 行）的环形缓冲。
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }

    /// 指定容量的环形缓冲。
    pub fn with_capacity(capacity: usize) -> Self {
        RingBuffer {
            lines: VecDeque::new(),
            pending: Vec::new(),
            capacity,
        }
    }

    /// 容量（行数）。
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// 当前存储的完整行数。
    pub fn len(&self) -> usize {
        self.lines.len()
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// 是否还有未换行的残行挂在缓冲里。
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// 喂入任意字节块，按 `\n` 切行入环。
    pub fn push(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while let Some(pos) = rest.iter().position(|&b| b == b'\n') {
            self.pending.extend_from_slice(&rest[..pos]);
            let line = std::mem::take(&mut self.pending);
            self.push_line(line);
            rest = &rest[pos + 1..];
        }
        if self.pending.len() < MAX_PENDING {
            let take = (MAX_PENDING - self.pending.len()).min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
        }
    }

    /// 最后 `n` 个完整行，以 `\n` 拼接（无尾随换行）；残行不计入。
    pub fn tail(&self, n: usize) -> Vec<u8> {
        let skip = self.lines.len().saturating_sub(n);
        let mut out = Vec::new();
        for line in self.lines.iter().skip(skip) {
            if !out.is_empty() {
                out.push(b'\n');
            }
            out.extend_from_slice(line);
        }
        out
    }

    /// 最后 `limit` 字节的最近内容（Task 13 AI 诊断「输出尾部 8KB」的取数面，
    /// 与 [`tail`] 的行数口径互补）：
    /// * 按完整行对齐——最旧一侧放不下的行**整行让出**（绝不给半行开头）；
    /// * 单行自身超限且尚无收成 → 取该行尾 `limit` 字节（保证有产出）；
    /// * `limit` 为 0 → 空串。残行（pending）不计入，与 [`tail`] 同口径。
    pub fn tail_bytes(&self, limit: usize) -> Vec<u8> {
        if limit == 0 {
            return Vec::new();
        }
        let mut parts: Vec<&[u8]> = Vec::new();
        let mut total = 0usize; // 已收字节数（含行间分隔符）
        for line in self.lines.iter().rev() {
            let sep = usize::from(!parts.is_empty());
            if total + sep + line.len() > limit {
                if parts.is_empty() && line.len() > limit {
                    return line[line.len() - limit..].to_vec();
                }
                break;
            }
            total += sep + line.len();
            parts.push(line);
        }
        let mut out = Vec::with_capacity(total);
        for (i, part) in parts.iter().rev().enumerate() {
            if i > 0 {
                out.push(b'\n');
            }
            out.extend_from_slice(part);
        }
        out
    }

    fn push_line(&mut self, line: Vec<u8>) {
        self.lines.push_back(line);
        while self.lines.len() > self.capacity {
            self.lines.pop_front();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tail_str(ring: &RingBuffer, n: usize) -> String {
        String::from_utf8_lossy(&ring.tail(n)).into_owned()
    }

    #[test]
    fn complete_lines_pushed_and_tailed() {
        let mut ring = RingBuffer::with_capacity(10);
        ring.push(b"a\nb\nc\n");
        assert_eq!(ring.len(), 3);
        assert_eq!(tail_str(&ring, 10), "a\nb\nc");
        assert_eq!(tail_str(&ring, 2), "b\nc");
        assert_eq!(tail_str(&ring, 0), "");
    }

    #[test]
    fn partial_line_spans_pushes() {
        let mut ring = RingBuffer::with_capacity(10);
        ring.push(b"hel");
        assert_eq!(ring.len(), 0);
        assert!(ring.has_pending());
        ring.push(b"lo\nwor");
        assert_eq!(ring.len(), 1);
        assert!(ring.has_pending());
        ring.push(b"ld\n");
        assert_eq!(ring.len(), 2);
        assert!(!ring.has_pending());
        assert_eq!(tail_str(&ring, 10), "hello\nworld");
    }

    #[test]
    fn evicts_oldest_when_over_capacity() {
        let mut ring = RingBuffer::with_capacity(3);
        ring.push(b"1\n2\n3\n4\n5\n");
        assert_eq!(ring.len(), 3);
        assert_eq!(tail_str(&ring, 100), "3\n4\n5");
        assert_eq!(tail_str(&ring, 1), "5");
    }

    #[test]
    fn keeps_cr_in_line_bytes() {
        // 不做 CRLF 规范化：\r 保留在行内容里，清洗由上层决定。
        let mut ring = RingBuffer::with_capacity(10);
        ring.push(b"a\r\nb\r\n");
        assert_eq!(ring.tail(10), b"a\r\nb\r".to_vec());
    }

    #[test]
    fn empty_and_fragment_only_input() {
        let mut ring = RingBuffer::with_capacity(10);
        ring.push(b"");
        assert!(ring.is_empty());
        ring.push(b"no newline yet");
        assert!(ring.is_empty());
        assert_eq!(ring.tail(5), b"");
    }

    #[test]
    fn pending_is_capped() {
        let mut ring = RingBuffer::with_capacity(10);
        let blob = vec![b'x'; MAX_PENDING + 4096];
        ring.push(&blob);
        assert!(ring.pending.len() <= MAX_PENDING);
    }

    #[test]
    fn default_capacity_is_10k() {
        let ring = RingBuffer::new();
        assert_eq!(ring.capacity(), 10_000);
    }

    // --- Task 13（AI 诊断）：tail_bytes 字节口径 ------------------------------

    #[test]
    fn tail_bytes_returns_last_lines_within_limit() {
        let mut ring = RingBuffer::with_capacity(10);
        ring.push(b"a\nbb\nccc\n");
        // "a\nbb\nccc" = 8 字节；"bb\nccc" = 6 字节
        assert_eq!(
            ring.tail_bytes(7),
            b"bb\nccc".to_vec(),
            "放不下最旧行整行让出"
        );
        assert_eq!(ring.tail_bytes(8), b"a\nbb\nccc".to_vec(), "恰好放下全收");
        assert_eq!(ring.tail_bytes(6), b"bb\nccc".to_vec());
        assert_eq!(ring.tail_bytes(2), b"cc".to_vec(), "行内截尾");
    }

    #[test]
    fn tail_bytes_single_huge_line_yields_its_tail() {
        let mut ring = RingBuffer::with_capacity(4);
        ring.push(b"abcdefgh\n");
        assert_eq!(ring.tail_bytes(3), b"fgh".to_vec());
    }

    #[test]
    fn tail_bytes_zero_and_overflow_limits() {
        let mut ring = RingBuffer::with_capacity(4);
        ring.push(b"ab\ncd\n");
        assert_eq!(ring.tail_bytes(0), Vec::<u8>::new());
        assert_eq!(ring.tail_bytes(1000), b"ab\ncd".to_vec());
        assert_eq!(ring.tail_bytes(5), b"ab\ncd".to_vec());
    }

    #[test]
    fn tail_bytes_drops_oldest_lines_first() {
        let mut ring = RingBuffer::with_capacity(10);
        ring.push(b"1\n2\n3\n4\n5\n");
        // 容量 3 → 剩 "3\n4\n5"；limit=4 放不下 "3"，取 "4\n5"
        assert_eq!(ring.tail_bytes(4), b"4\n5".to_vec());
    }

    #[test]
    fn ring_is_a_text_sink_for_stripper() {
        // 胶水实现回归：Stripper 剥完的文本直接入环（dyn TextSink 转型无需 trait
        // 在作用域，故此处只 import Stripper）
        use crate::stripper::Stripper;
        let mut ring = RingBuffer::with_capacity(10);
        let mut st = Stripper::new();
        st.feed(b"\x1b[31merr\x1b[0m: disk full\n", &mut ring);
        assert_eq!(ring.tail_bytes(1024), b"err: disk full".to_vec());
    }
}
