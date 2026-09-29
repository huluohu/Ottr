//! 会话级文本解码：UTF-8（默认）/ GBK 双模式与 LANG 检测提示。
//!
//! 纯同步字节 → `String` 转换，供传输层（ottr-ssh）在文本层之后、渲染之前
//! 调用。切换 [`Decoder::set_encoding`] 后对同一字节流重新 [`Decoder::decode`]
//! 即得切换语义（Phase 0 spike：无 GUI，切换语义由单测与 headless example 验证）。

/// 会话解码编码。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Encoding {
    /// UTF-8（默认）。
    #[default]
    Utf8,
    /// GBK（简体中文 Windows 服务器家族，含 GB2312/GB18030 提示）。
    Gbk,
}

impl Encoding {
    /// 报告/日志用的编码名。
    pub fn name(&self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Gbk => "GBK",
        }
    }

    /// 字符集段是否属于 GBK 家族（GBK/GB2312/GB18030，大小写不敏感）。
    fn is_gbk_family(locale_lower: &str) -> bool {
        locale_lower.contains("gbk")
            || locale_lower.contains("gb2312")
            || locale_lower.contains("gb18030")
    }
}

/// 有编码状态的解码器（`encoding` 即全部状态；`decode` 按整段字节无跨调用残留）。
#[derive(Debug, Clone, Default)]
pub struct Decoder {
    encoding: Encoding,
}

impl Decoder {
    pub fn new(encoding: Encoding) -> Self {
        Self { encoding }
    }

    pub fn encoding(&self) -> Encoding {
        self.encoding
    }

    /// 会话级切换：之后对同一字节流重新 `decode` 即得新编码的渲染。
    pub fn set_encoding(&mut self, encoding: Encoding) {
        self.encoding = encoding;
    }

    /// 解码一段完整字节为显示文本。任何字节序列都不 panic：
    /// 非法序列按所选编码输出替换符 U+FFFD。GBK 模式用
    /// `decode_with_bom_removal` 而非 `decode`——后者带 BOM 嗅探，会因
    /// 流头部恰似 BOM 的字节（如 FF FE）整段偷换编码，违反「选了 GBK
    /// 就按 GBK」的会话契约。
    pub fn decode(&self, bytes: &[u8]) -> String {
        match self.encoding {
            Encoding::Utf8 => String::from_utf8_lossy(bytes).into_owned(),
            Encoding::Gbk => encoding_rs::GBK
                .decode_with_bom_removal(bytes)
                .0
                .into_owned(),
        }
    }

