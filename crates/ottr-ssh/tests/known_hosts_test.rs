//! known_hosts 解析 API TDD（BL-211）：行级指纹（跳过 marker/注释/hashed 行）
//! 加 host 过滤 pin（多 host 混合样本不再「取首条」）——`@cert-authority` /
//! `@revoked` 行绝不参与 pin（fail-closed：filter 不命中 = None = 上层拒绝）。
//!
//! 金样向量：ed25519 公钥（`ssh-keygen -lf` 实测指纹），
//! `SHA256:aQYbRlhLOCUDFmDqZp0i2/ltZvBtACX57D/77LUPAU4`。
use ottr_ssh::known_hosts::{
    KnownHostEntry, KnownHostsParseError, MAX_KNOWN_HOSTS_ENTRIES, SelectedEndpoint,
    fingerprint_for_host, key_type_rank, line_fingerprint, parse_known_hosts_file,
    parse_known_hosts_file_limited, select_by_endpoint,
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
        parsed.entries,
        vec![KnownHostEntry {
            host: "real.example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: ED_A_FP.to_string(),
        }]
    );
}

/// OpenSSH 的 known_hosts 允许第 4 列起是自由注释（`host keytype b64 comment`）。
/// 早期实现要求**恰好 3 列**，把这类合法行整行丢弃 → 那个端点导不进信任锚，
/// 首次连接照样弹 TOFU（导入白做）。
#[test]
fn parse_known_hosts_file_accepts_trailing_comment_columns() {
    let content = format!(
        "real.example.com ssh-ed25519 {ED_A_B64} my-laptop\n\
         plain.example.com ssh-ed25519 {ED_A_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    let hosts: Vec<&str> = parsed.entries.iter().map(|e| e.host.as_str()).collect();
    assert_eq!(hosts, vec!["real.example.com", "plain.example.com"]);
    assert_eq!(parsed.entries[0].fingerprint, ED_A_FP);
}

/// host 列是 **pattern**（通配 `*` / `?` / 取反 `!`）时不是端点：运行时按端点
/// 精确匹配（不做通配），取反的语义还正好相反。当成字面主机名落库 = 造一条
/// 永不匹配任何连接的垃圾信任锚，还污染「新增 N 条」计数与巡检结果。
#[test]
fn parse_known_hosts_file_skips_pattern_hosts() {
    let content = format!(
        "*.example.com ssh-ed25519 {ED_A_B64}\n\
         host?.example.com ssh-ed25519 {ED_A_B64}\n\
         !never-trust.example.com ssh-ed25519 {ED_A_B64}\n\
         real.example.com ssh-ed25519 {ED_A_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    let hosts: Vec<&str> = parsed.entries.iter().map(|e| e.host.as_str()).collect();
    assert_eq!(hosts, vec!["real.example.com"]);
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
        parsed.entries,
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
        parsed.entries,
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
        parsed.entries,
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
        parsed.entries,
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
        parsed.entries,
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
    let selected = select_by_endpoint(&parsed.entries);
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
    let selected = select_by_endpoint(&parsed.entries);
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
    let selected = select_by_endpoint(&parsed.entries);
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
    let selected = select_by_endpoint(&parsed.entries);
    assert_eq!(selected.len(), 3);
}

// ---------------------------------------------------------------------------
// 跳过计数（真机 2026-11-02 实测驱动）：设备真实 known_hosts 37 条全是 hashed，
// 报告若只说「新增 0 条」而不交代去向，用户分不清「文件空的 / 全是 hashed /
// 路径指错」——跳过计数是报告诚实性的地基。
// ---------------------------------------------------------------------------

/// hashed 条目（`|1|salt|hash`）不可反解 host → 单独计数，不混入其他跳过。
#[test]
fn parse_counts_hashed_entries_separately() {
    let content = format!(
        "|1|c2FsdHNhbHQ=|aGFzaA==|ssh-ed25519 {ED_A_B64}\n\
         |1|b3RoZXJzYWx0|hash2|ssh-ed25519 {ED_C_B64}\n\
         plain.example.com ssh-ed25519 {ED_A_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    assert_eq!(parsed.entries.len(), 1, "只有明文条目可解析");
    assert_eq!(parsed.skipped_hashed, 2, "两条 hashed 单独计数");
    assert_eq!(parsed.skipped_other, 0);
}

/// marker 行 / 注释行 / 空行 / 畸形行 → 计入其他跳过。
#[test]
fn parse_counts_other_skips() {
    let content = format!(
        "# comment\n\
         \n\
         @cert-authority *.example.com ssh-ed25519 {ED_A_B64}\n\
         @revoked old.example.com ssh-ed25519 {ED_A_B64}\n\
         only-two-columns ssh-ed25519\n\
         bad.b64.example.com ssh-ed25519 !!!not-b64!!!\n\
         good.example.com ssh-ed25519 {ED_A_B64}\n"
    );
    let parsed = parse_known_hosts_file(&content);
    assert_eq!(parsed.entries.len(), 1);
    assert_eq!(parsed.skipped_hashed, 0);
    // 注释 + 空行 + 2 条 marker + 2 条畸形 = 6
    assert_eq!(parsed.skipped_other, 6, "其他跳过项合计计数");
}

// ---------------------------------------------------------------------------
// 规模上限（2026-11-02 审计整改）：字节上限之外再加**条目数**上限——
// 一个 8 MiB 的畸形文件能产出几十万条目，解析 + 逐条落库（每条抢 vault
// 连接锁）足以把一次导入拖成分钟级。超限必须**报错**，绝不静默截断。
// ---------------------------------------------------------------------------

/// 造 N 条明文条目（每行一条端点）。
fn entries_content(n: usize) -> String {
    let mut out = String::with_capacity(n * 96);
    for i in 0..n {
        out.push_str(&format!("h{i}.example.com ssh-ed25519 {ED_A_B64}\n"));
    }
    out
}

/// 恰好等于上限 → 放行；超一条 → 报错（不是截断）。
#[test]
fn parse_known_hosts_file_limited_rejects_over_limit_and_accepts_exact_limit() {
    let content = entries_content(5);
    let ok = parse_known_hosts_file_limited(&content, 5).expect("正好等于上限必须放行");
    assert_eq!(ok.entries.len(), 5);
    let err = parse_known_hosts_file_limited(&content, 4).expect_err("超限必须报错");
    assert_eq!(err, KnownHostsParseError::TooManyEntries { limit: 4 });
    // 错误文案要说清是「条目太多」而非含糊的解析失败。
    assert!(
        err.to_string().contains("too many entries"),
        "错误文案必须点明条目超限：{err}"
    );
}

/// 超限时**不产出半截结果**（Err 而非 Ok(截断的 entries)）——截断会让用户
/// 以为「导入完成」，实际少导了一大片。
#[test]
fn parse_known_hosts_file_limited_returns_no_partial_result_on_overflow() {
    let content = entries_content(10);
    match parse_known_hosts_file_limited(&content, 3) {
        Ok(parsed) => panic!("超限必须报错，却拿到 Ok（{parsed:?}）"),
        Err(KnownHostsParseError::TooManyEntries { limit }) => assert_eq!(limit, 3),
    }
}

/// 同一份内容在上限内 → 带上限与不带上限的解析结果**逐字段相同**
/// （上限只是加了一道闸，不改任何解析语义）。
#[test]
fn parse_known_hosts_file_limited_matches_unlimited_below_limit() {
    let content = format!(
        "# comment\n\
         |1|c2FsdA==|aGFzaA==|ssh-ed25519 {ED_A_B64}\n\
         @cert-authority *.example.com ssh-ed25519 {ED_A_B64}\n\
         multi.example.com ssh-rsa {RSA_B_B64}\n\
         multi.example.com ssh-ed25519 {ED_A_B64}\n\
         a.example.com,b.example.com ssh-ed25519 {ED_A_B64}\n\
         bad.b64.example.com ssh-ed25519 !!!not-b64!!!\n"
    );
    let unlimited = parse_known_hosts_file(&content);
    let limited = parse_known_hosts_file_limited(&content, MAX_KNOWN_HOSTS_ENTRIES).unwrap();
    assert_eq!(limited, unlimited);
}

/// 生产默认上限（2 万条）真实生效：2 万条放行、2 万零一条报错。
/// （真机真实 known_hosts 37 条——上限远在真机量级之上，只拦畸形/巨型文件。）
#[test]
fn default_entry_limit_rejects_oversized_real_world_file() {
    let content = entries_content(MAX_KNOWN_HOSTS_ENTRIES + 1);
    let err = parse_known_hosts_file_limited(&content, MAX_KNOWN_HOSTS_ENTRIES)
        .expect_err("超出生产上限必须报错");
    assert_eq!(
        err,
        KnownHostsParseError::TooManyEntries {
            limit: MAX_KNOWN_HOSTS_ENTRIES
        }
    );
    // 无上限的裸解析面**不截断**（它只供测试/工具面；导入路径走带上限的）。
    assert_eq!(
        parse_known_hosts_file(&content).entries.len(),
        MAX_KNOWN_HOSTS_ENTRIES + 1
    );
}

// ---------------------------------------------------------------------------
// 择一算法改造（2026-11-02 审计整改）：旧实现 O(n²)（对每条 entry 线性扫
// grouped 与 entries），10 万条量级要按分钟计。改成 HashMap 归组后必须
// **语义逐字不变**——由下面的差分回归测试钉住。
// ---------------------------------------------------------------------------

/// 旧实现（O(n²)）的参考实现——差分基准。逐字复制审计前的算法：线性扫
/// `grouped` 归组 + `ranked_key_type` 每次重扫全表比密钥型优先级。
fn select_by_endpoint_reference(entries: &[KnownHostEntry]) -> Vec<SelectedEndpoint> {
    let mut grouped: Vec<SelectedEndpoint> = Vec::new();
    for entry in entries {
        let found = grouped
            .iter_mut()
            .find(|g| g.host == entry.host && g.port == entry.port);
        match found {
            Some(g) => {
                if !g.candidates.contains(&entry.fingerprint) {
                    g.candidates.push(entry.fingerprint.clone());
                }
                let challenger_rank = key_type_rank(&entry.key_type);
                let incumbent_rank = ranked_key_type_reference(entries, g, &g.fingerprint);
                if challenger_rank.is_some()
                    && (incumbent_rank.is_none() || challenger_rank < incumbent_rank)
                {
                    g.fingerprint = entry.fingerprint.clone();
                }
            }
            None => grouped.push(SelectedEndpoint {
                host: entry.host.clone(),
                port: entry.port,
                fingerprint: entry.fingerprint.clone(),
                candidates: vec![entry.fingerprint.clone()],
            }),
        }
    }
    grouped
}

/// 参考实现里的「当前落库指纹对应的密钥型」（取文件序第一个同指纹条目）。
fn ranked_key_type_reference(
    entries: &[KnownHostEntry],
    group: &SelectedEndpoint,
    fingerprint: &str,
) -> Option<usize> {
    entries
        .iter()
        .find(|e| e.host == group.host && e.port == group.port && e.fingerprint == fingerprint)
        .and_then(|e| key_type_rank(&e.key_type))
}

/// 确定性伪随机（不引 rand 依赖；固定种子 → 用例可复现）。
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next() as usize) % items.len()]
    }
}

