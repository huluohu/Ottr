//! 远端文件本地编辑的读写原语**集成测试**（Phase 2 Task 3，B10 上半 Step 1）。
//!
//! 如实命名：真夹具集成测试（127.0.0.1:2222，`scripts/spike-sshd.sh` 启动；
//! 用户 spike / 密码 spike-pass）。夹具不可达时立即 fail 并提示启动命令
//! （与 sftp_test.rs 同纪律，不引入 testcontainers）。
//!
//! 编辑场景是小文件单通道读写（不启用并行分块 + journal，裁定见
//! task-3-report §选型），因此用例围绕：
//! 1. 写回 → 读回 roundtrip（跨 256KiB 报文上限的多请求写路径）；
//! 2. 独立取证通道（远端 exec sha256sum / 本地 shasum）内容比对；
//! 3. RemoteSnapshot 冲突判定：第三方改写 → 快照判定冲突；自己写回后的
//!    新 stat 与更新后快照**不得**自冲突。

use std::process::Command;
use std::sync::Arc;

use ottr_ssh::{AuthMethod, SshSession, connect};
use ottr_transfer::SftpClient;
use ottr_transfer::ops::RemoteSnapshot;
use russh::ChannelMsg;
use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");

/// 夹具可达性探测：不可达即 fail 并提示（裁定：不引入 testcontainers）。
async fn fixture_or_panic() {
    match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect((HOST, PORT)),
    )
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            panic!("sshd fixture unreachable at {HOST}:{PORT} ({e}) —— 先跑 scripts/spike-sshd.sh")
        }
        Err(_) => panic!(
            "sshd fixture unreachable at {HOST}:{PORT} (timeout) —— 先跑 scripts/spike-sshd.sh"
        ),
    }
}

fn pinned_host_key_policy() -> ottr_ssh::HostKeyPolicy {
    let content = std::fs::read_to_string(KNOWN_HOSTS)
        .unwrap_or_else(|e| panic!("read {KNOWN_HOSTS}: {e} —— 先跑 scripts/spike-sshd.sh"));
    let marker = format!("[{HOST}]:{PORT}");
    let line = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .unwrap_or_else(|| panic!("known_hosts has no entry for {marker}"));
    let base64 = line
        .split_whitespace()
        .nth(2)
        .unwrap_or_else(|| panic!("malformed known_hosts line: {line}"));
    let pinned: PublicKey = parse_public_key_base64(base64).expect("parse pinned host key");
    let pinned_fp = pinned.fingerprint(HashAlg::Sha256).to_string();
    Arc::new(move |fingerprint: &str| fingerprint == pinned_fp)
}

async fn connect_fixture() -> SshSession {
    let mut last = None;
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        match connect(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.to_string()),
            pinned_host_key_policy(),
        )
        .await
        {
            Ok(s) => return s,
            Err(e) => last = Some(e),
        }
    }
    panic!(
        "connect fixture (3 attempts): {}",
        last.expect("at least one attempt")
    );
}

/// 远程执行（PTY + exec，sftp_test 同款），断言退出码 0，返回输出。
async fn exec(session: &SshSession, cmd: &str) -> String {
    let mut channel = session.open_pty(120, 40).await.expect("open pty");
    channel.exec(false, cmd).await.expect("exec");
    let mut out = Vec::new();
    let mut exit_code = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { data } => out.extend_from_slice(&data),
            ChannelMsg::ExtendedData { data, .. } => out.extend_from_slice(&data),
            ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    assert_eq!(exit_code, Some(0), "remote command failed: {cmd}");
    String::from_utf8_lossy(&out).trim().to_string()
}

/// 本地 sha256（shasum -a 256，macOS 夹具环境；失败回退 sha256sum）。
fn sha256_local(path: &str) -> String {
    let candidates: [Vec<&str>; 2] = [vec!["shasum", "-a", "256", path], vec!["sha256sum", path]];
    for cmd in candidates {
        if let Ok(out) = Command::new(cmd[0]).args(&cmd[1..]).output() {
            if out.status.success() {
                let s = String::from_utf8_lossy(&out.stdout);
                if let Some(h) = s.split_whitespace().next() {
                    return h.to_string();
                }
            }
        }
    }
    panic!("no sha256 tool (shasum/sha256sum) available for {path}")
}