    /// LANG 检测提示：把 `echo $LANG`（及 `locale` 输出）映射为编码建议。
    ///
    /// 规则（大小写不敏感，对整个 locale 串匹配字符集段）：
    /// - 含 `GBK` / `GB2312` / `GB18030` → [`Encoding::Gbk`]；
    /// - 其余（`C`、`C.UTF-8`、`en_*.*UTF-8`、`zh_CN.UTF-8`、`POSIX`、
    ///   无法识别的串、空串）→ [`Encoding::Utf8`] 兜底。
    pub fn detect_hint(locale_output: &str) -> Encoding {
        let lower = locale_output.to_ascii_lowercase();
        if Encoding::is_gbk_family(&lower) {
            Encoding::Gbk
        } else {
            Encoding::Utf8
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「中文测试 GBK 输出」的 GBK 字节（17 字节，与夹具 gbk-echo 一致）。
    const GBK_PAYLOAD: &[u8] = &[
        0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4, 0x20, 0x47, 0x42, 0x4B, 0x20, 0xCA, 0xE4,
        0xB3, 0xF6,
    ];
    const TEXT: &str = "中文测试 GBK 输出";

    #[test]
    fn utf8_decodes_chinese_text() {
        let d = Decoder::new(Encoding::Utf8);
        assert_eq!(d.decode(TEXT.as_bytes()), TEXT);
        assert_eq!(d.encoding(), Encoding::Utf8);
    }

    #[test]
    fn gbk_fixture_bytes_decode_exact_text() {
        let d = Decoder::new(Encoding::Gbk);
        assert_eq!(d.decode(GBK_PAYLOAD), TEXT);
    }

    #[test]
    fn d6d0cec4_is_zhongwen() {
        // 简报点名的 D6 D0 CE C4（GBK「中文」）。
        let d = Decoder::new(Encoding::Gbk);
        assert_eq!(d.decode(&[0xD6, 0xD0, 0xCE, 0xC4]), "中文");
    }

    #[test]
    fn gbk_lead_pair_in_utf8_mode_is_two_replacements() {
        // 边界（Task 10 裁定 4）：合法 GBK 但非法 UTF-8 的流，Utf8 模式下输出
        // 替换符。D6/D0 各是「孤 lead 字节」（error_len=1）→ 恰 2 个 U+FFFD
        // （std 语义，Task 5 §4 已核实）。
        let d = Decoder::new(Encoding::Utf8);
        assert_eq!(d.decode(&[0xD6, 0xD0]), "\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn full_gbk_payload_in_utf8_mode_is_mojibake_with_ascii_intact() {
        // 整段 GBK 流在 Utf8 模式：CJK 段出替换符（含个别 GBK 对恰好构成合法
        // UTF-8 的例外），ASCII 段 " GBK " 原样保留；不 panic。
        let d = Decoder::new(Encoding::Utf8);
        let out = d.decode(GBK_PAYLOAD);
        assert!(
            out.contains('\u{FFFD}'),
            "expected replacement chars: {out:?}"
        );
        assert!(out.contains(" GBK "), "ASCII run must survive: {out:?}");
        assert!(
            !out.contains("中文"),
            "GBK bytes must not decode as 中文 in UTF-8: {out:?}"
        );
    }

    #[test]
    fn invalid_bytes_never_panic() {
        let utf8 = Decoder::new(Encoding::Utf8);
        let gbk = Decoder::new(Encoding::Gbk);
        for bytes in [
            &b""[..],
            &[0xFF],
            &[0x80],
            &[0xE4, 0xB8][..], // 残缺 UTF-8 3 字节序列
            &[0xD6],           // 残缺 GBK lead（块尾截断）
            &[0x40],           // GBK 独立 trail 范围字节作 lead 位
            &[0x81, 0x7F],     // GBK trail 越界（0x7F 非法）
        ] {
            let _ = utf8.decode(bytes);
            let _ = gbk.decode(bytes);
        }
        // 具体语义抽查：Gbk 模式残缺 lead → 替换符，不 panic。
        assert_eq!(gbk.decode(&[0xD6]), "\u{FFFD}");
    }

    #[test]
    fn torn_gbk_pair_across_chunks_yields_replacements_not_panic() {
        // 裁定 3：GBK 双字节在 chunk 边界撕裂的容错。Decoder 无跨调用状态
        // （Phase 0 语义：切换靠整段重解），残块各自独立解码、不 panic。
        let d = Decoder::new(Encoding::Gbk);
        // 整段到达：解出「中」。
        assert_eq!(d.decode(&[0xD6, 0xD0]), "中");
        // 撕裂到达（lead 在 chunk1 尾、trail 在 chunk2 头）：各出恰 1 个替换符。
        assert_eq!(d.decode(&[0xD6]), "\u{FFFD}");
        assert_eq!(d.decode(&[0xD0]), "\u{FFFD}");
    }

    #[test]
    fn gbk_mode_never_switches_encoding_on_bom_like_bytes() {
        // encoding_rs 的 decode() 带 BOM 嗅探：FF FE（UTF-16LE BOM）会把整段
        // 偷换成 UTF-16 解码。会话解码器的契约是「选了 GBK 就按 GBK」，
        // 编码只随会话显式切换，绝不被字节内容偷换。
        let d = Decoder::new(Encoding::Gbk);
        let out = d.decode(&[0xFF, 0xFE]);
        assert!(
            !out.is_empty(),
            "FF FE got BOM-stripped (sniffed as UTF-16): {out:?}"
        );
    }

    #[test]
    fn utf8_bytes_in_gbk_mode_are_lossy_not_panic() {
        let d = Decoder::new(Encoding::Gbk);
        let out = d.decode("中文".as_bytes()); // E4 B8 AD E6 96 87
        assert!(!out.is_empty());
        assert!(!out.contains('\u{0}'));
    }

    #[test]
    fn session_switch_redecodes_same_bytes() {
        // 简报 Step 2 语义：默认 UTF-8 乱码 → 切 GBK 正确 → 切回 UTF-8 再乱码。
        let mut d = Decoder::default();
        assert_eq!(d.encoding(), Encoding::Utf8);
        let mojibake_1 = d.decode(GBK_PAYLOAD);
        assert!(mojibake_1.contains('\u{FFFD}'));

        d.set_encoding(Encoding::Gbk);
        assert_eq!(d.encoding(), Encoding::Gbk);
        assert_eq!(d.decode(GBK_PAYLOAD), TEXT);

        d.set_encoding(Encoding::Utf8);
        assert_eq!(d.decode(GBK_PAYLOAD), mojibake_1);
        assert!(d.decode(GBK_PAYLOAD).contains('\u{FFFD}'));
    }

    #[test]
    fn detect_hint_maps_utf8_locales() {
        for locale in [
            "C",
            "C.UTF-8",
            "POSIX",
            "en_US.UTF-8",
            "en_GB.utf-8",
            "zh_CN.UTF-8",
            "",
            "ru_RU.KOI8-R",
        ] {
            assert_eq!(
                Decoder::detect_hint(locale),
                Encoding::Utf8,
                "locale {locale:?} should hint UTF-8"
            );
        }
    }

    #[test]
    fn detect_hint_maps_gbk_family_locales() {
        for locale in [
            "zh_CN.GBK",
            "zh_CN.gbk",
            "zh_CN.GB2312",
            "zh_CN.gb2312",
            "zh_CN.GB18030",
            "zh_SG.GB18030",
        ] {
            assert_eq!(
                Decoder::detect_hint(locale),
                Encoding::Gbk,
                "locale {locale:?} should hint GBK"
            );
        }
    }

    #[test]
    fn detect_hint_reads_multiline_locale_output() {
        // `locale` 命令输出多行，取任一含 GBK 的行即应提示 GBK。
        let out = "LANG=en_US.UTF-8\nLC_ALL=zh_CN.GBK\n";
        assert_eq!(Decoder::detect_hint(out), Encoding::Gbk);
    }

    #[test]
    fn encoding_names_for_reports() {
        assert_eq!(Encoding::Utf8.name(), "UTF-8");
        assert_eq!(Encoding::Gbk.name(), "GBK");
    }
}
