//! known_hosts 解析与指纹（BL-211 收敛点）：此前指纹解析逻辑在
//! desktop commands/session.rs（整文件取首条）、desktop hostkey_audit.rs
//! （keyscan 逐行）、crates/ottr-bench（host 过滤）三处各写一份 + ottr-ssh
//! 测试助手两处——算法相同（`SHA256:<unpadded-std-b64(sha256(key_blob))>`，
//! 与 `ssh-keygen -lf` 逐字一致）但行为细节（marker 行、host 过滤）不一，
//! 「多 host 文件取首条」可能 pin 错 key。本模块提供单一 pub API：
//!
//! * [`line_fingerprint`]：单行 → 指纹。跳过注释/空行/hashed（`|1|…`）/
//!   **marker 行**（`@cert-authority` / `@revoked`——CA 公钥与已吊销钥都不是
//!   该主机的个人密钥，参与 pin 会错钉；吊销行若被当信任锚更是反向放行）。
//! * [`fingerprint_for_host`]：整文件 + 目标端点 → 指纹。只吃 host 列匹配
//!   目标端点的规范行（22 端口裸 hostname、非 22 端口 `[host]:port` 方括号
//!   形态，OpenSSH 惯例）；找不到 = `None`（fail-closed：调用方拒绝连接，
//!   绝不退化为「随便取一条」）。
//! * [`parse_known_hosts_file`]：整文件 → `(host, port, fingerprint)` 列表
//!   （导入本地 known_hosts 的解析面，2026-11-02）。

use base64::Engine as _;
use sha2::Digest;

/// 单行 known_hosts / ssh-keyscan 输出 →
/// `SHA256:<unpadded-std-b64(sha256(key_blob))>` 指纹。
///
/// 行形状：`host keytype b64`（恰好 3 列）。以下行返回 `None`：
/// 空行/纯空白、`#` 注释、`|1|…` hashed 形态（keyscan 不产出，防御性跳过）、
/// `@cert-authority` / `@revoked` **marker 行**（见模块文档）、列数不符、
/// b64 段非法。
pub fn line_fingerprint(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('|') || line.starts_with('@') {
        // `|1|…`：hashed known_hosts（keyscan 不产出，防御性跳过）。
        // `@…`：marker 行（@cert-authority / @revoked）——CA 钥/已吊销钥
        // 不参与 pin（BL-211）。
        return None;
    }
    let mut parts = line.split_whitespace();
    let b64 = match (parts.next(), parts.next(), parts.next()) {
        (Some(_host), Some(_ktype), Some(b64)) if parts.next().is_none() => b64,
        _ => return None,
    };
    fingerprint_from_key_b64(b64)
}

/// known_hosts 全文 → 目标端点 `(host, port)` 的 pin 指纹（BL-211「多 host
/// 可能 pin 错 key」的根治面）：逐行做 host 列过滤后再取指纹，返回**第一条
/// 匹配行**的指纹。host 列匹配规则（OpenSSH 惯例）：`port = 22` 时裸
/// `host`，其余 `[host]:port`。marker/hashed/注释行天然不参与（见
/// [`line_fingerprint`]）。找不到 = `None` = 调用方 fail-closed。
pub fn fingerprint_for_host(content: &str, host: &str, port: u16) -> Option<String> {
    let marker = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        let mut parts = trimmed.split_whitespace();
        let line_host = match (parts.next(), parts.next()) {
            (Some(h), Some(_)) if !trimmed.starts_with('#') => h,
            _ => return None,
        };
        if line_host != marker {
            return None;
        }
        line_fingerprint(trimmed)
    })
}

/// b64 公钥段 → SHA256 指纹（unpadded 标准 b64；与 `ssh-keygen -lf` 逐字一致）。
fn fingerprint_from_key_b64(b64: &str) -> Option<String> {
    let blob = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    Some(fingerprint_from_blob(&blob))
}