async fn sha256_remote(session: &SshSession, path: &str) -> String {
    let out = exec(session, &format!("sha256sum {path}")).await;
    out.split_whitespace()
        .next()
        .unwrap_or_else(|| panic!("bad sha256sum output: {out}"))
        .to_string()
}

/// 写回 → 读回 roundtrip + 独立 sha256 取证。内容跨 256KiB 单请求上限
/// （300_001 字节确定性伪随机），覆盖 write 的多请求顺序路径；夹具单独
/// 路径避免与其他用例互踩。
#[tokio::test]
async fn write_then_read_roundtrip_sha256_matches() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");
    let remote = "/tmp/ottr-t3-rw-roundtrip.bin";

    // 300_001 字节确定性伪随机（跨 256KiB 报文上限 → ≥2 个写子请求）
    let payload: Vec<u8> = (0..300_001u32)
        .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
        .collect();
    let local = std::env::temp_dir().join("ottr-t3-rw-roundtrip.local");
    std::fs::write(&local, &payload).expect("write local source");

    // 写回远端（全量覆盖）
    let after = client
        .write_remote_text(remote, &payload)
        .await
        .expect("write_remote_text");
    assert_eq!(after.size, payload.len() as u64, "post-write stat size");

    // 独立取证：本地 shasum vs 远端 exec sha256sum
    assert_eq!(
        sha256_local(local.to_str().unwrap()),
        sha256_remote(&session, remote).await,
        "remote content must equal local payload after write_remote_text"
    );

    // 读回 roundtrip：字节级一致
    let readback = client
        .open_remote_text(remote)
        .await
        .expect("open_remote_text");
    assert_eq!(readback, payload, "read-back bytes must equal payload");

    // 清理
    let _ = client.remove_file(remote).await;
    let _ = std::fs::remove_file(&local);
    let _ = session.disconnect().await;
}

/// exec 先放一个已知小文件 → open_remote_text 读出一致；随后第三方改写
/// （exec 追加）→ 旧快照必须判定冲突；自己写回后的 stat 装进快照后
/// 不得自冲突（回传后快照更新的契约）。
#[tokio::test]
async fn snapshot_conflict_detects_third_party_change_only() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");
    let remote = "/tmp/ottr-t3-snapshot.txt";

    // 独立通道建立远端初值（ground truth 不经被测代码）
    exec(&session, &format!("printf 'v1\\n' > {remote}")).await;
    let first = client.stat(remote).await.expect("stat");
    assert_eq!(
        client.open_remote_text(remote).await.expect("read"),
        b"v1\n"
    );

    // 下载时快照
    let snap = RemoteSnapshot::capture(&first);

    // 第三方改写（size 与 mtime 都变）
    exec(&session, &format!("printf 'third-party\\n' >> {remote}")).await;
    let changed = client.stat(remote).await.expect("stat after third party");
    assert!(
        snap.conflicts_with(&changed),
        "third-party rewrite must conflict with the download-time snapshot"
    );

    // 模拟编辑回传：写回自己的新内容 → 返回的写后 stat 与新快照一致（不自冲突）
    let after = client
        .write_remote_text(remote, b"my edit\n")
        .await
        .expect("write back");
    let fresh = RemoteSnapshot::capture(&after);
    let restat = client.stat(remote).await.expect("stat after write");
    assert!(
        !fresh.conflicts_with(&restat),
        "snapshot taken from post-write stat must not self-conflict"
    );
    assert_eq!(
        client.open_remote_text(remote).await.expect("read back"),
        b"my edit\n"
    );

    // 同内容同秒的边界：size 相同 + mtime 相同 = 无冲突（快照判定的唯一依据）
    let same = client.stat(remote).await.expect("stat same");
    assert!(!fresh.conflicts_with(&same));

    let _ = client.remove_file(remote).await;
    let _ = session.disconnect().await;
}

/// sudo 包装（fixture spike 带密码 sudo，B9 同款）：失败即断言退出码非零。
async fn sudo_exec(session: &SshSession, cmd: &str) {
    exec(
        session,
        &format!("echo spike-pass | sudo -S {cmd} 2>/dev/null"),
    )
    .await;
}

