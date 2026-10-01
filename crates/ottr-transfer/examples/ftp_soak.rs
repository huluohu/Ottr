//! T12 Phase 2 验收 · 稳定性维：FTP 传输循环长跑驱动（ottr-transfer 真后端）。
//!
//! 连真夹具 pyftpdlib（127.0.0.1:2121，spike/spike-pass），hold 期内反复
//! 「上传 → 下载 → 校验 size → 删远端」一轮；每轮 stderr 打点（与 ottr-bench
//! 同纪律），结束时 stdout 打 RESULT 行给外层驱动脚本汇总。
//!
//! 用法: ftp_soak [hold_secs=60]
//! 第一行 stdout：`PID=<pid>`（外层采样目标，bench 同款）。

use std::path::PathBuf;
use std::time::{Duration, Instant};

use ottr_transfer::FileTransfer;
use ottr_transfer::ftp::FtpClient;
use ottr_transfer::sftp::CancelToken;

const FIXTURE: (&str, u16, &str, &str) = ("127.0.0.1", 2121, "spike", "spike-pass");
const ROUND_BYTES: usize = 8 * 1024 * 1024; // 每轮 8MiB（确定性伪随机，upload+download 双向）

fn main() {
    println!("PID={}", std::process::id());
    let hold: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let result = runtime.block_on(run(hold));
    println!("RESULT {result}");
}

async fn run(hold: u64) -> String {
    let deadline = Instant::now() + Duration::from_secs(hold);
    let client = FtpClient::connect(FIXTURE.0, FIXTURE.1, FIXTURE.2, FIXTURE.3)
        .await
        .expect("ftp fixture connect");

    // 本地源文件：确定性伪随机 8MiB（LCG，避免每次重生成成本，upload 源不变）。
    let tmp = std::env::temp_dir().join("ottr-ftp-soak-src.bin");
    if !tmp.exists() || tmp.metadata().map(|m| m.len() as usize).unwrap_or(0) != ROUND_BYTES {
        let mut buf = vec![0u8; ROUND_BYTES];
        let mut seed = 0x5eed_1234u32;
        for b in buf.iter_mut() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *b = (seed >> 24) as u8;
        }
        std::fs::write(&tmp, &buf).expect("write local source");
    }
    let local_dl = std::env::temp_dir().join("ottr-ftp-soak-dl.bin");

    let cancel = CancelToken::new();
    // 双向各自一份 journal，成功即删（app「done 即删」同款语义——否则 journal
    // 闸门（T5 I-1）会正确地拒绝跨方向/跨轮复用，把每轮变成静默早退或报错）。
    let journal_up = PathBuf::from("/tmp/ottr-ftp-soak-up.journal");
    let journal_down = PathBuf::from("/tmp/ottr-ftp-soak-down.journal");
    let _ = std::fs::remove_file(&journal_up);
    let _ = std::fs::remove_file(&journal_down);
    let remote = "/ottr-ftp-soak.bin";

    let mut rounds = 0u64;
    let mut bytes = 0u64;
    let mut errors = 0u64;
    let mut first_err: Option<String> = None;

    while Instant::now() < deadline {
        eprintln!("[ftp-soak] round {} begin", rounds + 1);
        let mut round_err = None;
        // 上传 → 下载 → 下载件 size 校验 → 清理（任一步失败记一轮错误，连接重建再续）。
        match client.upload(&tmp, remote, 1, &journal_up, &cancel, None).await {
            Ok(s) => {
                bytes += s.total_bytes;
                let _ = std::fs::remove_file(&journal_up); // done 即删
                match client
                    .download(remote, &local_dl, 1, &journal_down, &cancel, None)
                    .await
                {
                    Ok(s) => {
                        bytes += s.total_bytes;
                        let _ = std::fs::remove_file(&journal_down); // done 即删
                        let dl_len = std::fs::metadata(&local_dl).map(|m| m.len()).unwrap_or(0);
                        if dl_len != ROUND_BYTES as u64 {
                            round_err = Some(format!("download size mismatch: {dl_len}"));
                        }
                    }
                    Err(e) => round_err = Some(format!("download: {e}")),
                }
            }
            Err(e) => round_err = Some(format!("upload: {e}")),
        }
        // best-effort 清理远端 + 本地下载件
        let _ = client.remove_file(remote).await;
        let _ = std::fs::remove_file(&local_dl);
        if let Some(e) = round_err {
            errors += 1;
            if first_err.is_none() {
                first_err = Some(e.clone());
            }
            eprintln!("[ftp-soak] round {} error: {e}", rounds + 1);
            // 连接可能已坏：重连（失败则退出循环，RESULT 照发）
            if FtpClient::connect(FIXTURE.0, FIXTURE.1, FIXTURE.2, FIXTURE.3)
                .await
                .is_err()
            {
                eprintln!("[ftp-soak] reconnect failed, exiting loop");
                break;
            }
        } else {
            eprintln!("[ftp-soak] round {} done: {}B", rounds + 1, ROUND_BYTES * 2);
        }
        rounds += 1;
    }

    let _ = client.quit().await;
    let _ = std::fs::remove_file(&tmp);
    format!(
        "mode=ftp-soak hold={hold}s ftp_rounds={rounds} ftp_bytes={bytes} errors={errors}{}",
        first_err.map(|e| format!(" first_err={e}")).unwrap_or_default()
    )
}