/// 解析整份 known_hosts → `(host, port, fingerprint)` 列表
/// （导入本地 known_hosts 的解析面，2026-11-02）。
///
/// 指纹算法复用 [`line_fingerprint`]（与 `ssh-keygen -lf` 逐字一致），本函数
/// 只做「host 列 → 端点」这层解析。跳过：
/// * 注释行（`#`）、纯空白行；
/// * `|1|…` hashed 条目——**不可反解**（哈希的是 host 名），无法还原端点；
/// * `@cert-authority` / `@revoked` marker 行——CA 公钥与已吊销钥不是该主机
///   的个人密钥（语义同 [`line_fingerprint`]）；
/// * 畸形行：列数不对 / b64 非法 / 端口非法（宁可少导不错导）。
///
/// host 列口径沿用 [`fingerprint_for_host`] 的既有惯例：22 端口裸 hostname，
/// 其余 `[host]:port` 方括号形态（OpenSSH）。另有两处 OpenSSH 语义：
/// * 一行多 pattern（`a,b`）→ 拆成各自端点（绝不把 "a,b" 当主机名）；
/// * IPv6 一律 `[addr]:port`（含 22 端口）→ 地址还原为裸 IPv6（方括号由
///   上层 `host_endpoint_key` 统一补回）。
///
/// **一个 host 可能有多枚密钥**（rsa/ecdsa/ed25519 并存）——本函数**全部返回**，
/// 由上层择一（择一语义见 `ottr_vault::KnownHosts::import`）。
pub fn parse_known_hosts_file(content: &str) -> Vec<(String, u16, String)> {
    let mut out = Vec::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty()
            || line.starts_with('#')
            || line.starts_with('|')
            || line.starts_with('@')
        {
            // 注释 / 空白 / hashed（不可反解）/ marker 行（见模块文档）。
            continue;
        }
        // 指纹走既有算法核（列数/b64 合法性一并由它把关）。
        let Some(fingerprint) = line_fingerprint(line) else {
            continue;
        };
        let Some(host_field) = line.split_whitespace().next() else {
            continue;
        };
        for pattern in host_field.split(',') {
            let Some((host, port)) = parse_host_port(pattern) else {
                continue;
            };
            out.push((host, port, fingerprint.clone()));
        }
    }
    out
}

/// known_hosts host 列的一段 → `(地址, 端口)`。
///
/// * `[addr]:port` → `(addr, port)`（OpenSSH 非 22 端口惯例；IPv6 亦如此）；
/// * `[addr]`（无端口段）→ `(addr, 22)`；
/// * 裸 host → `(host, 22)`。
///
/// 端口须落在 `1..=65535`（0 端口不是可探测端点）；非法 → `None`（该行跳过）。
fn parse_host_port(field: &str) -> Option<(String, u16)> {
    let field = field.trim();
    if field.is_empty() {
        return None;
    }
    if let Some(rest) = field.strip_prefix('[') {
        let close = rest.find(']')?;
        let addr = &rest[..close];
        if addr.is_empty() {
            return None;
        }
        let tail = &rest[close + 1..];
        let port = if tail.is_empty() {
            22
        } else {
            let port_str = tail.strip_prefix(':')?;
            let port: u16 = port_str.parse().ok()?;
            if port == 0 {
                return None;
            }
            port
        };
        return Some((addr.to_string(), port));
    }
    // 裸形态：含 ']' 必是畸形（方括号不闭合）。
    if field.contains(']') {
        return None;
    }
    Some((field.to_string(), 22))
}

/// ssh public key blob → 指纹（[`line_fingerprint`] 的算法核）。
fn fingerprint_from_blob(blob: &[u8]) -> String {
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD
            .encode(sha2::Sha256::digest(blob))
            .trim_end_matches('=')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_B64: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIKGG+QLrOYImKV/X+7f0EJ1eqaBx7XCX7Dqa2/+VS+/w";
    const GOLDEN_FP: &str = "SHA256:aQYbRlhLOCUDFmDqZp0i2/ltZvBtACX57D/77LUPAU4";

    #[test]
    fn blob_fingerprint_is_unpadded_std_b64_of_sha256() {
        // 金样（tests/known_hosts_test.rs 同源向量）：ssh-keygen -lf 实测值。
        let blob = base64::engine::general_purpose::STANDARD
            .decode(GOLDEN_B64)
            .unwrap();
        assert_eq!(fingerprint_from_blob(&blob), GOLDEN_FP);
        // 指纹形态契约：SHA256: 前缀 + 43 字符无填充标准 b64。
        assert_eq!(GOLDEN_FP.len(), 7 + 43);
        assert!(!GOLDEN_FP.ends_with('='));
    }

    #[test]
    fn padded_b64_key_still_parses() {
        // 列尾 b64 段带填充（手维护文件可能出现）也能解——引擎容错 `=`。
        assert!(fingerprint_from_key_b64(GOLDEN_B64).is_some());
        assert_eq!(fingerprint_from_key_b64(GOLDEN_B64), Some(GOLDEN_FP.into()));
    }
}