/// 差分回归：HashMap 归组的新实现与旧 O(n²) 参考实现在随机样本上
/// **逐字段相同**（落库指纹、候选集内容与顺序、输出顺序）。
#[test]
fn select_by_endpoint_matches_reference_implementation() {
    let key_types = [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ssh-rsa",
        "sk-ssh-ed25519@openssh.com", // 未知型（无排名）
    ];
    let fingerprints = [ED_A_FP, ED_C_FP, RSA_B_FP, "SHA256:unknownfp"];
    let mut rng = Lcg(0x5eed_1234);
    for case in 0..64 {
        let n = 1 + (rng.next() % 40) as usize;
        let mut entries: Vec<KnownHostEntry> = Vec::with_capacity(n);
        for _ in 0..n {
            let host_idx = (rng.next() % 5) as usize;
            let port = [22u16, 2222, 2200][(rng.next() % 3) as usize];
            entries.push(KnownHostEntry {
                host: format!("h{host_idx}.example.com"),
                port,
                key_type: (*rng.pick(&key_types)).to_string(),
                fingerprint: (*rng.pick(&fingerprints)).to_string(),
            });
        }
        let got = select_by_endpoint(&entries);
        let want = select_by_endpoint_reference(&entries);
        assert_eq!(got, want, "用例 #{case} 的择一结果与旧实现不一致");
    }
}

