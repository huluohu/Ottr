//! known_hosts 批量导入语义（2026-11-02）：从本地 known_hosts 文件批量落地
//! 信任锚。
//!
//! 三条硬语义（本文件钉死）：
//! 1. **verify 语义**：新端点导入后 state=ok / verified=1——走 upsert（pending）
//!    则首次连接照样弹 TOFU 确认框，导入等于白做；
//! 2. **重复**：同端点已存在且指纹相同 → skipped_duplicate，**不覆盖**既有锚；
//! 3. **冲突**：同端点已存在但指纹不同 → skipped_conflict，**不覆盖**既有锚
//!    （既有 changed 状态由用户显式裁定，导入不得擅自改锚）。
//!
//! 纪律：tempfile 临时目录 + InMemoryStorage（见 common 模块）。

mod common;
use ottr_vault::entities::KnownHostState;
use ottr_vault::{KnownHosts, Vault, host_endpoint_key};

fn open_vault(dir: &std::path::Path) -> Vault {
    common::open_vault(dir)
}

const FP_A: &str = "SHA256:pa73sHYbI8OWfh46t85LS1g0pTlqeryQLEvZ6rSlJYI";
const FP_B: &str = "SHA256:m6ASW1c91g6d2RVPQBvGpXHKQHQNKuAL43L772eAgc4";
const FP_OTHER: &str = "SHA256:ovJfhD+XEYlrF+6vhXXCG2f+7ks1NfxeCvaF1HDSpis";

#[test]
fn import_lands_verified_trust_anchors() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    let report = KnownHosts::import(
        &vault,
        &[
            ("10.0.0.1".to_string(), 22, FP_A.to_string()),
            ("10.0.0.2".to_string(), 2222, FP_B.to_string()),
        ],
    );
    assert_eq!(report.added, 2);
    assert_eq!(report.skipped_duplicate, 0);
    assert_eq!(report.skipped_conflict, 0);
    assert!(report.errors.is_empty(), "errors: {:?}", report.errors);

    // 端点键口径与 host_endpoint_key 一致（IPv6 补方括号）。
    let key = host_endpoint_key("10.0.0.1", 22);
    let row = KnownHosts::get(&vault, &key).unwrap().expect("锚应落库");
    assert_eq!(row.fingerprint, FP_A);
    assert_eq!(
        row.state,
        KnownHostState::Ok,
        "导入走 verify 语义——pending 会让首次连接照样弹 TOFU 确认框"
    );
    assert!(row.verified, "导入的锚必须是 verified");
    assert!(row.first_seen > 0);

    // 非 22 端口同样落库（端点键带端口）。
    let key2 = host_endpoint_key("10.0.0.2", 2222);
    assert!(KnownHosts::get(&vault, &key2).unwrap().is_some());
}

#[test]
fn repeated_import_counts_duplicate_and_keeps_anchor() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let entries = vec![("10.0.0.1".to_string(), 22, FP_A.to_string())];

    let first = KnownHosts::import(&vault, &entries);
    assert_eq!(first.added, 1);

    let second = KnownHosts::import(&vault, &entries);
    assert_eq!(second.added, 0);
    assert_eq!(second.skipped_duplicate, 1);
    assert_eq!(second.skipped_conflict, 0);

    let row = KnownHosts::get(&vault, &host_endpoint_key("10.0.0.1", 22))
        .unwrap()
        .unwrap();
    assert_eq!(row.fingerprint, FP_A, "重复导入不得改动锚");
    assert_eq!(row.state, KnownHostState::Ok);
}

#[test]
fn conflicting_fingerprint_is_skipped_and_never_overwrites_the_anchor() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let key = host_endpoint_key("10.0.0.1", 22);

    // 既有锚 = FP_A（ok 态）。
    KnownHosts::import(&vault, &[("10.0.0.1".to_string(), 22, FP_A.to_string())]);
    let before = KnownHosts::get(&vault, &key).unwrap().unwrap();

    // 文件里同一端点是另一枚指纹 → 冲突：计入冲突、**不覆盖**。
    let report = KnownHosts::import(
        &vault,
        &[("10.0.0.1".to_string(), 22, FP_OTHER.to_string())],
    );
    assert_eq!(report.added, 0);
    assert_eq!(report.skipped_conflict, 1);
    assert_eq!(report.skipped_duplicate, 0);

    let after = KnownHosts::get(&vault, &key).unwrap().unwrap();
    assert_eq!(
        after.fingerprint, FP_A,
        "冲突导入不得擅自改锚（既有状态由用户显式裁定）"
    );
    assert_eq!(after.state, KnownHostState::Ok);
    assert_eq!(after.first_seen, before.first_seen);
}

