//! 主机指纹巡检真夹具集成（Phase 3 Task 6，B9 收口）：真 ottr-sshd 容器
//! （127.0.0.1:2222）+ 真 ssh-keyscan 外部进程 + 临时内存库走 [`audit_once`]：
//! * 端点正常（锚 = fixtures/known_hosts pin）→ 探测命中锚 → 无告警；
//! * 故意改库内信任锚（模拟「记录与实际漂移」）→ 巡检判 changed →
//!   mark_changed 落账（锚保留、changed_at 落值）——裁定 #2 的真夹具一轮。
//!
//! 夹具不可达 / 本机无 ssh-keyscan → SKIP（batch_fixture 同纪律）。
//!
//! Run: `cargo test -p ottr --test hostkey_fixture`
use std::time::Duration;

use ottr_vault::KnownHostState;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const ENDPOINT_KEY: &str = "[127.0.0.1]:2222";

async fn fixture_up() -> bool {
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect((HOST, PORT)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

/// fixtures/known_hosts 首条（端点行）→ SHA256 指纹（与 session.rs 同口径）。
fn pinned_fingerprint() -> String {
    let content = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/known_hosts"
    ))
    .expect("read fixtures/known_hosts —— 先跑 scripts/spike-sshd.sh");
    let line = content
        .lines()
        .map(str::trim)
        .find(|l| {
            !l.is_empty()
                && !l.starts_with('#')
                && l.split_whitespace().next() == Some(ENDPOINT_KEY)
        })
        .unwrap_or_else(|| panic!("known_hosts has no entry for {ENDPOINT_KEY}"));
    ottr_lib::keyscan_line_fingerprint(line).expect("fixture line yields fingerprint")
}

fn open_vault(dir: &std::path::Path) -> ottr_vault::Vault {
    ottr_vault::Vault::open_with(dir, &ottr_vault::master_key::InMemoryStorage::new())
        .expect("open in-memory vault")
}

/// 真探测器（生产同款：parse 端点键 → probe_endpoint）。
fn real_prober() -> impl FnMut(&str) -> Result<Vec<String>, String> {
    |host_key: &str| {
        let (address, port) = ottr_vault::parse_endpoint_key(host_key)
            .ok_or_else(|| format!("bad key {host_key}"))?;
        let port = u16::try_from(port).map_err(|_| format!("port {port} oor"))?;
        ottr_lib::probe_endpoint(&address, port)
    }
}

#[tokio::test]
async fn audit_round_on_real_fixture() {
    if !fixture_up().await {
        eprintln!("SKIP: fixture 127.0.0.1:2222 unreachable —— scripts/spike-sshd.sh");
        return;
    }
    let pin = pinned_fingerprint();

    // ① 真 ssh-keyscan 探测：观测集非空、且**恰好含**夹具 pin（跨实现对齐：
    // 本测试的 keyscan 采集面 == fixtures/known_hosts 的记账面）。
    let seen = ottr_lib::probe_endpoint(HOST, PORT).expect("probe real fixture");
    assert!(!seen.is_empty(), "真夹具可探测");
    assert!(seen.contains(&pin), "观测集 {seen:?} 必含夹具锚 {pin}");

    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());

    // ② 端点正常（锚 = pin，state=ok）→ 巡检无告警。
    ottr_vault::KnownHosts::upsert(&vault, ENDPOINT_KEY, &pin).unwrap();
    ottr_vault::KnownHosts::verify(&vault, ENDPOINT_KEY, &pin).unwrap();
    let outcome = ottr_lib::audit_once(&vault, real_prober()).unwrap();
    assert_eq!(outcome.checked, 1);
    assert!(outcome.changed.is_empty(), "锚仍在：无 changed 告警");
    assert_eq!(
        ottr_vault::KnownHosts::get(&vault, ENDPOINT_KEY)
            .unwrap()
            .unwrap()
            .state,
        KnownHostState::Ok
    );

    // ③ 故意改库内记录（信任锚换成不存在的新钥）→ 巡检判 changed：
    //    mark_changed 落账、锚保留（旧值）、changed_at 落值。
    ottr_vault::KnownHosts::verify(&vault, ENDPOINT_KEY, "SHA256:DRIFTED-ANCHOR").unwrap();
    let outcome = ottr_lib::audit_once(&vault, real_prober()).unwrap();
    assert_eq!(outcome.changed.len(), 1, "锚漂移必须告警");
    let entry = &outcome.changed[0];
    assert_eq!(entry.row.host_key, ENDPOINT_KEY);
    assert_eq!(entry.row.state, KnownHostState::Changed);
    assert_eq!(
        entry.row.fingerprint, "SHA256:DRIFTED-ANCHOR",
        "mark_changed 保留（漂移的）锚不覆盖"
    );
    assert!(entry.row.changed_at.is_some());
    assert!(entry.seen.contains(&pin), "观测集随行下发（新锚候选面）");
}
