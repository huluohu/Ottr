//! ottr-term：Ottr 的终端文本层。
//!
//! 纯同步、字节级处理：不依赖 async runtime、不依赖任何传输层（russh）类型。
//! 上层（PTY 消费 / AI 诊断 / 统一历史 / 录制）按 chunk 喂入原始字节：
//!
//! - [`osc133::Parser`]：单遍状态机，产出 OSC 133 命令流事件、OSC 7 cwd 与文本片段；
//! - [`stripper`]：在 Parser 之上剥离 ANSI，向 [`stripper::TextSink`] 输出合法 UTF-8 纯文本；
//! - [`ring::RingBuffer`]：按行存储的定容环形缓冲（默认 10_000 行）；
//! - [`encoding::Decoder`]：会话级 UTF-8/GBK 解码与 LANG 检测提示（传输层在
//!   文本层之后、渲染之前调用）；
//! - [`asciinema`]：asciicast v2（JSON lines）录制格式的编码与解析（Task 5，B3
//!   ——录制 tee 的落盘形态与回放的取数面）。

pub mod asciinema;
pub mod encoding;
pub mod osc133;
pub mod ring;
pub mod stripper;

pub use encoding::{Decoder, Encoding, StreamDecoder};
