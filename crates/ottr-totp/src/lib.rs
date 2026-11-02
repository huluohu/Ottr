//! TOTP 生成器（RFC 6238 / RFC 4226）。
//!
//! **纯本地计算，绝不联网**：本 crate 不含任何网络能力——种子解密在调用方
//! （Rust 侧）完成，本 crate 只做「base32 种子 → 当前验证码」这段纯函数。
//!
//! ## 算法（RFC 6238 §1.2）
//! ```text
//! T = floor((unix_time - T0) / X)          // X = 时间步长（默认 30s）
//! HMAC = HMAC-SHA1(K, T_be64)               // K = base32 解码后的种子
//! offset = HMAC[19] & 0x0f                   // 动态截断
//! code = (HMAC[offset..] & 0x7fffffff) % 10^digits
//! ```
//!
//! ## 种子形态
//! 存储面（`credentials.totp_secret_enc`）存的是**用户原样输入的 base32
//! 字符串**——可能带空格、可能小写、padding 可能不齐（前端 `vault/api.ts`
//! 明写「normalize 挂账 TOTP 生成器任务」，就是本 crate 接手的那一棒）。
//! 因此 [`TotpSecret::from_base32`] 负责 normalize：去空白 → 大写 → 补
//! padding → 解码。
//!
//! ## 时间来源
//! 所有生成函数都**显式接收 unix 时间**（[`generate`]），不读系统时钟——
//! 这样测试可用 RFC 官方向量做确定性断言，生产侧再由调用方取当前时间。

use data_encoding::BASE32;
use hmac::KeyInit;
use hmac::{Hmac, Mac};
use sha1::Sha1;

/// 默认位数（RFC 4226 建议 6 位，主流验证器均用 6）。
pub const DEFAULT_DIGITS: u32 = 6;
/// 默认时间步长（秒）。
pub const DEFAULT_PERIOD: u64 = 30;

/// TOTP 计算/解析错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TotpError {
    /// base32 字符串非法（字符集错误或长度不对齐）。
    InvalidBase32,
    /// 种子为空。
    EmptySecret,
    /// 解码后种子太短（RFC 4226 要求至少 128 bit，这里保守取 80 bit）。
    SecretTooShort,
    /// 位数不合法（0 或 > 10）。
    InvalidDigits,
}

impl std::fmt::Display for TotpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBase32 => write!(f, "invalid base32 secret"),
            Self::EmptySecret => write!(f, "empty TOTP secret"),
            Self::SecretTooShort => write!(f, "TOTP secret too short"),
            Self::InvalidDigits => write!(f, "TOTP digits must be within 1..=10"),
        }
    }
}

impl std::error::Error for TotpError {}

/// 已解码的 TOTP 种子。
///
/// **手写 Debug**：不 derive——derive 会把 `bytes: Vec<u8>` 原样打印成字节数组，
/// 等于把**种子写进日志**（谁 `{:?}` 打印一次就泄露一次）。这里只输出存在标记。
#[derive(Clone, PartialEq, Eq)]
pub struct TotpSecret {
    bytes: Vec<u8>,
}

impl std::fmt::Debug for TotpSecret {
    /// **不输出种子内容**——derive(Debug) 会把字节数组原样打印（= 写进日志）。
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TotpSecret")
            .field(
                "bytes",
                &format_args!("<{} bytes redacted>", self.bytes.len()),
            )
            .finish()
    }
}

impl TotpSecret {
    /// 从用户原样输入的 base32 字符串构造（自动 normalize）。
    ///
    /// normalize 口径：去所有空白 → 转大写 → 去掉已有 `=` → 补齐到 8 的倍数
    /// 的 `=` padding → base32 解码。
    ///
    /// 错误：
    /// - 空串 → [`TotpError::EmptySecret`]
    /// - 含 base32 字符集外字符 → [`TotpError::InvalidBase32`]
    /// - 解码后不足 10 字节（80 bit）→ [`TotpError::SecretTooShort`]
    pub fn from_base32(raw: &str) -> Result<Self, TotpError> {
        let cleaned: String = raw
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '=')
            .collect::<String>()
            .to_ascii_uppercase();
        if cleaned.is_empty() {
            return Err(TotpError::EmptySecret);
        }
        if !cleaned
            .chars()
            .all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c))
        {
            return Err(TotpError::InvalidBase32);
        }
        // 补 padding：base32 每 5 字节 → 8 字符
        let padded_len = cleaned.len().div_ceil(8) * 8;
        let padded = format!("{}{}", cleaned, "=".repeat(padded_len - cleaned.len()));
        let bytes = BASE32
            .decode(padded.as_bytes())
            .map_err(|_| TotpError::InvalidBase32)?;
        if bytes.len() < 10 {
            return Err(TotpError::SecretTooShort);
        }
        Ok(Self { bytes })
    }

    /// 原始种子字节。
    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }
}

/// 距当前时间步结束还剩多少秒（用于 UI 倒计时）。
///
/// `unix_time` 为当前 Unix 秒；`period` 为时间步长（默认 30s）。
pub fn remaining_seconds(unix_time: i64, period: u64) -> u64 {
    if period == 0 {
        return 0;
    }
    let step = unix_time.div_euclid(period as i64);
    let next = (step + 1) * period as i64;
    (next - unix_time).max(0) as u64
}

/// 生成 TOTP 验证码。
///
/// - `secret`：已解码的种子；
/// - `unix_time`：当前 Unix 秒（显式传入 → 确定性可测）；
/// - `digits`：验证码位数（默认 6）；
/// - `period`：时间步长秒数（默认 30）。
///
/// 返回零填充的十进制字符串（不足位数前补 0）。
pub fn generate(
    secret: &TotpSecret,
    unix_time: i64,
    digits: u32,
    period: u64,
) -> Result<String, TotpError> {
    if digits == 0 || digits > 10 {
        return Err(TotpError::InvalidDigits);
    }
    if period == 0 {
        return Err(TotpError::InvalidDigits);
    }
    let counter = unix_time.div_euclid(period as i64) as u64;
    let mut mac =
        Hmac::<Sha1>::new_from_slice(secret.as_bytes()).map_err(|_| TotpError::InvalidBase32)?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();

    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32);
    let modulo = 10u32.pow(digits);
    let code = binary % modulo;
    Ok(format!("{:0width$}", code, width = digits as usize))
}

/// 便捷入口：直接吃 base32 字符串 + 时间，生成验证码（normalize + 生成一步到位）。
pub fn generate_from_base32(
    raw: &str,
    unix_time: i64,
    digits: u32,
    period: u64,
) -> Result<String, TotpError> {
    let secret = TotpSecret::from_base32(raw)?;
    generate(&secret, unix_time, digits, period)
}