/// 差分回归的病态样本：**同一枚指纹配不同密钥型**（真实文件不会出现——b64
/// 段自带密钥型——但它正是旧实现「取文件序第一个同指纹条目」口径的分水岭：
/// 新实现若按「当前这条的密钥型」比较，会选错落库指纹）。
#[test]
fn select_by_endpoint_same_fingerprint_with_different_key_types() {
    let entries = vec![
        KnownHostEntry {
            host: "multi.example.com".to_string(),
            port: 22,
            key_type: "ssh-rsa".to_string(),
            fingerprint: ED_A_FP.to_string(),
        },
        KnownHostEntry {
            host: "multi.example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: ED_A_FP.to_string(),
        },
        KnownHostEntry {
            host: "multi.example.com".to_string(),
            port: 22,
            key_type: "ecdsa-sha2-nistp256".to_string(),
            fingerprint: RSA_B_FP.to_string(),
        },
    ];
    let got = select_by_endpoint(&entries);
    let want = select_by_endpoint_reference(&entries);
    assert_eq!(got, want, "同指纹异密钥型的择一必须与旧实现一致");
    // 固定期望值（旧实现口径：夺魁者的排名取「文件序第一个同指纹条目」的
    // 密钥型 = rsa 的第 4 位 → ecdsa(1) < rsa(4) → ecdsa 那一枚夺魁）。
    assert_eq!(got[0].fingerprint, RSA_B_FP);
}

