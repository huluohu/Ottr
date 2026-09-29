//! Golden 样例生成器（简报 Step 1：用常量拼接生成 in/expected 对）。
//!
//! 生成（手动跑一次）：`cargo test -p ottr-term --test gen_golden -- --ignored`
//! 日常 `cargo test` 只运行 `committed_files_match_constants`，
//! 防止 tests/golden/ 下的文件与常量悄悄漂移。

#[path = "samples/mod.rs"]
mod samples;

use samples::SAMPLES;
use std::fs;
use std::path::PathBuf;

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("golden")
}

fn write_sample(name: &str, input: &[u8], expected: &[u8]) {
    let dir = golden_dir();
    fs::create_dir_all(&dir).expect("create golden dir");
    fs::write(dir.join(format!("in_{name}.bin")), input).expect("write in_*.bin");
    fs::write(dir.join(format!("out_{name}.expected")), expected).expect("write out_*.expected");
}

/// 生成器入口：显式 `--ignored` 触发，避免日常测试反复改写文件。
#[test]
#[ignore = "generator: cargo test -p ottr-term --test gen_golden -- --ignored"]
fn generate() {
    for sample in SAMPLES {
        write_sample(
            sample.name,
            &samples::full_input(sample),
            sample.expected_text,
        );
    }
    println!("generated {} golden sample pairs", SAMPLES.len());
}

/// 已提交的 golden 文件必须与常量逐字节一致。
#[test]
fn committed_files_match_constants() {
    for sample in SAMPLES {
        let dir = golden_dir();
        let input = fs::read(dir.join(format!("in_{}.bin", sample.name)))
            .unwrap_or_else(|e| panic!("read in_{}.bin: {e}（先跑 generate）", sample.name));
        let expected = fs::read(dir.join(format!("out_{}.expected", sample.name)))
            .unwrap_or_else(|e| panic!("read out_{}.expected: {e}（先跑 generate）", sample.name));
        assert_eq!(
            input,
            samples::full_input(sample),
            "in_{}.bin 与常量不一致",
            sample.name
        );
        assert_eq!(
            expected, sample.expected_text,
            "out_{}.expected 与常量不一致",
            sample.name
        );
    }
}
