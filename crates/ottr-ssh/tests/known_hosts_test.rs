//! known_hosts 解析 API TDD（BL-211）：行级指纹（跳过 marker/注释/hashed 行）
//! 加 host 过滤 pin（多 host 混合样本不再「取首条」）——`@cert-authority` /
//! `@revoked` 行绝不参与 pin（fail-closed：filter 不命中 = None = 上层拒绝）。
//!
//! 金样向量：ed25519 公钥（`ssh-keygen -lf` 实测指纹），
//! `SHA256:aQYbRlhLOCUDFmDqZp0i2/ltZvBtACX57D/77LUPAU4`。
use ottr_ssh::known_hosts::{
    KnownHostEntry, fingerprint_for_host, key_type_rank, line_fingerprint, parse_known_hosts_file,
    select_by_endpoint,
};

const GOLDEN_B64: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIKGG+QLrOYImKV/X+7f0EJ1eqaBx7XCX7Dqa2/+VS+/w";
const GOLDEN_FP: &str = "SHA256:aQYbRlhLOCUDFmDqZp0i2/ltZvBtACX57D/77LUPAU4";

// 导入面（parse_known_hosts_file）的三枚真实密钥向量——`ssh-keygen -lf` 实测：
// ed25519（A）、rsa 2048（B）、ed25519（C）。多密钥型并存（A+B 同端点）
// 与「同端点两枚 ed25519」（A+C）各占一条。
const ED_A_B64: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIKPIUNPWpfNnFCOjjQie93LwEi1mRo+R3tX36v8IKGxH";
const ED_A_FP: &str = "SHA256:pa73sHYbI8OWfh46t85LS1g0pTlqeryQLEvZ6rSlJYI";
const RSA_B_B64: &str = "AAAAB3NzaC1yc2EAAAADAQABAAABAQDSWJhNr4MnPr7HacgxTTDzwtD549oSc0jOxBOu0S3Vcql5gXZvypHcKEqw47EFaQPzCz5CoA4TiJ9s/spxSvlckfn+sJUQdCC2VIIMcsjyn/Iim8mHXLOR2GK02Gl+yTxT9oa9GrQHUfcqZSeLNB96+7ikwmFoTxxVQ/PG7CGz++OQAx8T+KhxmMCNiELFQVValZgSXNhvtDdXGQrB21a2bc9nIWn8l9XRIBZIx9IqfuGT9j3X9O1/w6o/lV0JcW3arcHnqArrk1lDsogVIUrKTVX7L4Gioc+zr6qHxo/Vm3CLiaz8n7q7bKizBEwRLMIoYhCCSpLDIiBfTmlr/UBN";
const RSA_B_FP: &str = "SHA256:ovJfhD+XEYlrF+6vhXXCG2f+7ks1NfxeCvaF1HDSpis";
const ED_C_B64: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIPlkTG/1N2iFOeEV+2UFSL23f4iYIVeFONGUhzMg8jAc";
const ED_C_FP: &str = "SHA256:m6ASW1c91g6d2RVPQBvGpXHKQHQNKuAL43L772eAgc4";

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

// ---------------------------------------------------------------------------
// 整文件解析（导入本地 known_hosts 的解析面，2026-11-02）
// ---------------------------------------------------------------------------

/// 注释行 / 空行 / 纯空白行 / hashed（`|1|…`）/ marker（`@cert-authority`、
/// `@revoked`）行一律跳过——只留规范三列行。
#[test]
fn parse_known_hosts_file_skips_comments_blanks_hashed_and_markers() {
    let content = format!(
        "# a comment\n\
         \n\
         \x20  \t \n\
         |1|c2FsdHNhbHQ=|aGFzaA==|ssh-ed25519 {ED_A_B64}\n\
         @cert-authority *.example.com ssh-ed25519 {ED_A_B64}\n\
         @revoked old.example.com ssh-ed25519 {ED_A_B64}\n\
         real.example.com ssh-ed25519 {ED_A_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    assert_eq!(
        parsed,
        vec![KnownHostEntry {
            host: "real.example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: ED_A_FP.to_string(),
        }]
    );
}