/// 候选集按**文件序**去重保序（落库层只判「∈ 候选集」，但顺序是语义的一部分：
/// 报告与调试都要能复现同一条目的来源次序）。
#[test]
fn select_by_endpoint_candidates_keep_file_order_without_duplicates() {
    let entries = vec![
        KnownHostEntry {
            host: "h.example.com".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: "SHA256:aaa".to_string(),
        },
        KnownHostEntry {
            host: "h.example.com".to_string(),
            port: 22,
            key_type: "ssh-rsa".to_string(),
            fingerprint: "SHA256:bbb".to_string(),
        },
        KnownHostEntry {
            host: "h.example.com".to_string(),
            port: 22,
            key_type: "ecdsa-sha2-nistp256".to_string(),
            fingerprint: "SHA256:aaa".to_string(),
        },
    ];
    let selected = select_by_endpoint(&entries);
    assert_eq!(
        selected[0].candidates,
        vec!["SHA256:aaa".to_string(), "SHA256:bbb".to_string()],
        "候选集 = 文件序去重"
    );
    // 落库的是 ecdsa（优先级高于 rsa）。
    assert_eq!(selected[0].fingerprint, "SHA256:aaa");
}

/// 规模回归（审计整改的性能面）：10 万条目（旧实现 O(n²) 在这个量级要按
/// 分钟计）必须在**亚秒级**完成，且结果正确。
///
/// 时间上限给得宽（5s）——新实现的真实耗时是毫秒级，宽限只为躲开 CI 抖动；
/// 旧 O(n²) 实现在同量级要跑几分钟，5s 的闸足以把「又退回 O(n²)」钉死。
#[test]
fn select_by_endpoint_scales_to_100k_entries() {
    let n = 100_000usize;
    let mut entries: Vec<KnownHostEntry> = Vec::with_capacity(n);
    for i in 0..n {
        entries.push(KnownHostEntry {
            host: format!("h{i}.example.com"),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: format!("SHA256:fp{i}"),
        });
    }
    let started = std::time::Instant::now();
    let selected = select_by_endpoint(&entries);
    let elapsed = started.elapsed();
    assert_eq!(selected.len(), n, "10 万条 → 10 万个端点");
    assert_eq!(selected[0].host, "h0.example.com");
    assert_eq!(selected[n - 1].host, format!("h{}.example.com", n - 1));
    assert!(
        elapsed.as_secs() < 5,
        "10 万条择一耗时 {}ms（上限 5s）——O(n²) 回退了？",
        elapsed.as_millis()
    );
}

/// 规模回归（同端点多密钥型）：10 万条目压在 1000 个端点上（每端点 100 枚
/// 密钥）——旧实现每条都要重扫全表比优先级，这一档最能暴露 O(n²)。
#[test]
fn select_by_endpoint_scales_with_many_keys_per_endpoint() {
    let endpoints = 1_000usize;
    let per_endpoint = 100usize;
    let mut entries: Vec<KnownHostEntry> = Vec::with_capacity(endpoints * per_endpoint);
    for e in 0..endpoints {
        for k in 0..per_endpoint {
            entries.push(KnownHostEntry {
                host: format!("h{e}.example.com"),
                port: 22,
                // 轮转密钥型：ed25519 与 rsa 交替 → 夺魁者恒为 ed25519。
                key_type: if k % 2 == 0 {
                    "ssh-ed25519".to_string()
                } else {
                    "ssh-rsa".to_string()
                },
                fingerprint: format!("SHA256:fp{e}-{k}"),
            });
        }
    }
    let started = std::time::Instant::now();
    let selected = select_by_endpoint(&entries);
    let elapsed = started.elapsed();
    assert_eq!(selected.len(), endpoints);
    assert_eq!(selected[0].candidates.len(), per_endpoint);
    assert_eq!(selected[0].fingerprint, "SHA256:fp0-0", "ed25519 夺魁");
    assert!(
        elapsed.as_secs() < 5,
        "10 万条 / 1000 端点择一耗时 {}ms（上限 5s）——O(n²) 回退了？",
        elapsed.as_millis()
    );
}