/// BL-204④（判别红测）：**换装失败 → 原文件完好**。构造：sticky 目录（1777）
/// 里 root 属主 0666 文件——spike 可 TRUNC 写（旧实现会原地覆盖成功，截断/
/// 覆盖风险真实存在）但不可 remove/rename（sticky 位挡他人文件）。断言：
/// 保存失败（Err）且原文件内容原样——「失败的保存绝不损坏远端」。
#[tokio::test]
async fn failed_swap_leaves_original_intact() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");

    let dir = format!("/tmp/ottr-t3-2044-{}", std::process::id());
    let remote = format!("{dir}/sticky.txt");

    // 独立通道建造场景（ground truth 不经被测代码）：sticky 目录 + 他人可写文件
    sudo_exec(&session, &format!("rm -rf {dir}")).await;
    sudo_exec(&session, &format!("mkdir -p {dir}")).await;
    sudo_exec(&session, &format!("chmod 1777 {dir}")).await;
    sudo_exec(&session, &format!("sh -c \"printf 'v1\\n' > {remote}\"")).await;
    sudo_exec(&session, &format!("chown root:root {remote}")).await;
    sudo_exec(&session, &format!("chmod 666 {remote}")).await;

    // spike 视角：文件「可写不可删」——换装在 remove 一步必然失败
    let err = client
        .write_remote_text(&remote, b"hostile overwrite\n")
        .await
        .err()
        .expect("save must fail: sticky dir forbids removing a foreign-owned file");
    assert!(
        err.to_string().contains("remove"),
        "error must name the failed swap step (remove), got: {err}"
    );

    // 判别断言：原文件完好（修复前原地 TRUNC 写会把它覆盖掉）
    assert_eq!(
        client.open_remote_text(&remote).await.expect("read back"),
        b"v1\n",
        "BL-204④: a failed save must leave the original file intact"
    );

    sudo_exec(&session, &format!("rm -rf {dir}")).await;
    let _ = session.disconnect().await;
}

/// BL-204④（守卫）：换装保存保留原文件权限位（0640 → 仍 0640）——新 inode
/// 不做 setstat 会拿服务器默认 umask，0600 敏感文件被静默放宽是真实风险面
/// （authorized_keys 类场景）。内容换新 + 权限保真双断言（远端 stat 独立取证）。
#[tokio::test]
async fn write_preserves_mode_through_swap() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");
    let remote = format!("/tmp/ottr-t3-mode-{}.txt", std::process::id());

    exec(&session, &format!("printf 'v1\\n' > {remote}")).await;
    exec(&session, &format!("chmod 640 {remote}")).await;

    let after = client
        .write_remote_text(&remote, b"v2\n")
        .await
        .expect("save");
    assert_eq!(after.mode & 0o7777, 0o640, "post-write stat keeps mode");
    assert_eq!(
        client.open_remote_text(&remote).await.expect("read back"),
        b"v2\n"
    );
    // 独立取证：远端文件系统上的权限位一致
    let mode = exec(&session, &format!("stat -c %a {remote}")).await;
    assert_eq!(mode, "640", "remote fs mode must survive the swap");

    let _ = exec(&session, &format!("rm -f {remote}")).await;
    let _ = session.disconnect().await;
}

/// BL-204④（守卫）：符号链接目标**写穿透**语义保留——链接本体不被换装
/// 顶掉（lstat 分流），target 内容更新。
#[tokio::test]
async fn symlink_write_through_preserves_link() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");
    let dir = format!("/tmp/ottr-t3-sym-{}", std::process::id());
    let real = format!("{dir}/real.txt");
    let link = format!("{dir}/link.txt");

    exec(&session, &format!("rm -rf {dir} && mkdir -p {dir}")).await;
    exec(&session, &format!("printf 'v1\\n' > {real}")).await;
    exec(&session, &format!("ln -s real.txt {link}")).await;

    client
        .write_remote_text(&link, b"v2 through link\n")
        .await
        .expect("save through symlink");
    // 穿透：target 内容更新；链接本体仍是符号链接（test -L 退出码 0 由 exec 断言）
    assert_eq!(
        client.open_remote_text(&real).await.expect("read real"),
        b"v2 through link\n"
    );
    assert_eq!(
        client.open_remote_text(&link).await.expect("read link"),
        b"v2 through link\n"
    );
    exec(&session, &format!("test -L {link}")).await;

    let _ = exec(&session, &format!("rm -rf {dir}")).await;
    let _ = session.disconnect().await;
}
