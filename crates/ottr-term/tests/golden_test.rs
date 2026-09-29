//! 文本层 golden 测试（简报 Step 1 先行编写，Step 4 转绿）。
//!
//! 断言三层：
//! 1. `Parser::feed` 的事件序列与样例常量一致；
//! 2. 剥离文本（`strip(raw)` 与 `strip(concat(Text events))` 两条路）逐字节等于
//!    `tests/golden/out_*.expected`；
//! 3. chunk 无关性：逐字节喂入与整块喂入产生相同的非 Text 事件与相同剥离文本。
//!
//! 另含确定性 fuzz 循环（1000 组随机字节，不引 proptest 依赖）。

#[path = "samples/mod.rs"]
mod samples;

use ottr_term::osc133::{Event, Parser};
use ottr_term::ring::RingBuffer;
use ottr_term::stripper::{Stripper, TextSink, strip};
use std::fs;
use std::path::PathBuf;

// ---------- 期望事件的可比较形式 ----------

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExpOwned {
    PromptStart,
    CommandStart,
    CommandEnd,
    Done(Option<i32>),
    Cwd(String),
    Text(Vec<u8>),
}

fn exp_of_event(e: &Event<'_>) -> ExpOwned {
    match e {
        Event::PromptStart => ExpOwned::PromptStart,
        Event::CommandStart => ExpOwned::CommandStart,
        Event::CommandEnd => ExpOwned::CommandEnd,
        Event::CommandDone { exit_code } => ExpOwned::Done(*exit_code),
        Event::Cwd(s) => ExpOwned::Cwd(s.clone()),
        Event::Text(b) => ExpOwned::Text(b.to_vec()),
    }
}

fn exp_of_static(e: &samples::ExpectedEvent) -> ExpOwned {
    use samples::ExpectedEvent as E;
    match e {
        E::PromptStart => ExpOwned::PromptStart,
        E::CommandStart => ExpOwned::CommandStart,
        E::CommandEnd => ExpOwned::CommandEnd,
        E::CommandDone(code) => ExpOwned::Done(*code),
        E::Cwd(s) => ExpOwned::Cwd(s.to_string()),
        E::Text(b) => ExpOwned::Text(b.to_vec()),
    }
}

// ---------- 测试脚手架 ----------

#[derive(Default)]
struct StringSink(String);
impl TextSink for StringSink {
    fn text(&mut self, s: &str) {
        self.0.push_str(s);
    }
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
}

fn read_golden(name: &str) -> (Vec<u8>, Vec<u8>) {
    let dir = golden_dir();
    let input = fs::read(dir.join(format!("in_{name}.bin"))).expect("read in_*.bin");
    let expected = fs::read(dir.join(format!("out_{name}.expected"))).expect("read out_*.expected");
    (input, expected)
}

