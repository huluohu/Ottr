//! JumpSession 真夹具端到端（Phase 2 Task 2 Step 4）：打容器化 sshd
//! （127.0.0.1:2222，spike/spike-pass，scripts/spike-sshd.sh）验证三件事：
//!
//! 1. **自跳两级链**（Phase 0 jump_spike 同拓扑：容器 sshd 监听 0.0.0.0，
//!    127.0.0.1:2222 容器内自可达）：chain=[夹具, 夹具] → target=夹具，
//!    target 上 exec whoami → spike（协议字节穿过两级隧道往返）；
//! 2. **断点定位**：链 = [夹具, 127.0.0.1:2299（容器内无服务）] →
//!    `HopFailed { index: 1 }`，红线 **3s 内**（显式 CHANNEL_OPEN_FAILURE，
//!    不是笼统超时）；
//! 3. **teardown**（服务端视角，Phase 0 挂账清偿的最终证据）：链建立后容器内
//!    `/proc/net/tcp` 出现 3 条 local-port=2222 的 ESTABLISHED **新键**（链上
//!    3 个连接的服务端侧，按连接四元组集合差分计量）；显式 disconnect 后
//!    这 3 条键轮询消失——「中间跳 Handle drop 不关连接」的旧泄漏在容器
//!    sshd 侧可观测地消失。集合差分而非绝对计数：全量回归时其他夹具测试
//!    的并行连接会建立/拆除，绝对基线会被并行干扰污染（原实现因此在
//!    `cargo test -p ottr-ssh` 全目标并行跑下偶发翻红）。
//!
//! 夹具未启动时跳过（同 deploy_fixture/forward_fixture 纪律）。
//! Run: `cargo test -p ottr-ssh --test jump_session_fixture`

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ottr_ssh::jump_session::JumpSession;
use ottr_ssh::{AuthMethod, HopSpec, HostKeyPolicy, JumpError};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
/// 容器内无服务的端口（断点定位靶子；jump_spike 同款）。
const DEAD_PORT: u16 = 2299;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const TEST_TIMEOUT: Duration = Duration::from_secs(30);
/// 断点定位红线（B7 产品承诺）。
const BREAKPOINT_BUDGET: Duration = Duration::from_secs(3);
/// teardown 收敛预算：容器内 sshd 处理 DISCONNECT 毫秒级；10s 已是宽限。
const TEARDOWN_BUDGET: Duration = Duration::from_secs(10);

/// 夹具指纹 pin（fixtures/known_hosts，与 deploy_fixture/forward_fixture 同源）。
fn pinned_host_key_policy() -> HostKeyPolicy {
    let content = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../fixtures/known_hosts"
    ))
    .expect("read fixtures/known_hosts（先跑 scripts/spike-sshd.sh）");
    let pinned_fp = ottr_ssh::known_hosts::fingerprint_for_host(&content, HOST, PORT)
        .unwrap_or_else(|| panic!("known_hosts has no entry for [{HOST}]:{PORT}"));
    let pinned_for_cb = pinned_fp;
    Arc::new(move |fingerprint: &str| fingerprint == pinned_for_cb)
}

fn fixture_hop(port: u16) -> HopSpec {
    HopSpec {
        host: HOST.into(),
        port,
        username: USER.into(),
        auth: AuthMethod::Password(PASSWORD.into()),
        host_key: pinned_host_key_policy(),
    }
}

async fn fixture_up() -> bool {
    tokio::net::TcpStream::connect((HOST, PORT)).await.is_ok()
}

fn skip(name: &str) {
    println!("SKIP {name}: fixture down（先跑 scripts/spike-sshd.sh）");
}