#[test]
fn import_does_not_clear_a_changed_state() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let key = host_endpoint_key("10.0.0.1", 22);

    // 服务器换钥 → changed（锚保留旧指纹）。
    KnownHosts::import(&vault, &[("10.0.0.1".to_string(), 22, FP_A.to_string())]);
    let changed = KnownHosts::mark_changed(&vault, &key, FP_OTHER).unwrap();
    assert_eq!(changed.state, KnownHostState::Changed);

    // 导入旧锚（文件里还是旧钥）——不得把 changed 洗回 ok（安全信号不许被
    // 导入顺手抹掉），也不得改锚。
    let report = KnownHosts::import(&vault, &[("10.0.0.1".to_string(), 22, FP_A.to_string())]);
    assert_eq!(report.added, 0);
    assert_eq!(report.skipped_duplicate, 1);
    let after = KnownHosts::get(&vault, &key).unwrap().unwrap();
    assert_eq!(
        after.state,
        KnownHostState::Changed,
        "changed 状态不得被导入洗掉"
    );
    assert_eq!(after.fingerprint, FP_A);
}

/// 一个端点多枚密钥（rsa/ed25519 并存）是常态——**择一**落地：只算一条新增，
/// 其余同端点候选不算冲突（否则每次导入都满屏「冲突」噪声）。
#[test]
fn multi_key_endpoint_is_collapsed_to_one_anchor() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    let report = KnownHosts::import(
        &vault,
        &[
            ("multi.example.com".to_string(), 22, FP_A.to_string()),
            ("multi.example.com".to_string(), 22, FP_B.to_string()),
        ],
    );
    assert_eq!(report.added, 1, "同端点多枚密钥只落一条锚");
    assert_eq!(report.skipped_conflict, 0, "同端点候选之间不算冲突");
    assert_eq!(report.skipped_duplicate, 0);

    // 再导一次：既有锚就是文件里的候选之一 → 重复（非冲突）。
    let again = KnownHosts::import(
        &vault,
        &[
            ("multi.example.com".to_string(), 22, FP_A.to_string()),
            ("multi.example.com".to_string(), 22, FP_B.to_string()),
        ],
    );
    assert_eq!(again.added, 0);
    assert_eq!(again.skipped_duplicate, 1);
    assert_eq!(again.skipped_conflict, 0);
}

/// 既有锚虽不是文件里的首选候选、但仍在文件候选集内（服务器多型密钥，用户
/// 之前锚的是另一型）→ 仍是「重复」而非「冲突」（锚没变，运行时换钥判定靠
/// 「锚消失」，见 hostkey_audit::classify_probe）。
#[test]
fn existing_anchor_within_candidates_is_duplicate_not_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let key = host_endpoint_key("multi.example.com", 22);

    // 既有锚 = FP_B（用户先前锚的另一型密钥）。
    KnownHosts::import(
        &vault,
        &[("multi.example.com".to_string(), 22, FP_B.to_string())],
    );

    let report = KnownHosts::import(
        &vault,
        &[
            ("multi.example.com".to_string(), 22, FP_A.to_string()),
            ("multi.example.com".to_string(), 22, FP_B.to_string()),
        ],
    );
    assert_eq!(report.added, 0);
    assert_eq!(report.skipped_duplicate, 1);
    assert_eq!(report.skipped_conflict, 0);
    let after = KnownHosts::get(&vault, &key).unwrap().unwrap();
    assert_eq!(after.fingerprint, FP_B, "锚不被改写");
}

/// 空输入 = 空报告（不报错、不写库）。
#[test]
fn import_of_empty_input_is_a_noop() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    let report = KnownHosts::import(&vault, &[]);
    assert_eq!(report.added, 0);
    assert_eq!(report.skipped_duplicate, 0);
    assert_eq!(report.skipped_conflict, 0);
    assert!(report.errors.is_empty());
    assert!(KnownHosts::list(&vault).unwrap().is_empty());
}