/// 拼接事件里的 Text 字节。
fn text_of(events: &[Event<'_>]) -> Vec<u8> {
    let mut out = Vec::new();
    for e in events {
        if let Event::Text(b) = e {
            out.extend_from_slice(b);
        }
    }
    out
}

/// 非 Text 事件（OSC 133 / cwd），跨 chunk 必须逐个一致。
fn control_events(events: &[Event<'_>]) -> Vec<ExpOwned> {
    events
        .iter()
        .map(exp_of_event)
        .filter(|e| !matches!(e, ExpOwned::Text(_)))
        .collect()
}

fn sample_by_name(name: &str) -> &'static samples::Sample {
    samples::SAMPLES
        .iter()
        .find(|s| s.name == name)
        .expect("sample exists")
}

/// 核心断言：整块喂入的事件序列 + 双路剥离文本 + 按 chunks 喂入的一致性。
fn assert_sample(sample: &samples::Sample) {
    let (file_input, file_expected) = read_golden(sample.name);
    // in_*.bin 与常量拼接一致（gen_golden 的镜像检查）。
    assert_eq!(
        file_input,
        samples::full_input(sample),
        "in_{}.bin 应等于 chunks 拼接",
        sample.name
    );

    // 整块喂入：事件序列。
    let mut parser = Parser::new();
    let whole_events = parser.feed(&file_input);
    let want: Vec<ExpOwned> = sample.expected_events.iter().map(exp_of_static).collect();
    let got: Vec<ExpOwned> = whole_events.iter().map(exp_of_event).collect();
    assert_eq!(got, want, "sample {}：整块喂入的事件序列不符", sample.name);

    // 双路剥离文本都须逐字节等于 out_*.expected。
    let mut from_events = StringSink::default();
    strip(&text_of(&whole_events), &mut from_events);
    assert_eq!(
        from_events.0.as_bytes(),
        file_expected,
        "sample {}：strip(concat(Text 事件)) ≠ expected",
        sample.name
    );

    let mut direct = StringSink::default();
    strip(&file_input, &mut direct);
    assert_eq!(
        direct.0.as_bytes(),
        file_expected,
        "sample {}：strip(raw) ≠ expected",
        sample.name
    );

    // 按样例定义的 chunks 喂入（撕裂样例在此生效）。
    let mut parser2 = Parser::new();
    let mut chunked_events = Vec::new();
    for chunk in sample.chunks {
        chunked_events.extend(parser2.feed(chunk));
    }
    assert_eq!(
        text_of(&chunked_events),
        text_of(&whole_events),
        "sample {}：分块喂入的 Text 拼接不符",
        sample.name
    );
    assert_eq!(
        control_events(&chunked_events),
        control_events(&whole_events),
        "sample {}：分块喂入的控制事件不符",
        sample.name
    );
    let mut chunked_sink = StringSink::default();
    let mut stripper = Stripper::new();
    for chunk in sample.chunks {
        stripper.feed(chunk, &mut chunked_sink);
    }
    stripper.finish(&mut chunked_sink);
    assert_eq!(
        chunked_sink.0.as_bytes(),
        file_expected,
        "sample {}：分块剥离文本 ≠ expected",
        sample.name
    );
}

// ---------- Step 1：golden 断言（5 个样例，撕裂样例必须有） ----------

#[test]
fn golden_plain() {
    assert_sample(sample_by_name("plain"));
}

#[test]
fn golden_sgr() {
    assert_sample(sample_by_name("sgr"));
}

#[test]
fn golden_csi() {
    assert_sample(sample_by_name("csi"));
}

#[test]
fn golden_osc133() {
    assert_sample(sample_by_name("osc133"));
}

/// 撕裂样例：CSI 序列与 OSC 序列各被切开一次，分三次 feed。
#[test]
fn golden_split_across_chunks() {
    let sample = sample_by_name("split");
    assert_eq!(sample.chunks.len(), 3, "撕裂样例必须由多个 chunk 组成");
    assert_sample(sample);
}

// ---------- Step 4：chunk 无关性（逐字节喂入） ----------

#[test]
fn byte_by_byte_chunk_invariance() {
    for sample in samples::SAMPLES {
        let input = samples::full_input(sample);

        let mut whole_parser = Parser::new();
        let whole_events = whole_parser.feed(&input);
        let mut whole_sink = StringSink::default();
        let mut whole_stripper = Stripper::new();
        whole_stripper.feed(&input, &mut whole_sink);
        whole_stripper.finish(&mut whole_sink);

        let mut byte_parser = Parser::new();
        let mut byte_events = Vec::new();
        let mut byte_sink = StringSink::default();
        let mut byte_stripper = Stripper::new();
        for byte in &input {
            byte_events.extend(byte_parser.feed(std::slice::from_ref(byte)));
            byte_stripper.feed(std::slice::from_ref(byte), &mut byte_sink);
        }
        byte_stripper.finish(&mut byte_sink);

        assert_eq!(
            control_events(&byte_events),
            control_events(&whole_events),
            "sample {}：逐字节喂入改变控制事件",
            sample.name
        );
        assert_eq!(
            text_of(&byte_events),
            text_of(&whole_events),
            "sample {}：逐字节喂入改变文本",
            sample.name
        );
        assert_eq!(
            byte_sink.0, whole_sink.0,
            "sample {}：逐字节喂入改变剥离文本",
            sample.name
        );
    }
}

// ---------- Step 4：确定性 fuzz（手写，1000 组随机字节） ----------

/// xorshift64——不依赖外部 crate 的确定性 PRNG。
struct Rng(u64);
impl Rng {
    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            return 0;
        }
        (self.next_u64() % n as u64) as usize
    }
}

///  escape 富集字符集，让随机流频繁命中状态机分支。
const ESC_RICH: &[u8] = b"\x1b[]();:0123456789ABCDEFmKhlnJr\\? \r\n\t\x07";
/// 合法与残缺的 UTF-8 片段（含孤立续字节与 0xFF）。
const UTF8_PIECES: &[&[u8]] = &[
    b"\xe4\xb8\xad",     // 中
    b"\xc3\xa9",         // é
    b"\xe2\x9c\x93",     // ✓
    b"\xf0\x9f\x90\x99", // 🐙
    b"\xe4",             // 残缺
    b"\xe4\xb8",         // 残缺
    b"\xff",             // 非法
    b"\x80",             // 孤立续字节
];

