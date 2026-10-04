//! known_hosts 解析 API TDD（BL-211）：行级指纹（跳过 marker/注释/hashed 行）
//! + host 过滤 pin（多 host 混合样本不再「取首条」）——`@cert-authority` /
//! `@revoked` 行绝不参与 pin（fail-closed：filter 不命中 = None = 上层拒绝）。
//!
//! 金样向量：ed25519 公钥（`ssh-keygen -lf` 实测指纹），
//! `SHA256:aQYbRlhLOCUDFmDqZp0i2/ltZvBtACX57D/77LUPAU4`。
use ottr_ssh::known_hosts::{fingerprint_for_host, line_fingerprint};

const GOLDEN_B64: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIKGG+QLrOYImKV/X+7f0EJ1eqaBx7XCX7Dqa2/+VS+/w";
const GOLDEN_FP: &str = "SHA256:aQYbRlhLOCUDFmDqZp0i2/ltZvBtACX57D/77LUPAU4";

/// keyscan 输出形态：`[127.0.0.1]:2222 ssh-ed25519 <b64>`（非 22 端口的
/// OpenSSH 惯例方括号形态）。
const KEYSCAN_LINE: &str = "[127.0.0.1]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKGG+QLrOYImKV/X+7f0EJ1eqaBx7XCX7Dqa2/+VS+/w";

#[test]
fn line_fingerprint_matches_ssh_keygen_golden() {
    assert_eq!(line_fingerprint(KEYSCAN_LINE), Some(GOLDEN_FP.to_string()));
}

/// marker 行（`@cert-authority` / `@revoked`）不参与指纹解析——混合样本里
/// 金样行夹在 marker 行之间仍可提取，marker 行自身返回 None。
#[test]
fn marker_lines_never_yield_fingerprints() {
    let ca_line = format!("@cert-authority *.example.com ssh-ed25519 {GOLDEN_B64}");
    let revoked = format!("@revoked old.example.com ssh-ed25519 {GOLDEN_B64}");
    // marker 行自身：None（它们不是该主机的个人密钥，参与 pin 会错钉 CA/已吊销钥）。
    assert_eq!(line_fingerprint(&ca_line), None);
    assert_eq!(line_fingerprint(&revoked), None);
    // 混合文件：金样行夹在 marker/注释/空行之间，逐行仍各得其所。
    let mixed = format!("# comment\n\n{ca_line}\n{revoked}\n{KEYSCAN_LINE}\n");
    let hit: Vec<String> = mixed.lines().filter_map(line_fingerprint).collect();
    assert_eq!(hit, vec![GOLDEN_FP.to_string()]);
}

/// hashed（`|1|…`）known_hosts 行防御性跳过——keyscan 不产出，但手维护文件
/// 可能混入；按 None 处理（上层继续找规范行，找不到 = fail-closed）。
#[test]
fn hashed_lines_are_skipped() {
    assert_eq!(
        line_fingerprint("|1|c2FsdA== aGFzaA== ssh-ed25519 AAAA"),
        None
    );
}

/// host 过滤 pin：多 host 文件只取目标端点的行；marker 行不命中。
#[test]
fn fingerprint_for_host_filters_marker_and_other_hosts() {
    let content = format!(
        "# spike fixture\n\
         other.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL3j8OtherKeyJunk/w\n\
         @cert-authority *.example.com ssh-ed25519 {GOLDEN_B64}\n\
         @revoked [127.0.0.1]:2222 ssh-ed25519 {GOLDEN_B64}\n\
         10.9.9.9 ssh-rsa AAAAB3NzaC1yc2EJUNKJUNKJUNK\n\
         {KEYSCAN_LINE}\n"
    );
    assert_eq!(
        fingerprint_for_host(&content, "127.0.0.1", 2222),
        Some(GOLDEN_FP.to_string())
    );
    // 另一端点：只能命中它自己的行——JUNK 不是合法 b64 → None。
    assert_eq!(fingerprint_for_host(&content, "10.9.9.9", 22), None);
    // 不存在的端点 → None（fail-closed）。
    assert_eq!(fingerprint_for_host(&content, "10.9.9.9", 2222), None);
}

/// 22 端口：keyscan/OpenSSH 产出裸 hostname 形态（无方括号端口段）。
#[test]
fn port_22_matches_bare_hostname_form() {
    let content = format!("spike.example.com ssh-ed25519 {GOLDEN_B64}\n");
    assert_eq!(
        fingerprint_for_host(&content, "spike.example.com", 22),
        Some(GOLDEN_FP.to_string())
    );
}

/// 垃圾输入表：注释/空行/列数不符/坏 b64/非规范行 → 一律 None。
#[test]
fn junk_inputs_yield_none() {
    assert_eq!(line_fingerprint(""), None);
    assert_eq!(line_fingerprint("   "), None);
    assert_eq!(line_fingerprint("# comment"), None);
    assert_eq!(line_fingerprint("host ssh-ed25519"), None);
    assert_eq!(line_fingerprint("host ssh-ed25519 !!!not-b64!!!"), None);
    assert_eq!(line_fingerprint("a b c d"), None);
    assert_eq!(fingerprint_for_host("garbage", "h", 22), None);
}
