//! Golden 样例常量（单一事实来源）。
//!
//! `gen_golden.rs` 用这些常量生成 `tests/golden/` 下的 in/expected 文件；
//! `golden_test.rs` 断言实现的行为与这些常量（以及生成的文件）一致。
//!
//! 每个 sample 的 `chunks` 定义了喂给 `Parser::feed` / `Stripper::feed`
//! 的分块方式：普通样例整块喂入，`split` 样例刻意在 CSI 参数中间与
//! OSC payload 中间撕裂成三块（跨 chunk 转义序列正确性的关键样例）。

/// 期望事件的静态描述（与 `osc133::Event` 一一对应，但可放进 const）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExpectedEvent {
    PromptStart,
    CommandStart,
    CommandEnd,
    CommandDone(Option<i32>),
    Cwd(&'static str),
    Text(&'static [u8]),
}

pub struct Sample {
    pub name: &'static str,
    pub chunks: &'static [&'static [u8]],
    /// 全流程剥离后的纯文本（out_*.expected 的内容）。
    /// 仅 gen_golden 目标读取；golden_test 目标读文件，会报 dead_code，故 allow。
    #[allow(dead_code)]
    pub expected_text: &'static [u8],
    /// 期望的事件序列（按喂入完整 input 一次的结果）。
    /// 仅 golden_test 目标读取；gen_golden 目标会报 dead_code，故 allow。
    #[allow(dead_code)]
    pub expected_events: &'static [ExpectedEvent],
}

/// 样例 1：纯文本（含 UTF-8 多字节、\r\n、\t），无任何转义序列。
const PLAIN_IN: &[u8] = b"hello \xe4\xb8\xad world\r\nsecond line\tindented\r\n";

/// 样例 2：SGR 颜色/样式（CSI m），剥离后只剩文本。
const SGR_IN: &[u8] = b"$ \x1b[32mgreen\x1b[0m \x1b[1;4mbold underline\x1b[0m plain\r\n";
const SGR_TEXT: &[u8] = b"$ green bold underline plain\r\n";

/// 样例 3：光标移动/擦除/私有模式 CSI（K、A、?25h、H），全部剥离。
const CSI_IN: &[u8] = b"line1\x1b[2Kline2\x1b[1A\x1b[?25h\x1b[3;5H end\r\n";
const CSI_TEXT: &[u8] = b"line1line2 end\r\n";

/// 样例 4：完整 OSC 133 命令流 + OSC 7 cwd + 无关 OSC 0（忽略）。
/// A/B/C/D 以 BEL 结尾，D 与 OSC 7 以 ST(ESC \) 结尾，覆盖两种终止符。
const OSC133_IN: &[u8] = b"\x1b]0;window title\x07\
\x1b]133;A\x07$ \
\x1b]133;B\x07ls /tmp\r\n\
\x1b]133;C\x07file1\r\nfile2\r\n\
\x1b]133;D;127\x1b\\\
\x1b]7;file://myhost/tmp\x1b\\";
const OSC133_TEXT: &[u8] = b"$ ls /tmp\r\nfile1\r\nfile2\r\n";

/// 样例 5：跨 chunk 撕裂——CSI `\x1b[32m` 的参数被 chunk1/chunk2 切开，
/// OSC `133;D;0` 的 payload 被 chunk2/chunk3 切开。in 文件是三块拼接。
const SPLIT_CHUNK1: &[u8] = b"$ \x1b[3";
const SPLIT_CHUNK2: &[u8] = b"2mhi\x1b]133;D";
const SPLIT_CHUNK3: &[u8] = b";0\x07ok\r\n";
const SPLIT_TEXT: &[u8] = b"$ hiok\r\n";

pub const SAMPLES: &[Sample] = &[
    Sample {
        name: "plain",
        chunks: &[PLAIN_IN],
        expected_text: PLAIN_IN,
        expected_events: &[ExpectedEvent::Text(PLAIN_IN)],
    },
    Sample {
        name: "sgr",
        chunks: &[SGR_IN],
        expected_text: SGR_TEXT,
        expected_events: &[
            ExpectedEvent::Text(b"$ "),
            ExpectedEvent::Text(b"green"),
            ExpectedEvent::Text(b" "),
            ExpectedEvent::Text(b"bold underline"),
            ExpectedEvent::Text(b" plain\r\n"),
        ],
    },
    Sample {
        name: "csi",
        chunks: &[CSI_IN],
        expected_text: CSI_TEXT,
        expected_events: &[
            ExpectedEvent::Text(b"line1"),
            ExpectedEvent::Text(b"line2"),
            ExpectedEvent::Text(b" end\r\n"),
        ],
    },
    Sample {
        name: "osc133",
        chunks: &[OSC133_IN],
        expected_text: OSC133_TEXT,
        expected_events: &[
            ExpectedEvent::PromptStart,
            ExpectedEvent::Text(b"$ "),
            ExpectedEvent::CommandStart,
            ExpectedEvent::Text(b"ls /tmp\r\n"),
            ExpectedEvent::CommandEnd,
            ExpectedEvent::Text(b"file1\r\nfile2\r\n"),
            ExpectedEvent::CommandDone(Some(127)),
            ExpectedEvent::Cwd("/tmp"),
        ],
    },
    Sample {
        name: "split",
        chunks: &[SPLIT_CHUNK1, SPLIT_CHUNK2, SPLIT_CHUNK3],
        expected_text: SPLIT_TEXT,
        expected_events: &[
            ExpectedEvent::Text(b"$ "),
            ExpectedEvent::Text(b"hi"),
            ExpectedEvent::CommandDone(Some(0)),
            ExpectedEvent::Text(b"ok\r\n"),
        ],
    },
];

/// 所有 chunks 拼接 = in_*.bin 的内容 = 完整输入。
pub fn full_input(sample: &Sample) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in sample.chunks {
        out.extend_from_slice(chunk);
    }
    out
}
