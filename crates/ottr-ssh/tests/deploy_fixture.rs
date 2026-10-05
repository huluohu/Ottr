//! Task 6（A4）：公钥部署夹具集成测试（裁定 #3/#7——夹具真机验证一轮）。
//!
//! 目标：`deploy_public_key` 打真实容器化 sshd（127.0.0.1:2222，spike/spike-pass，
//! scripts/spike-sshd.sh 起停）——部署新生成的 ed25519 公钥 → 幂等复跑 →
//! 用部署出的密钥完成公钥认证登录并远端 `whoami`。
//!
//! 夹具未启动时**跳过**（回打印 SKIP 提示）；CI/本地先 `scripts/spike-sshd.sh`。
//! Run: `cargo test -p ottr-ssh --test deploy_fixture`

use std::path::PathBuf;
use std::time::Duration;

use ottr_ssh::deploy::DeployStatus;
use ottr_ssh::keygen::{KeyAlgorithm, generate};
use ottr_ssh::{AuthMethod, deploy_public_key};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const TEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 夹具指纹 pin（fixtures/known_hosts，与 examples/real_fixture.rs 同源）。
fn pinned_host_key_policy() -> ottr_ssh::HostKeyPolicy {
    let content = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/known_hosts"
    ))
    .expect("read fixtures/known_hosts（先跑 scripts/spike-sshd.sh）");
    let pinned_fp = ottr_ssh::known_hosts::fingerprint_for_host(&content, HOST, PORT)
        .unwrap_or_else(|| panic!("known_hosts has no entry for [{HOST}]:{PORT}"));
    let pinned_for_cb = pinned_fp;
    std::sync::Arc::new(move |fingerprint: &str| fingerprint == pinned_for_cb)
}

async fn fixture_up() -> bool {
    tokio::net::TcpStream::connect((HOST, PORT)).await.is_ok()
}

/// 部署用一次性密钥文件名按进程+测试隔离，避免与 spike 主体夹具互踩。
fn workdir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "ottr-deploy-test-{}-{}",
        std::process::id(),
        chronoless_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn chronoless_nanos() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[tokio::test]
async fn deploy_is_idempotent_and_deployed_key_authenticates() {
    if !fixture_up().await {
        eprintln!("SKIP: sshd fixture 127.0.0.1:2222 not running（scripts/spike-sshd.sh）");
        return;
    }
    let dir = workdir();
    let key_path = dir.join("deployed_ed25519");

    // 1. 生成一次性登录密钥（edge case：每次测试全新密钥，authorized_keys 只增不减）
    let key = generate(KeyAlgorithm::Ed25519, None, "ottr-deploy-fixture-test").unwrap();
    std::fs::write(&key_path, &key.private_openssh).unwrap();

    // 2. 密码认证部署 → Added
    let out = tokio::time::timeout(
        TEST_TIMEOUT,
        deploy_public_key(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
            &key.public_openssh,
        ),
    )
    .await
    .expect("deploy timed out")
    .expect("deploy failed");
    assert_eq!(out.status, DeployStatus::Added);
    assert_eq!(out.public_key_fingerprint, key.fingerprint);

    // 3. 幂等：原样复跑 → AlreadyPresent（authorized_keys 不重复追加）
    let out2 = tokio::time::timeout(
        TEST_TIMEOUT,
        deploy_public_key(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
            &key.public_openssh,
        ),
    )
    .await
    .expect("re-deploy timed out")
    .expect("re-deploy failed");
    assert_eq!(out2.status, DeployStatus::AlreadyPresent);

    // 4. 闭环：部署出的密钥能通过公钥认证登录，远端 whoami == spike
    let session = tokio::time::timeout(
        TEST_TIMEOUT,
        ottr_ssh::connect(
            HOST,
            PORT,
            USER,
            AuthMethod::Key {
                path: key_path.clone(),
                passphrase: None,
            },
            pinned_host_key_policy(),
        ),
    )
    .await
    .expect("key auth connect timed out")
    .expect("key auth rejected — deploy did not take effect");
    let out = session.exec("whoami").await.expect("exec whoami");
    assert_eq!(out.exit_status, Some(0));
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), USER);

    let _ = session.disconnect().await;
    let _ = std::fs::remove_dir_all(&dir);
}

/// 远端 grep 匹配是整行精确（-qxF）：公钥行尾带不同 comment 的另一把公钥
/// 不应被误判为已存在。用一把固定 comment 区分的密钥验证 Added。
#[tokio::test]
async fn distinct_key_is_not_swallowed_by_idempotency_check() {
    if !fixture_up().await {
        eprintln!("SKIP: sshd fixture 127.0.0.1:2222 not running（scripts/spike-sshd.sh）");
        return;
    }
    let key = generate(KeyAlgorithm::Ed25519, None, "ottr-deploy-distinct-key").unwrap();
    let out = tokio::time::timeout(
        TEST_TIMEOUT,
        deploy_public_key(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
            &key.public_openssh,
        ),
    )
    .await
    .expect("deploy timed out")
    .expect("deploy failed");
    assert_eq!(out.status, DeployStatus::Added);
}
