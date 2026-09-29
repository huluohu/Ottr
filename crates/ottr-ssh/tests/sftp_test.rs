//! Task 8（Spike #4）**集成测试**：SFTP 并行分块 + 断点续传。
//!
//! 如实命名：这不是纯单测——它需要真实 sshd 夹具（127.0.0.1:2222，
//! `scripts/spike-sshd.sh` 启动；用户 spike / 密码 spike-pass）。夹具不可达时
//! 立即 fail 并提示启动命令；按 Task 8 裁定不引入 testcontainers，保持简单。
//!
//! 简报 Step 1 指定的真测试：5MB 文件、1 MiB chunk × 4 并发下载，sha256 对上。
//! 另补 3 个对称/续传用例（上传全量、下载续传、上传续传——续传用 journal
//! 预置 offset 的方式模拟"进程已传过一部分"，避免在测试里 kill 子进程）。
//!
//! sha256 取证走独立通道：远端 `sha256sum`（exec），本地 `shasum -a 256`
//! （macOS 夹具环境），不依赖被测代码算哈希。

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use ottr_ssh::sftp::{CHUNK_SIZE, TransferStats, download_parallel, upload_parallel};
use ottr_ssh::{AuthMethod, SshSession, connect};
use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};
use russh::ChannelMsg;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");
const SIZE: u64 = 5 * 1024 * 1024; // 简报：5MB

/// 夹具可达性探测：不可达即 fail 并提示（裁定：不引入 testcontainers）。
async fn fixture_or_panic() {
    match tokio::time::timeout(std::time::Duration::from_secs(2), tokio::net::TcpStream::connect((HOST, PORT))).await {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => panic!(
            "sshd fixture unreachable at {HOST}:{PORT} ({e}) —— 先跑 scripts/spike-sshd.sh"
        ),
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
    connect(HOST, PORT, USER, AuthMethod::Password(PASSWORD.to_string()), pinned_host_key_policy())
        .await
        .expect("connect fixture")
}

/// 远程执行命令（PTY + exec，real_fixture 同款模式），断言退出码 0，返回输出。
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
            // Eof 先于 ExitStatus 到达：继续等退出码，直到通道 Close
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    assert_eq!(exit_code, Some(0), "remote command failed: {cmd}");
    String::from_utf8_lossy(&out).trim().to_string()
}

/// 本地 sha256（shasum -a 256，macOS 夹具环境；失败回退 sha256sum）。
fn sha256_local(path: &str) -> String {
    let candidates: [Vec<&str>; 2] = [
        vec!["shasum", "-a", "256", path],
        vec!["sha256sum", path],
    ];
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

/// 远端生成 urandom 源文件（独立于被测代码的 ground truth）。
async fn make_remote_file(session: &SshSession, path: &str, mib: u64) {
    exec(session, &format!("dd if=/dev/urandom of={path} bs=1048576 count={mib} 2>/dev/null")).await;
}

/// 本地生成 urandom 文件（上传用例的源）。
fn make_local_file(path: &str, len: u64) {
    use std::io::Read;
    let mut buf = vec![0u8; len as usize];
    std::fs::File::open("/dev/urandom")
        .expect("open /dev/urandom")
        .read_exact(&mut buf)
        .expect("read urandom");
    std::fs::write(path, buf).expect("write local source");
}

struct Paths {
    remote_a: String,
    remote_b: String,
    local_a: String,
    local_b: String,
    journal_a: String,
    journal_b: String,
}

fn paths(tag: &str) -> Paths {
    Paths {
        remote_a: format!("/tmp/ottr-t8-{tag}-a.bin"),
        remote_b: format!("/tmp/ottr-t8-{tag}-b.bin"),
        local_a: format!("/tmp/ottr-t8-{tag}-a.local"),
        local_b: format!("/tmp/ottr-t8-{tag}-b.local"),
        journal_a: format!("/tmp/ottr-t8-{tag}-a.journal"),
        journal_b: format!("/tmp/ottr-t8-{tag}-b.journal"),
    }
}

fn cleanup_local(p: &Paths) {
    for f in [&p.local_a, &p.local_b, &p.journal_a, &p.journal_b] {
        let _ = std::fs::remove_file(f);
    }
}

async fn cleanup_remote(session: &SshSession, p: &Paths) {
    let _ = exec(session, &format!("rm -f {} {}", p.remote_a, p.remote_b)).await;
}

fn journal_offsets(path: &str) -> Vec<u64> {
    std::fs::read_to_string(path)
        .expect("read journal")
        .lines()
        .map(|l| l.trim().parse().expect("journal line"))
        .collect()
}

/// 简报 Step 1 指定用例：5MB 文件、1 MiB chunk × 4 并发下载，sha256 对上。
#[tokio::test]
async fn download_5mb_4workers_sha256_matches() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let p = paths("dl-full");
    cleanup_local(&p);
    cleanup_remote(&session, &p).await;
    make_remote_file(&session, &p.remote_a, 5).await;

    let stats: TransferStats =
        download_parallel(&session, &p.remote_a, Path::new(&p.local_a), 4, Path::new(&p.journal_a))
            .await
            .expect("download");
    assert_eq!(stats.chunks_total, 5, "5MB / 1MiB = 5 chunks");
    assert_eq!(stats.chunks_resumed, 0, "fresh journal: nothing resumed");
    assert_eq!(sha256_local(&p.local_a), sha256_remote(&session, &p.remote_a).await);

    cleanup_remote(&session, &p).await;
    cleanup_local(&p);
    let _ = session.disconnect().await;
}

