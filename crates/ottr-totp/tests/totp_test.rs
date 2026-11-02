//! TOTP 生成器测试（RFC 6238 官方向量 + normalize 边界）。
//!
//! 官方向量见 RFC 6238 Appendix B：种子 `12345678901234567890`（ASCII），
//! 对应 base32 `GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ`，时间步长 30s。
//! 注：RFC 6238 的 8 位种子是 20 字节（160 bit）——本 crate 的最短门槛是
//! 10 字节（80 bit），官方向量满足。

use ottr_totp::{
    DEFAULT_DIGITS, DEFAULT_PERIOD, TotpError, TotpSecret, generate, generate_from_base32,
    remaining_seconds,
};

/// RFC 6238 Appendix B 的 SHA-1 种子（ASCII "12345678901234567890"）的 base32。
const RFC_SEED_B32: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/// RFC 6238 Appendix B 表（SHA-1 行，8 位验证码；本测试取 6 位子串）。
/// 时间(秒) → 8 位码
const RFC_VECTORS: &[(i64, &str)] = &[
    (59, "94287082"),
    (1_111_111_109, "07081804"),
    (1_111_111_111, "14050471"),
    (1_234_567_890, "89005924"),
    (2_000_000_000, "69279037"),
    (20_000_000_000, "65353130"),
];

#[test]
fn rfc6238_appendix_b_vectors_match() {
    let secret = TotpSecret::from_base32(RFC_SEED_B32).expect("官方向量种子应可解码");
    for (time, expected_8) in RFC_VECTORS {
        let got = generate(&secret, *time, 8, DEFAULT_PERIOD).expect("生成应成功");
        assert_eq!(&got, expected_8, "RFC 6238 向量在 t={time} 不符（8 位）");
    }
}

#[test]
fn six_digit_mode_matches_eight_digit_prefix() {
    // 6 位码 = 8 位码模 10^6 的零填充形式——用官方向量交叉验证位数语义。
    let secret = TotpSecret::from_base32(RFC_SEED_B32).unwrap();
    let code8 = generate(&secret, 59, 8, DEFAULT_PERIOD).unwrap();
    let code6 = generate(&secret, 59, 6, DEFAULT_PERIOD).unwrap();
    assert_eq!(
        code6,
        format!("{:06}", code8.parse::<u32>().unwrap() % 1_000_000)
    );
    assert_eq!(code6.len(), 6);
}

#[test]
fn base32_normalize_accepts_lowercase_spaces_and_missing_padding() {
    let raw = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq"; // 小写 + 空格
    let a = TotpSecret::from_base32(raw).expect("小写+空格应可 normalize");
    let b = TotpSecret::from_base32(RFC_SEED_B32).expect("规范形态应可解码");
    assert_eq!(a, b, "normalize 后应与规范形态等价");
}

#[test]
fn base32_normalize_accepts_existing_padding() {
    let padded = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ===="; // 多余 padding
    let a = TotpSecret::from_base32(padded).expect("多余 padding 应被容忍");
    let b = TotpSecret::from_base32(RFC_SEED_B32).unwrap();
    assert_eq!(a, b);
}

#[test]
fn invalid_inputs_are_rejected_with_distinct_errors() {
    assert_eq!(TotpSecret::from_base32(""), Err(TotpError::EmptySecret));
    assert_eq!(TotpSecret::from_base32("   "), Err(TotpError::EmptySecret));
    // 字符集外字符（含 0/1/8/9 —— base32 字母表是 A-Z + 2-7）
    assert_eq!(
        TotpSecret::from_base32("ABCDEF0189"),
        Err(TotpError::InvalidBase32)
    );
    // 太短（解码后 < 10 字节）
    assert_eq!(
        TotpSecret::from_base32("JBSWY3DP"),
        Err(TotpError::SecretTooShort)
    );
}

#[test]
fn digits_out_of_range_is_rejected() {
    let secret = TotpSecret::from_base32(RFC_SEED_B32).unwrap();
    assert_eq!(
        generate(&secret, 59, 0, DEFAULT_PERIOD),
        Err(TotpError::InvalidDigits)
    );
    assert_eq!(
        generate(&secret, 59, 11, DEFAULT_PERIOD),
        Err(TotpError::InvalidDigits)
    );
    assert_eq!(
        generate(&secret, 59, DEFAULT_DIGITS, 0),
        Err(TotpError::InvalidDigits)
    );
}

#[test]
fn code_is_stable_within_a_time_step_and_rotates_across_steps() {
    let secret = TotpSecret::from_base32(RFC_SEED_B32).unwrap();
    // 同一时间步内不变
    let a = generate(&secret, 60, DEFAULT_DIGITS, DEFAULT_PERIOD).unwrap();
    let b = generate(&secret, 89, DEFAULT_DIGITS, DEFAULT_PERIOD).unwrap();
    assert_eq!(a, b, "同一 30s 窗口内验证码应一致");
    // 跨步应不同（不同时间的码几乎必然不同——用官方向量已证）
    let c = generate(&secret, 90, DEFAULT_DIGITS, DEFAULT_PERIOD).unwrap();
    assert_ne!(a, c, "跨时间步验证码应变化");
}

#[test]
fn remaining_seconds_counts_down_within_step() {
    assert_eq!(remaining_seconds(59, 30), 1, "t=59 距下一窗 1s");
    assert_eq!(remaining_seconds(60, 30), 30, "t=60 是新窗起点");
    assert_eq!(remaining_seconds(0, 30), 30);
    assert_eq!(remaining_seconds(10, 0), 0, "period=0 兜底");
}

#[test]
fn convenience_entry_matches_two_step_api() {
    let via_shortcut =
        generate_from_base32(RFC_SEED_B32, 1_234_567_890, 6, DEFAULT_PERIOD).unwrap();
    let secret = TotpSecret::from_base32(RFC_SEED_B32).unwrap();
    let via_two_step = generate(&secret, 1_234_567_890, 6, DEFAULT_PERIOD).unwrap();
    assert_eq!(via_shortcut, via_two_step);
}

/// Debug 不得输出种子内容（derive(Debug) 会把字节数组原样打印 = 写进日志）。
#[test]
fn debug_output_does_not_leak_seed_bytes() {
    let secret = TotpSecret::from_base32("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").unwrap();
    let dumped = format!("{secret:?}");
    assert!(
        !dumped.contains("GEZD"),
        "Debug 输出不得含 base32 种子：{dumped}"
    );
    assert!(
        !dumped.contains("18, 61, 33"),
        "Debug 输出不得含种子字节数组：{dumped}"
    );
    assert!(dumped.contains("redacted"), "应给出存在标记：{dumped}");
}