fn gen_bytes(rng: &mut Rng) -> Vec<u8> {
    // 偶尔注入完整 golden 输入，保证状态机常见形态被高频覆盖。
    if rng.below(8) == 0 {
        let sample = &samples::SAMPLES[rng.below(samples::SAMPLES.len())];
        return samples::full_input(sample);
    }
    let len = rng.below(512);
    let mut v = Vec::with_capacity(len + 8);
    for _ in 0..len {
        match rng.below(100) {
            0..=59 => v.push(ESC_RICH[rng.below(ESC_RICH.len())]),
            60..=79 => v.push(rng.next_u64() as u8),
            _ => {
                let piece = UTF8_PIECES[rng.below(UTF8_PIECES.len())];
                v.extend_from_slice(piece);
            }
        }
    }
    v
}

/// 把输入切成 1..=8 个随机块（模拟网络分块）。
fn split_random<'a>(rng: &mut Rng, input: &'a [u8]) -> Vec<&'a [u8]> {
    if input.len() < 2 {
        return vec![input];
    }
    let cut_count = rng.below(8);
    let mut cuts: Vec<usize> = (0..cut_count)
        .map(|_| 1 + rng.below(input.len() - 1))
        .collect();
    cuts.sort_unstable();
    cuts.dedup();
    let mut chunks = Vec::with_capacity(cuts.len() + 1);
    let mut start = 0;
    for cut in cuts {
        chunks.push(&input[start..cut]);
        start = cut;
    }
    chunks.push(&input[start..]);
    chunks
}

/// 合法输出字符域：\t\n\r、可打印 ASCII（不含 DEL 0x7F）、>=0x80（UTF-8）。
fn is_clean_output(s: &str) -> bool {
    s.bytes()
        .all(|b| matches!(b, b'\t' | b'\n' | b'\r' | 0x20..=0x7e) || b >= 0x80)
}

#[test]
fn fuzz_deterministic_1000_rounds() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    for round in 0..1000 {
        let input = gen_bytes(&mut rng);

        // 整块喂入。
        let mut whole_parser = Parser::new();
        let whole_events = whole_parser.feed(&input);
        let mut whole_sink = StringSink::default();
        let mut whole_stripper = Stripper::new();
        whole_stripper.feed(&input, &mut whole_sink);
        whole_stripper.finish(&mut whole_sink);

        // 随机分块喂入。
        let chunks = split_random(&mut rng, &input);
        let mut chunk_parser = Parser::new();
        let mut chunk_events = Vec::new();
        for chunk in &chunks {
            chunk_events.extend(chunk_parser.feed(chunk));
        }
        let mut chunk_sink = StringSink::default();
        let mut chunk_stripper = Stripper::new();
        for chunk in &chunks {
            chunk_stripper.feed(chunk, &mut chunk_sink);
        }
        chunk_stripper.finish(&mut chunk_sink);

        // 直接 strip。
        let mut direct = String::new();
        strip(&input, &mut direct);

        // 对 Text 事件再 strip。
        let mut from_events = String::new();
        strip(&text_of(&whole_events), &mut from_events);

        // 1) chunk 无关性。
        assert_eq!(
            control_events(&chunk_events),
            control_events(&whole_events),
            "round {round}：分块改变控制事件（input={input:?}）"
        );
        assert_eq!(
            text_of(&chunk_events),
            text_of(&whole_events),
            "round {round}：分块改变文本"
        );
        assert_eq!(
            chunk_sink.0, whole_sink.0,
            "round {round}：分块改变剥离文本"
        );
        // 2) 各路剥离结果一致。
        assert_eq!(
            direct, whole_sink.0,
            "round {round}：strip(raw) 与管线不一致"
        );
        assert_eq!(
            from_events, whole_sink.0,
            "round {round}：strip(Text 事件) 与管线不一致"
        );
        // 3) 输出为合法 UTF-8（String 类型即保证）且无残留控制字符/转义字节。
        assert!(
            is_clean_output(&whole_sink.0),
            "round {round}：剥离输出含非法控制字符"
        );
        assert!(
            !whole_sink.0.contains('\x1b'),
            "round {round}：剥离输出残留 ESC"
        );

        // 4) 环形缓冲顺带 fuzz：只要求不 panic、容量不被突破。
        let mut ring = RingBuffer::with_capacity(64);
        ring.push(whole_sink.0.as_bytes());
        let _ = ring.tail(rng.below(100));
        assert!(ring.len() <= 64);
    }
}