/// 下载续传：预置 journal（前 3 chunk 已完成，且本地确有对应正确字节），
/// 重跑必须跳过这 3 块、只补后 2 块，最终 sha256 一致、journal 补全 5 行。
#[tokio::test]
async fn download_resume_skips_journaled_chunks() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let p = paths("dl-resume");
    cleanup_local(&p);
    cleanup_remote(&session, &p).await;
    make_remote_file(&session, &p.remote_a, 5).await;

    // 第一次完整下载：建立"前 3 块已正确落盘"的真实前提
    download_parallel(&session, &p.remote_a, Path::new(&p.local_a), 4, Path::new(&p.journal_a))
        .await
        .expect("first download");

    // 构造续传 journal：chunk 0/1/2（offset 0、1MiB、2MiB）标记已完成
    std::fs::write(&p.journal_b, format!("0\n{}\n{}\n", CHUNK_SIZE, 2 * CHUNK_SIZE))
        .expect("seed resume journal");

    let stats = download_parallel(&session, &p.remote_a, Path::new(&p.local_a), 4, Path::new(&p.journal_b))
        .await
        .expect("resume download");
    assert_eq!(stats.chunks_resumed, 3, "3 journaled chunks must be skipped");
    assert_eq!(stats.chunks_total, 5);
    assert_eq!(sha256_local(&p.local_a), sha256_remote(&session, &p.remote_a).await);

    let mut offs = journal_offsets(&p.journal_b);
    offs.sort_unstable();
    assert_eq!(
        offs,
        vec![0, CHUNK_SIZE, 2 * CHUNK_SIZE, 3 * CHUNK_SIZE, 4 * CHUNK_SIZE],
        "journal must record all 5 chunk offsets after completion"
    );

    cleanup_remote(&session, &p).await;
    cleanup_local(&p);
    let _ = session.disconnect().await;
}

/// 上传全量：本地 5MB → 远端，远端 sha256 与本地一致。
#[tokio::test]
async fn upload_5mb_4workers_sha256_matches() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let p = paths("up-full");
    cleanup_local(&p);
    cleanup_remote(&session, &p).await;
    make_local_file(&p.local_a, SIZE);

    let stats = upload_parallel(&session, Path::new(&p.local_a), &p.remote_a, 4, Path::new(&p.journal_a))
        .await
        .expect("upload");
    assert_eq!(stats.chunks_total, 5);
    assert_eq!(stats.chunks_resumed, 0);
    assert_eq!(sha256_local(&p.local_a), sha256_remote(&session, &p.remote_a).await);

    cleanup_remote(&session, &p).await;
    cleanup_local(&p);
    let _ = session.disconnect().await;
}

/// 上传续传：预置 journal（前 3 chunk 已完成）后重传同一远端路径。
/// 关键点：续传重开远端文件**不得 TRUNCATE**（否则跳过的 3 块成洞，sha 必不
/// 一致）；同时校验跳过 + 幂等覆盖后远端内容完好、journal 补全 5 行。
#[tokio::test]
async fn upload_resume_reuses_journaled_chunks() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let p = paths("up-resume");
    cleanup_local(&p);
    cleanup_remote(&session, &p).await;
    make_local_file(&p.local_a, SIZE);

    // 第一次完整上传：远端已有正确内容（前提）
    upload_parallel(&session, Path::new(&p.local_a), &p.remote_a, 4, Path::new(&p.journal_a))
        .await
        .expect("first upload");

    std::fs::write(&p.journal_b, format!("0\n{}\n{}\n", CHUNK_SIZE, 2 * CHUNK_SIZE))
        .expect("seed resume journal");

    let stats = upload_parallel(&session, Path::new(&p.local_a), &p.remote_a, 4, Path::new(&p.journal_b))
        .await
        .expect("resume upload");
    assert_eq!(stats.chunks_resumed, 3);
    assert_eq!(sha256_local(&p.local_a), sha256_remote(&session, &p.remote_a).await);

    let mut offs = journal_offsets(&p.journal_b);
    offs.sort_unstable();
    assert_eq!(
        offs,
        vec![0, CHUNK_SIZE, 2 * CHUNK_SIZE, 3 * CHUNK_SIZE, 4 * CHUNK_SIZE],
    );

    cleanup_remote(&session, &p).await;
    cleanup_local(&p);
    let _ = session.disconnect().await;
}