/// 端口解析：`[host]:port` 取方括号里的端口；裸 host 缺省 22
/// （OpenSSH 惯例，与 `fingerprint_for_host` 同口径）。
#[test]
fn parse_known_hosts_file_extracts_port_and_defaults_to_22() {
    let content = format!(
        "[10.0.0.1]:2222 ssh-ed25519 {ED_A_B64}\n\
         bare.example.com ssh-ed25519 {ED_C_B64}\n\
         [example.org]:2200 ssh-ed25519 {ED_C_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    assert_eq!(
        parsed,
        vec![
            KnownHostEntry {
                host: "10.0.0.1".to_string(),
                port: 2222,
                key_type: "ssh-ed25519".to_string(),
                fingerprint: ED_A_FP.to_string(),
            },
            KnownHostEntry {
                host: "bare.example.com".to_string(),
                port: 22,
                key_type: "ssh-ed25519".to_string(),
                fingerprint: ED_C_FP.to_string(),
            },
            KnownHostEntry {
                host: "example.org".to_string(),
                port: 2200,
                key_type: "ssh-ed25519".to_string(),
                fingerprint: ED_C_FP.to_string(),
            },
        ]
    );
}

/// IPv6 端点：OpenSSH 一律写成 `[addr]:port`（含 22 端口）——地址还原为裸
/// IPv6（方括号由上层 `host_endpoint_key` 统一补回）。
#[test]
fn parse_known_hosts_file_handles_ipv6_bracket_form() {
    let content = format!("[fe80::1]:2222 ssh-ed25519 {ED_A_B64}\n");
    let parsed = parse_known_hosts_file(&content);
    assert_eq!(
        parsed,
        vec![KnownHostEntry {
            host: "fe80::1".to_string(),
            port: 2222,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: ED_A_FP.to_string(),
        }]
    );
}

/// 一个 host 多枚密钥（rsa/ecdsa/ed25519 并存）——**全部返回**（由上层择一，
/// 本函数不做取舍）。
#[test]
fn parse_known_hosts_file_returns_every_key_of_a_host() {
    let content = format!(
        "multi.example.com ssh-ed25519 {ED_A_B64}\n\
         multi.example.com ssh-rsa {RSA_B_B64}\n\
         multi.example.com ssh-ed25519 {ED_C_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    assert_eq!(
        parsed,
        vec![
            KnownHostEntry {
                host: "multi.example.com".to_string(),
                port: 22,
                key_type: "ssh-ed25519".to_string(),
                fingerprint: ED_A_FP.to_string(),
            },
            KnownHostEntry {
                host: "multi.example.com".to_string(),
                port: 22,
                key_type: "ssh-rsa".to_string(),
                fingerprint: RSA_B_FP.to_string(),
            },
            KnownHostEntry {
                host: "multi.example.com".to_string(),
                port: 22,
                key_type: "ssh-ed25519".to_string(),
                fingerprint: ED_C_FP.to_string(),
            },
        ]
    );
}

/// host 列的逗号分隔 pattern（OpenSSH 允许一行多 host）——拆成各自端点，
/// 绝不把 "a,b" 当成一个主机名（那会生出查无此主的伪端点）。
#[test]
fn parse_known_hosts_file_splits_comma_separated_patterns() {
    let content = format!("a.example.com,b.example.com ssh-ed25519 {ED_A_B64}\n");
    let parsed = parse_known_hosts_file(&content);
    assert_eq!(
        parsed,
        vec![
            KnownHostEntry {
                host: "a.example.com".to_string(),
                port: 22,
                key_type: "ssh-ed25519".to_string(),
                fingerprint: ED_A_FP.to_string(),
            },
            KnownHostEntry {
                host: "b.example.com".to_string(),
                port: 22,
                key_type: "ssh-ed25519".to_string(),
                fingerprint: ED_A_FP.to_string(),
            },
        ]
    );
}

