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
    /// GBK（简体中文 Windows 服务器家族，含 GB2312 提示）。
    Gbk,
    /// GB18030（国标超集，Task 9 切换菜单收录；字节级兼容 GBK）。
    Gb18030,
}

impl Encoding {
    /// 报告/日志用的编码名。
    pub fn name(&self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Gbk => "GBK",
            Encoding::Gb18030 => "GB18030",
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
            Encoding::Gb18030 => encoding_rs::GB18030
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

/// GBK 族的安全切点：从块尾回退「可能未收完的序列」的字节数。
/// 贪婪左→右配对扫描（lead 0x81..=0xFE 吞下一字节作 trail；位置配对与
/// 解码器逐字节状态机一致，纯句法可判）：
/// * `gb18030 = false`（GBK）：双字节序列；
/// * `gb18030 = true`：第二字节 0x30..=0x39 开四字节序列（GB18030 扩充），
///   残尾最多持有 3 字节。
///
/// 切点之前的字节（含坏 trail）整段交给一次性解码器按规范结算——坏序列
/// 的替换符产出与整段喂入完全一致，只是不再跨 chunk 撕裂。
fn gbk_safe_cut(bytes: &[u8], gb18030: bool) -> usize {
    let n = bytes.len();
    let mut i = 0;
    while i < n {
        if (0x81..=0xFE).contains(&bytes[i]) {
            let seq_len = if gb18030
                && i + 1 < n
                && (0x30..=0x39).contains(&bytes[i + 1])
            {
                4
            } else {
                2
            };
            if i + seq_len > n {
                return i; // 块尾停在序列中段 → 从这里持有（1..3 字节）
            }
            i += seq_len;
        } else {
            i += 1;
        }
    }
    n
}

/// 流式会话解码器（Task 9 转发路径消费）：[`Decoder`] 的逐 chunk 变体。
///
/// Phase 0 的 [`Decoder::decode`] 无跨调用状态——chunk 边界上的撕裂序列各自
/// 独立出替换符（spike 台账裁定 3）。转发路径（合批 flush 后、IPC 前）按
/// flush 批喂字节，边界由 4ms 窗口/256KB 上限决定，撕裂概率不可忽略
/// （尤其默认 UTF-8 的 bulk 文本流）；本类型持有块尾的**不完整**序列
/// （UTF-8 ≤3B / GBK 族 1 个 lead 字节）并入下个 chunk，flush 边界不再丢字。
/// 非法序列（真坏字节）仍即时按所选编码出替换符，无跨批滞留。
///
/// 切换语义：[`StreamDecoder::set_encoding`] 先把残字节按**旧编码**结算返回
/// （字节永不丢弃；切换点前的字节按切换前的契约落账），之后 chunk 按新编码。
#[derive(Debug, Clone, Default)]
pub struct StreamDecoder {
    encoding: Encoding,
    residual: Vec<u8>,
}

impl StreamDecoder {
    pub fn new(encoding: Encoding) -> Self {
        Self {
            encoding,
            residual: Vec::new(),
        }
    }

    pub fn encoding(&self) -> Encoding {
        self.encoding
    }

    /// 当前持有的残字节数（≤3；仅测试/诊断读）。
    pub fn residual_len(&self) -> usize {
        self.residual.len()
    }

    /// 切换编码：残字节按旧编码结算（返回值 = 结算文本，调用方转发前端），
    /// 之后 `decode_chunk` 按新编码。即切即生效，从下一个 chunk 起。
    pub fn set_encoding(&mut self, encoding: Encoding) -> String {
        let flushed = self.take_residual_as_text();
        self.encoding = encoding;
        flushed
    }

    /// 会话终止（PTY Eof/Close）：残字节按当前编码结算（不完整序列 → 替换符）。
    pub fn finish(&mut self) -> String {
        self.take_residual_as_text()
    }

    /// 流式解码一段字节。不完整的块尾序列持有至下个调用；真坏字节即时替换。
    pub fn decode_chunk(&mut self, bytes: &[u8]) -> String {
        if self.residual.is_empty() {
            // 快路径：无残字节时零拷贝借入，避免 concat。
            let (text, hold) = self.decode_split(bytes);
            self.residual = hold.to_vec();
            text
        } else {
            let mut buf = std::mem::take(&mut self.residual);
            buf.extend_from_slice(bytes);
            let (text, hold) = self.decode_split(&buf);
            self.residual = hold.to_vec();
            text
        }
    }

    /// 解码 `bytes`，返回（文本, 应持有到下个 chunk 的块尾切片）。
    fn decode_split<'a>(&self, bytes: &'a [u8]) -> (String, &'a [u8]) {
        match self.encoding {
            Encoding::Utf8 => {
                let cut = match std::str::from_utf8(bytes) {
                    Ok(_) => bytes.len(),
                    Err(e) if e.error_len().is_none() => e.valid_up_to(), // 块尾不完整 → 持有
                    Err(_) => bytes.len(), // 中段坏序列 → 整段结算（损失由 lossy 兜底）
                };
                (String::from_utf8_lossy(&bytes[..cut]).into_owned(), &bytes[cut..])
            }
            Encoding::Gbk | Encoding::Gb18030 => {
                let cut = gbk_safe_cut(bytes, self.encoding == Encoding::Gb18030);
                let decoder = match self.encoding {
                    Encoding::Gb18030 => encoding_rs::GB18030,
                    _ => encoding_rs::GBK,
                };
                (decoder.decode_with_bom_removal(&bytes[..cut]).0.into_owned(), &bytes[cut..])
            }
        }
    }

    /// 残字节按当前编码一次性结算（set_encoding / finish 共用）。
    fn take_residual_as_text(&mut self) -> String {
        let residual = std::mem::take(&mut self.residual);
        if residual.is_empty() {
            return String::new();
        }
        Decoder::new(self.encoding).decode(&residual)
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
        assert_eq!(Encoding::Gb18030.name(), "GB18030");
    }

    #[test]
    fn gb18030_fixture_bytes_decode_exact_text() {
        // GB18030 是 GBK 的超集：夹具 GBK 字节按 GB18030 解出同文（T9 菜单面）。
        let d = Decoder::new(Encoding::Gb18030);
        assert_eq!(d.decode(GBK_PAYLOAD), TEXT);
        assert_eq!(d.encoding().name(), "GB18030");
    }

    // --- StreamDecoder（Task 9 转发路径） ------------------------------------

    /// 转发路径核心裁定：任意切法的 chunk 边界都不丢字（合批 flush 边界
    /// 由 4ms 窗口决定，撕裂 UTF-8 序列不再各出替换符）。
    #[test]
    fn stream_utf8_torn_across_chunks_reassembles_exactly() {
        let text = "中文 abc 中文";
        for chunk in 1..text.len() {
            let mut d = StreamDecoder::new(Encoding::Utf8);
            let mut out = String::new();
            for part in text.as_bytes().chunks(chunk) {
                out.push_str(&d.decode_chunk(part));
            }
            out.push_str(&d.finish());
            assert_eq!(out, text, "chunk size {chunk} must reassemble exactly");
            assert_eq!(d.residual_len(), 0);
        }
    }

    /// 中段真坏字节即时替换（不滞留），前后好序列保真。
    #[test]
    fn stream_utf8_invalid_midstream_replaces_immediately() {
        let mut d = StreamDecoder::new(Encoding::Utf8);
        let out = d.decode_chunk(&[0x61, 0xFF, 0xE4, 0xB8, 0xAD]); // a + 坏字节 + 中
        assert_eq!(out, "a\u{FFFD}中");
        assert_eq!(d.residual_len(), 0);
    }

    /// GBK 撕裂双字节跨 chunk：残 lead 持有至下个 chunk，不再是「各 1 替换符」。
    #[test]
    fn stream_gbk_torn_pair_reassembles() {
        let mut d = StreamDecoder::new(Encoding::Gbk);
        assert_eq!(d.decode_chunk(&[0xD6]), "", "孤 lead 持有，不出替换符");
        assert_eq!(d.residual_len(), 1);
        assert_eq!(d.decode_chunk(&[0xD0, 0xCE, 0xC4]), "中文");
        assert_eq!(d.residual_len(), 0);
    }

    /// GBK 流逐字节喂入与整段解码等价（夹具 17B，简报三段验证的数据面基础）。
    #[test]
    fn stream_gbk_bytewise_equals_oneshot() {
        let mut d = StreamDecoder::new(Encoding::Gbk);
        let mut out = String::new();
        for b in GBK_PAYLOAD {
            out.push_str(&d.decode_chunk(&[*b]));
        }
        assert_eq!(out, TEXT);
    }

    /// 切换语义：残字节按旧编码结算返回（字节永不丢弃），之后按新编码。
    #[test]
    fn stream_switch_settles_residual_under_old_encoding() {
        let mut d = StreamDecoder::new(Encoding::Utf8);
        let _ = d.decode_chunk(&[0xE4, 0xB8]); // 残 2B（「中」的前缀）
        let flushed = d.set_encoding(Encoding::Gbk);
        // 旧编码（UTF-8）结算残字节：一个不完整序列 → 恰 1 个替换符；
        // E4 B8 在 GBK 下是合法对，但结算必须按切换前的契约（UTF-8）执行。
        assert_eq!(flushed, "\u{FFFD}");
        assert_eq!(d.residual_len(), 0);
        // 之后按 GBK 解码。
        assert_eq!(d.decode_chunk(&[0xD6, 0xD0]), "中");
        assert_eq!(d.encoding(), Encoding::Gbk);
    }

    /// finish 结算残字节（不完整序列 → 替换符），PTY 收尾不静默丢字。
    #[test]
    fn stream_finish_flushes_residual_as_replacements() {
        let mut d = StreamDecoder::new(Encoding::Utf8);
        d.decode_chunk(&[0xE4, 0xB8]);
        assert_eq!(d.finish(), "\u{FFFD}");
        assert_eq!(d.residual_len(), 0);
    }

    /// GB18030 流式路径（T9 新变体）：撕裂重组 + 残 lead 持有。
    #[test]
    fn stream_gb18030_torn_pair_reassembles() {
        let mut d = StreamDecoder::new(Encoding::Gb18030);
        assert_eq!(d.decode_chunk(&[0xD6]), "");
        assert_eq!(d.decode_chunk(&[0xD0]), "中");
    }

    /// 三段切换语义（转发路径版）：默认 UTF-8 乱码 → 切 GBK 正确 → 切回再乱码。
    /// 与 Phase 0 session_switch_redecodes_same_bytes 对应，但按 chunk 流转。
    #[test]
    fn stream_three_stage_switch_on_fixture_bytes() {
        let mut d = StreamDecoder::default();
        let stage1 = d.decode_chunk(GBK_PAYLOAD);
        assert!(stage1.contains('\u{FFFD}') && stage1.contains(" GBK "));

        d.set_encoding(Encoding::Gbk);
        let stage2 = d.decode_chunk(GBK_PAYLOAD);
        assert_eq!(stage2, TEXT);

        d.set_encoding(Encoding::Utf8);
        let stage3 = d.decode_chunk(GBK_PAYLOAD);
        assert_eq!(stage3, stage1);
    }

    /// BOM 相似字节不偷换编码（同 Decoder 契约，流式路径同样成立）。
    #[test]
    fn stream_gbk_mode_never_switches_on_bom_like_bytes() {
        let mut d = StreamDecoder::new(Encoding::Gbk);
        let out = d.decode_chunk(&[0xFF, 0xFE]);
        assert!(!out.is_empty(), "FF FE got BOM-stripped: {out:?}");
    }
}
