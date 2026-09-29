//! Spike #4 验收 CLI（Task 8）：SFTP 并行分块 + 断点续传。
//!
//! Usage:
//! ```text
//! cargo run -p ottr-ssh --release --example sftp_spike -- down <remote> <local> --journal <path> [--chunks N]
//! cargo run -p ottr-ssh --release --example sftp_spike -- up   <local> <remote> --journal <path> [--chunks N]
//! ```
//!
//! - 夹具：`scripts/spike-sshd.sh`（127.0.0.1:2222，spike / spike-pass）；
//! - 主机密钥 pin 自 `fixtures/known_hosts`（同 real_fixture，不静默放行）；
//! - `--chunks` 为并发 worker 数（默认 4；对比单通道时传 1）；
//! - journal：每完成一个 chunk 追加一行 offset，进程被杀后同命令重跑即续传
//!   （正确性不变量见 sftp.rs 模块注释）。
//!
//! 验收路径（Task 8 简报 Step 2/3）：传 1GB 至 ~40% `kill -9`，重跑同命令，
//! 日志出现 `resume from chunk N`（N>0），完成后双端 sha256 一致。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use ottr_ssh::sftp::{download_parallel, upload_parallel};
use ottr_ssh::{AuthMethod, connect};
use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/known_hosts");

/// 从 known_hosts 提取 `[127.0.0.1]:2222` 的公钥并生成指纹 pin 策略
/// （与 examples/real_fixture.rs 同款；spike 阶段允许复制，Phase 1 收敛）。
fn pinned_host_key_policy() -> ottr_ssh::HostKeyPolicy {
    let content = std::fs::read_to_string(KNOWN_HOSTS)
        .unwrap_or_else(|e| panic!("read {KNOWN_HOSTS}: {e}（先跑 scripts/spike-sshd.sh）"));
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
    Arc::new(move |fingerprint: &str| {
        if fingerprint == pinned_fp {
            true
        } else {
            eprintln!("HOST KEY MISMATCH: got {fingerprint}, pinned {pinned_fp}");
            false
        }
    })
}

struct Args {
    direction: String,
    src: String,
    dst: String,
    journal: PathBuf,
    chunks: usize,
}

fn parse_args() -> Args {
    let mut it = std::env::args().skip(1);
    let direction = it.next().unwrap_or_else(|| usage());
    let src = it.next().unwrap_or_else(|| usage());
    let dst = it.next().unwrap_or_else(|| usage());
    let mut journal = PathBuf::new();
    let mut chunks = 4usize;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--journal" => journal = PathBuf::from(it.next().unwrap_or_else(|| usage())),
            "--chunks" => {
                chunks = it.next().unwrap_or_else(|| usage()).parse().unwrap_or_else(|_| usage())
            }
            _ => usage(),
        }
    }
    if journal.as_os_str().is_empty() {
        usage();
    }
    Args { direction, src, dst, journal, chunks }
}

fn usage() -> ! {
    eprintln!(
        "usage: sftp_spike <down|up> <src> <dst> --journal <path> [--chunks N]\n\
         e.g.  sftp_spike down /tmp/big1g /tmp/local1g --journal /tmp/dl.journal --chunks 4"
    );
    std::process::exit(2);
}

#[tokio::main]
async fn main() -> ottr_ssh::Result<()> {
    let args = parse_args();
    let policy = pinned_host_key_policy();

    let session = connect(
        HOST,
        PORT,
        USER,
        AuthMethod::Password(PASSWORD.to_string()),
        policy,
    )
    .await?;
    println!("connected {USER}@{HOST}:{PORT} (host key pinned via known_hosts)");

    let started = Instant::now();
    let stats = match args.direction.as_str() {
        "down" => {
            download_parallel(&session, &args.src, Path::new(&args.dst), args.chunks, &args.journal)
                .await?
        }
        "up" => {
            upload_parallel(&session, Path::new(&args.src), &args.dst, args.chunks, &args.journal)
                .await?
        }
        _ => usage(),
    };
    let wall = started.elapsed();

    // T7 经验：russh Handle::drop 不关连接，显式断连不留悬挂 sshd/TCP
    session.disconnect().await?;

    println!(
        "{} done: {:.2} MiB in {:.2}s = {:.1} MB/s (chunks {}/{}, resumed {}, workers {})",
        args.direction,
        stats.total_bytes as f64 / (1024.0 * 1024.0),
        wall.as_secs_f64(),
        stats.mb_per_s(),
        stats.chunks_total,
        stats.chunks_total,
        stats.chunks_resumed,
        args.chunks,
    );
    Ok(())
}