/// 垃圾/畸形行不产出条目：列数不对、b64 非法、端口非法。
#[test]
fn parse_known_hosts_file_skips_malformed_lines() {
    let content = format!(
        "only-two-columns ssh-ed25519\n\
         bad.b64.example.com ssh-ed25519 !!!not-b64!!!\n\
         [h.example.com]:notaport ssh-ed25519 {ED_A_B64}\n\
         [h.example.com]:0 ssh-ed25519 {ED_A_B64}\n\
         good.example.com ssh-ed25519 {ED_A_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    assert_eq!(
        parsed,
        vec![KnownHostEntry {
            host: "good.example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: ED_A_FP.to_string(),
        }]
    );
}

// ---------------------------------------------------------------------------
// 端点归组 + 择一（用户裁定 2026-11-02：同端点多密钥型**优先 ed25519**）
// ---------------------------------------------------------------------------

/// 择一优先级：同端点并存 rsa 与 ed25519 时，**ed25519 夺魁**——落库的是
/// 服务端最可能实际出示的那一枚（否则首次连接会因指纹不符被判 changed）。
#[test]
fn select_by_endpoint_prefers_ed25519_over_rsa_regardless_of_file_order() {
    let content = format!(
        "multi.example.com ssh-rsa {RSA_B_B64}\n\
         multi.example.com ssh-ed25519 {ED_A_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    let selected = select_by_endpoint(&parsed);
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].host, "multi.example.com");
    assert_eq!(selected[0].port, 22);
    // 落库的是 ed25519 那一枚（尽管它在文件里排第二）。
    assert_eq!(selected[0].fingerprint, ED_A_FP);
    // 候选集保留两枚——既有锚 ∈ 候选集 → 判重复而非冲突。
    assert_eq!(selected[0].candidates.len(), 2);
    assert!(selected[0].candidates.iter().any(|c| c == RSA_B_FP));
    assert!(selected[0].candidates.iter().any(|c| c == ED_A_FP));
}

/// 择一优先级：ecdsa-sha2-nistp256 优先于 ssh-rsa。
#[test]
fn select_by_endpoint_prefers_ecdsa_over_rsa() {
    let content = format!(
        "multi.example.com ssh-rsa {RSA_B_B64}\n\
         multi.example.com ecdsa-sha2-nistp256 {ED_A_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    let selected = select_by_endpoint(&parsed);
    assert_eq!(selected[0].fingerprint, ED_A_FP);
}

/// 择一优先级表：ed25519 > ecdsa-256/384/521 > rsa，未知型无排名。
#[test]
fn key_type_rank_orders_ed25519_first_and_rsa_last() {
    assert_eq!(key_type_rank("ssh-ed25519"), Some(0));
    assert_eq!(key_type_rank("ecdsa-sha2-nistp256"), Some(1));
    assert_eq!(key_type_rank("ssh-rsa"), Some(4));
    assert_eq!(key_type_rank("sk-ssh-ed25519@openssh.com"), None);
}

/// 同密钥型多行（文件序首条夺魁——与既有 `fingerprint_for_host` 的取首条
/// 口径一致），候选集仍收全。
#[test]
fn select_by_endpoint_keeps_first_of_same_key_type() {
    let content = format!(
        "multi.example.com ssh-ed25519 {ED_A_B64}\n\
         multi.example.com ssh-ed25519 {ED_C_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    let selected = select_by_endpoint(&parsed);
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].fingerprint, ED_A_FP);
    assert_eq!(selected[0].candidates.len(), 2);
}

/// 不同端点互不干扰（归组按 host+port）。
#[test]
fn select_by_endpoint_groups_per_endpoint() {
    let content = format!(
        "a.example.com ssh-rsa {RSA_B_B64}\n\
         b.example.com ssh-rsa {RSA_B_B64}\n\
         [a.example.com]:2222 ssh-rsa {RSA_B_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    let selected = select_by_endpoint(&parsed);
    assert_eq!(selected.len(), 3);
}