/// 在夹具上 exec `cat /proc/net/tcp`，取 local-port=2222（hex 08AE）且
/// state=01（ESTABLISHED）行的**连接键集合**（键 = `local-rem` 四元组原文）
/// ——容器 sshd 侧每条活连接恰好贡献一行（客户端侧套接字的 local port 是
/// 临时端口，不计数）。集合形态供差分计量（见模块文档第 3 点）。
async fn established_keys_on_fixture(poller: &ottr_ssh::SshSession) -> HashSet<String> {
    let out = poller
        .exec("cat /proc/net/tcp")
        .await
        .expect("exec /proc/net/tcp");
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .filter_map(|line| line.split_whitespace().collect::<Vec<_>>().get(1..4).map(|f| f.to_vec()))
        .filter(|f| f.len() == 3)
        .filter(|f| f[0].ends_with(":08AE")) // local port 2222
        .filter(|f| f[2] == "01") // ESTABLISHED
        .map(|f| format!("{}-{}", f[0], f[1]))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn two_hop_self_jump_chain_exec_teardown_on_real_fixture() {
    if !fixture_up().await {
        return skip("two-hop");
    }
    // 独立探测连接（轮询账本用；与链路无关，全程存活）。
    let poller = Arc::new(
        ottr_ssh::connect(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
        )
        .await
        .expect("poller connect"),
    );
    let baseline = established_keys_on_fixture(&poller).await;

    // ---- 自跳两级链：链路通 + target exec + 容器侧连接账本 +3 --------------
    let js = tokio::time::timeout(
        TEST_TIMEOUT,
        JumpSession::connect(
            vec![fixture_hop(PORT), fixture_hop(PORT)],
            fixture_hop(PORT),
        ),
    )
    .await
    .expect("chain connect timeout")
    .expect("two-hop self-jump chain must connect");
    assert_eq!(js.hop_count(), 2);
    let who = js.target().exec("whoami").await.expect("exec over chain");
    assert_eq!(String::from_utf8_lossy(&who.stdout).trim(), USER);

    // 链上 3 个连接（conn1 直连 + conn2/conn3 容器内自跳）在服务端可见：
    // 轮询直到出现 ≥3 条「基线集合之外的新键」（并行测试的连接建立/拆除
    // 不影响差分结果——只数本链自己的键）。
    let deadline = Instant::now() + TEARDOWN_BUDGET;
    let chain_keys = loop {
        let current = established_keys_on_fixture(&poller).await;
        let fresh: HashSet<String> = current.difference(&baseline).cloned().collect();
        if fresh.len() >= 3 {
            break fresh;
        }
        assert!(
            Instant::now() < deadline,
            "链建立后容器侧应出现 ≥3 条新 ESTABLISHED：baseline={baseline:?} fresh={fresh:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    };

    // ---- 显式 teardown：本链 3 条新键全部消失（旧泄漏在服务端可观测地消失；
    // 并行测试的连接无关——只盯自己的键）------------------------------------
    js.disconnect().await.expect("disconnect");
    let deadline = Instant::now() + TEARDOWN_BUDGET;
    loop {
        let current = established_keys_on_fixture(&poller).await;
        let residue: HashSet<String> = chain_keys.intersection(&current).cloned().collect();
        if residue.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "显式 disconnect 后链上 3 条连接必须全部从容器侧消失：residue={residue:?}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    poller.disconnect().await.ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn breakpoint_located_within_3s_on_real_fixture() {
    if !fixture_up().await {
        return skip("breakpoint");
    }
    // 链 = [夹具, 容器内无服务的 2299]：第一跳可达，direct-tcpip 在容器内连
    // 2299 被拒 → CHANNEL_OPEN_FAILURE → HopFailed index=1，3s 内返回。
    let started = Instant::now();
    let result = tokio::time::timeout(
        TEST_TIMEOUT,
        JumpSession::connect(
            vec![fixture_hop(PORT), fixture_hop(DEAD_PORT)],
            fixture_hop(PORT),
        ),
    )
    .await
    .expect("connect must return within TEST_TIMEOUT");
    let elapsed = started.elapsed();

    match result {
        Ok(_) => panic!("chain through dead port {DEAD_PORT} must not succeed"),
        Err(JumpError::HopFailed { index, source }) => {
            assert_eq!(index, 1, "断点必须定位在第 2 跳（index=1）: {source}");
            assert!(
                elapsed < BREAKPOINT_BUDGET,
                "断点定位耗时 {elapsed:?}，超出 3s 红线"
            );
        }
    }
}
