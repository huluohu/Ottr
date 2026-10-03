//! 缺陷 35（审计截图「known_hosts verified 仍弹首连确认」）复现测试：
//! 走查库播种的「已 verify」known_hosts 记录，必须落在**连接期 TOFU 策略
//! 同构的端点键**上（`host_endpoint_key("127.0.0.1", 2222)` =
//! `"127.0.0.1:2222"`；仅 IPv6 才加方括号）。旧 seed 硬编码
//! `"[127.0.0.1]:2222"`（把 IPv4 当 IPv6 加括号）——连接期查找键不同构，
//! `KnownHosts::get` 查不到这条 verified 记录 → `host_key_ask_kind` 判
//! "first" → 首连弹确认框。真机复现：/tmp/ui2-t2/red-08（2026-10-04，
//! seed 后首连弹「首次连接确认」+ vault.db 双行取证）。

use std::path::PathBuf;

use ottr_vault::entities::{KnownHostState, KnownHosts};
use ottr_vault::{host_endpoint_key, seed, Vault};

fn open_seeded(dir: &std::path::Path) -> Vault {
    let vault = Vault::open_password_only(dir).expect("open seeded vault");
    vault.unlock_with_password("ottr-t7").expect("unlock");
    vault
}

#[test]
fn seeded_verified_known_hosts_is_visible_to_connect_time_lookup() {
    let dir = PathBuf::from(std::env::temp_dir().join(format!(
        "ottr-seed-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    )));
    std::fs::create_dir_all(&dir).unwrap();

    seed::seed_walkthrough_vault(&dir, "ottr-t7").expect("seed walkthrough vault");

    let vault = open_seeded(&dir);
    // 连接期 TOFU 策略的查找键（commands/session.rs tofu_host_key_policy 同构）。
    let lookup_key = host_endpoint_key("127.0.0.1", 2222);
    let row = KnownHosts::get(&vault, &lookup_key)
        .expect("read known_hosts")
        .expect("seeded verified record must be found under the connect-time endpoint key");
    assert_eq!(row.fingerprint, seed::FIXTURE_FINGERPRINT);
    assert_eq!(row.state, KnownHostState::Ok);
    assert!(row.verified, "seeded record must be verified");

    // 播种后 known_hosts 恰好一行（键式漂移会留下查不到的死行）。
    let all = KnownHosts::list(&vault).expect("list known_hosts");
    assert_eq!(all.len(), 1, "exactly one known_hosts row, no dead alias rows");

    std::fs::remove_dir_all(&dir).ok();
}
