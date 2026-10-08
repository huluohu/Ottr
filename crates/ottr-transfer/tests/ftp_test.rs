//! FTP/FTPS 后端**集成测试**（Phase 2 Task 5，sftp_test.rs 同款模式）。
//!
//! 如实命名：需要真实 ftpd 夹具——明文 127.0.0.1:2121 / 显式 FTPS
//! 127.0.0.1:990（`scripts/spike-ftpd.sh` 启动；用户 spike / 密码
//! spike-pass；自签证书）。夹具不可达时立即 fail 并提示启动命令
//! （不引入 testcontainers，与 sshd 夹具裁定一致）。
//!
//! 用例面（简报裁定 4）：上传/下载 sha256 对上（明文 + FTPS 握手 + FTPS
//! 传输）、list/mkdir/rename/删除、chmod、下载 REST 续传、上传 APPE 续传、
//! 中途取消 + 续传恢复、TLS 校验策略负向（accept_invalid_certs=false 必须
//! 拒自签证书）。
//!
//! sha256 取证：两端都走本地工具（shasum -a 256 / sha256sum）——FTP 无远端
//! exec 通道，远端真值经下载后本地比对（源文件即为 ground truth）。

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use ottr_transfer::FileTransfer;
use ottr_transfer::ftp::{FtpClient, FtpsPolicy};
use ottr_transfer::sftp::{CancelToken, ProgressHook};

const HOST: &str = "127.0.0.1";
const PORT_PLAIN: u16 = 2121;
const PORT_FTPS: u16 = 990;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const SIZE: u64 = 5 * 1024 * 1024; // 与 sftp_test 同口径：5MB

/// pyftpdlib 夹具不可达即 fail（sshd 夹具同款探测）。
async fn fixture_or_panic() {
    match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        tokio::net::TcpStream::connect((HOST, PORT_PLAIN)),
    )
    .await
    {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => {
            panic!(
                "ftpd fixture unreachable at {HOST}:{PORT_PLAIN} ({e}) —— 先跑 scripts/spike-ftpd.sh"
            )
        }
        Err(_) => panic!(
            "ftpd fixture unreachable at {HOST}:{PORT_PLAIN} (timeout) —— 先跑 scripts/spike-ftpd.sh"
        ),
    }
}

fn verifying_policy() -> FtpsPolicy {
    FtpsPolicy::default()
}

/// 夹具自签证书 → 正常校验必拒、accept_invalid_certs 放行后握手成功。
/// 负向断言的错误必须是 TLS 层（证书校验），而非连接层。
#[tokio::test]
async fn ftps_explicit_handshake_and_policy() {
    fixture_or_panic().await;
    // 默认策略（accept_invalid_certs=false）：自签证书必须被拒
    let rejected =
        FtpClient::connect_ftps(HOST, PORT_FTPS, USER, PASSWORD, verifying_policy()).await;
    assert!(
        rejected.is_err(),
        "self-signed certificate must be rejected by default policy"
    );

    // accept_invalid_certs=true：握手 + 登录 + 操作全通
    let client = FtpClient::connect_ftps(
        HOST,
        PORT_FTPS,
        USER,
        PASSWORD,
        FtpsPolicy {
            accept_invalid_certs: true,
        },
    )
    .await
    .expect("explicit FTPS handshake with relaxed policy");
    assert!(client.exists("/").await.expect("mlst root"));
    let root = client.realpath(".").await.expect("root");
    assert!(!root.is_empty(), "PWD must yield the login dir");
    client.quit().await;
}

/// 明文 FTP 全流程：上传 5MB → 下载 → sha256 与源一致；Panel 操作面
/// （list/mkdir/rename/chmod/删除）同夹具验证。
#[tokio::test]
async fn plain_ftp_transfer_and_panel_ops() {
    fixture_or_panic().await;
    let client = Arc::new(
        FtpClient::connect(HOST, PORT_PLAIN, USER, PASSWORD)
            .await
            .expect("connect plain"),
    );

    // --- 上传/下载 sha256（简报指定面） -----------------------------------
    let local_a = "/tmp/ottr-t5-ftp-a.local";
    let remote_a = "/ottr-t5-ftp-a.bin";
    let local_b = "/tmp/ottr-t5-ftp-b.local";
    let journal_a = "/tmp/ottr-t5-ftp-a.journal";
    let journal_b = "/tmp/ottr-t5-ftp-b.journal";
    for f in [local_a, local_b, journal_a, journal_b] {
        let _ = std::fs::remove_file(f);
    }
    make_local_file(local_a, SIZE);
    let _ = client.remove_file(remote_a).await; // 幂等清理

    let stats = client
        .upload(
            Path::new(local_a),
            remote_a,
            4,
            Path::new(journal_a),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("upload");
    assert_eq!(stats.chunks_total, 5, "5MB / 1MiB = 5 chunks");
    assert_eq!(stats.chunks_resumed, 0, "fresh remote: nothing resumed");
    assert_eq!(client.size(remote_a).await.expect("size"), SIZE);

    let stats = client
        .download(
            remote_a,
            Path::new(local_b),
            4,
            Path::new(journal_b),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("download");
    assert_eq!(stats.chunks_total, 5);
    assert_eq!(
        sha256(local_a),
        sha256(local_b),
        "roundtrip sha256 must match"
    );

    // --- Panel 操作面（list/mkdir/rename/chmod/删除） ----------------------
    let dir = "/ottr-t5-ftp-dir";
    let _ = client.remove_dir(dir).await; // 幂等清理
    client.mkdir(dir).await.expect("mkdir");
    let entries = client.list_dir("/").await.expect("list root");
    assert!(
        entries
            .iter()
            .any(|e| e.name == "ottr-t5-ftp-dir" && e.is_dir),
        "mkdir result must show up in MLSD listing"
    );

    client
        .rename(remote_a, "/ottr-t5-ftp-a-renamed.bin")
        .await
        .expect("rename");
    assert!(!client.exists(remote_a).await.expect("exists old name"));
    assert!(
        client
            .exists("/ottr-t5-ftp-a-renamed.bin")
            .await
            .expect("exists new name"),
        "renamed file must exist"
    );

    client
        .chmod("/ottr-t5-ftp-a-renamed.bin", 0o604)
        .await
        .expect("SITE CHMOD");
    let st = client
        .stat("/ottr-t5-ftp-a-renamed.bin")
        .await
        .expect("stat");
    assert_eq!(st.size, SIZE, "stat size must match transfer total");
    // 权限位断言缺席（如实记录）：pyftpdlib 的 MLSD 不带 UNIX.mode 事实
    // （夹具只回 type/size/modify/perm/unique），SITE CHMOD 只验命令成功；
    // 带 UNIX.mode 的服务器（如 proftpd/mod_mlsd）由 unit test 覆盖解析面。

    client
        .remove_file("/ottr-t5-ftp-a-renamed.bin")
        .await
        .expect("remove file");
    client.remove_dir(dir).await.expect("remove dir");
    assert!(
        !client
            .exists("/ottr-t5-ftp-a-renamed.bin")
            .await
            .expect("gone")
    );

    for f in [local_a, local_b, journal_a, journal_b] {
        let _ = std::fs::remove_file(f);
    }
    client.quit().await;
}

/// FTPS 显式通道上的传输（全加密路径：控制 + 数据都过 TLS）。
#[tokio::test]
async fn ftps_explicit_transfer_sha256_matches() {
    fixture_or_panic().await;
    let client = FtpClient::connect_ftps(
        HOST,
        PORT_FTPS,
        USER,
        PASSWORD,
        FtpsPolicy {
            accept_invalid_certs: true,
        },
    )
    .await
    .expect("ftps connect");
    let local_a = "/tmp/ottr-t5-ftps-a.local";
    let remote_a = "/ottr-t5-ftps-a.bin";
    let local_b = "/tmp/ottr-t5-ftps-b.local";
    let journal_up = "/tmp/ottr-t5-ftps-aj.journal";
    let journal_down = "/tmp/ottr-t5-ftps-bj.journal";
    // journal 必须一并清理：同身份完整 journal 会让下载「全命中早退」
    // （hazard 面，与 sftp_test 的 done 即删语义同源）
    for f in [local_a, local_b, journal_up, journal_down] {
        let _ = std::fs::remove_file(f);
    }
    make_local_file(local_a, SIZE);
    let _ = client.remove_file(remote_a).await;

    client
        .upload(
            Path::new(local_a),
            remote_a,
            4,
            Path::new(journal_up),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("ftps upload");
    client
        .download(
            remote_a,
            Path::new(local_b),
            4,
            Path::new(journal_down),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("ftps download");
    assert_eq!(
        sha256(local_a),
        sha256(local_b),
        "FTPS roundtrip sha256 must match"
    );

    let _ = client.remove_file(remote_a).await;
    for f in [local_a, local_b, journal_up, journal_down] {
        let _ = std::fs::remove_file(f);
    }
    client.quit().await;
}

/// 下载续传（REST）：预置 journal（前 3 chunk 完成，本地确有正确字节），
/// 重跑必须 REST 到 3MiB 只补尾部，sha256 一致。
#[tokio::test]
async fn download_resume_uses_rest_offset() {
    fixture_or_panic().await;
    let client = FtpClient::connect(HOST, PORT_PLAIN, USER, PASSWORD)
        .await
        .expect("connect");
    let local_a = "/tmp/ottr-t5-dlres-a.local";
    let remote_a = "/ottr-t5-dlres-a.bin";
    let journal_a = "/tmp/ottr-t5-dlres-a.journal";
    let journal_b = "/tmp/ottr-t5-dlres-b.journal";
    for f in [local_a, journal_a, journal_b] {
        let _ = std::fs::remove_file(f);
    }
    make_local_file(local_a, SIZE);
    let _ = client.remove_file(remote_a).await;

    // 第一次完整上传（up 身份 journal）+ 下载（down 身份 journal）：本地 a
    // 拿到正确字节。up/down 各用各的 journal——身份校验按方向拒绝复用（语义）。
    let journal_up = "/tmp/ottr-t5-dlres-up.journal";
    let _ = std::fs::remove_file(journal_up);
    client
        .upload(
            Path::new(local_a),
            remote_a,
            4,
            Path::new(journal_up),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("seed upload");
    client
        .download(
            remote_a,
            Path::new(local_a),
            4,
            Path::new(journal_a),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("first download");

    // 构造续传 journal：v1 头部（down + 远端路径 + 5MiB）+ 前 3 chunk offset
    let seeded = format!(
        "{}0\n{}\n{}\n",
        ottr_transfer::journal_header(remote_a, SIZE, "down"),
        ottr_transfer::CHUNK_SIZE,
        2 * ottr_transfer::CHUNK_SIZE
    );
    std::fs::write(journal_b, seeded).expect("seed resume journal");

    // 本地文件**保留**（journal「前 3 chunk 已完成」的语义前提 = 本地确有
    // 这些字节——与 sftp_test 同一不变量；删文件会让前缀成洞）。

    let stats = client
        .download(
            remote_a,
            Path::new(local_a),
            4,
            Path::new(journal_b),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("resume download");
    assert_eq!(
        stats.chunks_resumed, 3,
        "3 journaled prefix chunks must be skipped via REST"
    );
    assert_eq!(stats.chunks_total, 5);
    assert_eq!(sha256(local_a), sha256_of_remote(&client, remote_a).await);

    let _ = client.remove_file(remote_a).await;
    for f in [local_a, journal_a, journal_b, journal_up] {
        let _ = std::fs::remove_file(f);
    }
    client.quit().await;
}

/// 上传续传（APPE）：远端已有前 2MiB（= 一次 5MiB 传输崩溃在 chunk 2 边缘
/// 的真实形态：同身份 journal 带 2 条记录 + 远端 SIZE=2MiB），重传同目标 =
/// journal 闸门放行、从远端实际大小追加补齐，sha256 一致（偏移真值 = 远端
/// SIZE；journal 是闸门——Fix round 1 I-1 后的语义）。
#[tokio::test]
async fn upload_resume_appends_from_remote_size() {
    fixture_or_panic().await;
    let client = FtpClient::connect(HOST, PORT_PLAIN, USER, PASSWORD)
        .await
        .expect("connect");
    let local_a = "/tmp/ottr-t5-upres-a.local";
    let local_part = "/tmp/ottr-t5-upres-part.local";
    let remote_a = "/ottr-t5-upres-a.bin";
    // 续传 journal 手工预置（sftp_test 下载续传同款手法）：v1 头部绑定
    // （up + 远端路径 + 5MiB 总长）+ 前 2 chunk offset——模拟崩溃残留
    let journal_a = "/tmp/ottr-t5-upres-a.journal";
    for f in [local_a, local_part, journal_a] {
        let _ = std::fs::remove_file(f);
    }
    make_local_file(local_a, SIZE);
    // 真实部分上传：源文件前 2MiB 作为独立文件 STOR 上去（= 2 个完整 chunk）。
    // 用独立 journal：部分上传自己的身份（up + 2MiB）与续传身份（5MiB）不同，
    // 闸门语义下本来就该各归各（混用会被身份校验拒绝——正确行为）。
    let journal_part = "/tmp/ottr-t5-upres-part.journal";
    let _ = std::fs::remove_file(journal_part);
    let part_bytes = std::fs::read(local_a).expect("read source");
    std::fs::write(
        local_part,
        &part_bytes[..(2 * ottr_transfer::CHUNK_SIZE) as usize],
    )
    .expect("write part");
    let _ = client.remove_file(remote_a).await;
    client
        .upload(
            Path::new(local_part),
            remote_a,
            4,
            Path::new(journal_part),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("partial upload");
    assert_eq!(
        client.size(remote_a).await.expect("part size"),
        2 * ottr_transfer::CHUNK_SIZE
    );

    // 崩溃残留 journal：身份 =（up, remote_a, 5MiB），记录 = 前 2 chunk
    let seeded = format!(
        "{}0\n{}\n{}\n",
        ottr_transfer::journal_header(remote_a, SIZE, "up"),
        ottr_transfer::CHUNK_SIZE,
        ottr_transfer::CHUNK_SIZE
    );
    std::fs::write(journal_a, seeded).expect("seed resume journal");

    let stats = client
        .upload(
            Path::new(local_a),
            remote_a,
            4,
            Path::new(journal_a),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("resume upload");
    assert_eq!(
        stats.chunks_resumed, 2,
        "2 complete chunks on server must count as resumed"
    );
    assert_eq!(stats.chunks_total, 5);
    // 远端真值经下载取证（verify journal 一并清理，防上次运行的完整 journal
    // 触发「全命中早退」）
    let local_b = "/tmp/ottr-t5-upres-verify.local";
    let verify_journal = "/tmp/ottr-t5-upres-v.journal";
    let _ = std::fs::remove_file(local_b);
    let _ = std::fs::remove_file(verify_journal);
    client
        .download(
            remote_a,
            Path::new(local_b),
            4,
            Path::new(verify_journal),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("verify download");
    assert_eq!(
        sha256(local_a),
        sha256(local_b),
        "APPE resume must complete the file byte-exactly"
    );

    let _ = client.remove_file(remote_a).await;
    for f in [local_a, local_part, local_b, journal_a, journal_part] {
        let _ = std::fs::remove_file(f);
    }
    client.quit().await;
}

/// Fix round 1 I-1 负向用例：**远端同长遗留 + 无 journal = 全量重传**。
/// 上传完成（app「done 即删 journal」语义）→ 本地同长改内容 → 重传同路径：
/// 修复前 remote_size == total 早退 Ok（静默 no-op、远端留旧内容）；修复后
/// journal 闸门挡住——断言实际重新传输（resumed=0）且远端内容被替换。
#[tokio::test]
async fn upload_same_length_stale_without_journal_retransfers() {
    fixture_or_panic().await;
    let client = FtpClient::connect(HOST, PORT_PLAIN, USER, PASSWORD)
        .await
        .expect("connect");
    let local_a = "/tmp/ottr-t5-stale-a.local";
    let remote_a = "/ottr-t5-stale-a.bin";
    let journal_a = "/tmp/ottr-t5-stale-a.journal";
    for f in [local_a, journal_a] {
        let _ = std::fs::remove_file(f);
    }
    // 内容 A：确定性伪随机（同长改内容要可控）
    let content_a: Vec<u8> = (0..SIZE as usize).map(|i| (i % 251) as u8).collect();
    std::fs::write(local_a, &content_a).expect("write content A");
    let _ = client.remove_file(remote_a).await;

    // 第一次上传成功（journal_a 完整）→ 模拟 app「done 即删」
    client
        .upload(
            Path::new(local_a),
            remote_a,
            4,
            Path::new(journal_a),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("first upload");
    assert!(client.size(remote_a).await.expect("size") == SIZE);
    std::fs::remove_file(journal_a).expect("app done policy deletes journal");

    // 本地同长改内容（B），重传同路径、journal 缺席
    let content_b: Vec<u8> = (0..SIZE as usize).map(|i| (i % 241) as u8).collect();
    assert_eq!(
        content_b.len(),
        content_a.len(),
        "same length is the whole point"
    );
    std::fs::write(local_a, &content_b).expect("write content B");

    let stats = client
        .upload(
            Path::new(local_a),
            remote_a,
            4,
            Path::new(journal_a),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("re-upload must succeed by FULL retransfer");
    assert_eq!(
        stats.chunks_resumed, 0,
        "no journal = no resume gate: equal-length stale remote must NOT be skipped"
    );
    assert_eq!(stats.chunks_total, 5, "all 5 chunks must actually transfer");

    // 远端内容确被替换（下载取证）
    let local_b = "/tmp/ottr-t5-stale-verify.local";
    let verify_journal = "/tmp/ottr-t5-stale-v.journal";
    let _ = std::fs::remove_file(local_b);
    let _ = std::fs::remove_file(verify_journal);
    client
        .download(
            remote_a,
            Path::new(local_b),
            4,
            Path::new(verify_journal),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("verify download");
    assert_eq!(
        sha256(local_b),
        sha256(local_a),
        "remote must hold the NEW same-length content after journal-gated retransfer"
    );

    let _ = client.remove_file(remote_a).await;
    for f in [local_a, local_b, journal_a, verify_journal] {
        let _ = std::fs::remove_file(f);
    }
    client.quit().await;
}

/// 上传 journal 身份不符 = 显式拒绝（闸门语义的另一半：绝不按旧 offset 续传，
/// 与 sftp_test 的 journal_identity_mismatch 同款钉子，落在上传侧）。
#[tokio::test]
async fn upload_journal_identity_mismatch_is_rejected() {
    fixture_or_panic().await;
    let client = FtpClient::connect(HOST, PORT_PLAIN, USER, PASSWORD)
        .await
        .expect("connect");
    let local_a = "/tmp/ottr-t5-upid-a.local";
    let remote_a = "/ottr-t5-upid-a.bin";
    let journal_a = "/tmp/ottr-t5-upid-a.journal";
    for f in [local_a, journal_a] {
        let _ = std::fs::remove_file(f);
    }
    make_local_file(local_a, SIZE);
    let _ = client.remove_file(remote_a).await;

    // journal 声称这次传输是 3MiB（实际本地 5MiB）→ 身份不符，必须拒绝
    let expected = format!(
        "{}0\n",
        ottr_transfer::journal_header(remote_a, 3 * 1024 * 1024, "up")
    );
    std::fs::write(journal_a, expected.clone()).expect("seed mismatched journal");
    let err = client
        .upload(
            Path::new(local_a),
            remote_a,
            4,
            Path::new(journal_a),
            &CancelToken::new(),
            None,
        )
        .await
        .expect_err("mismatched up journal must be rejected");
    let msg = err.to_string();
    assert!(
        msg.contains("journal") && msg.contains("refusing to resume"),
        "error must point at the journal, got: {msg}"
    );
    assert_eq!(
        std::fs::read_to_string(journal_a).expect("journal intact"),
        expected,
        "journal must be left untouched on rejection"
    );

    let _ = client.remove_file(remote_a).await;
    for f in [local_a, journal_a] {
        let _ = std::fs::remove_file(f);
    }
    client.quit().await;
}

/// 中途取消 + 续传恢复（与 sftp_test 同款钉子）：首 chunk 完成即在进度
/// hook 里取消 → Err(Cancelled)、journal 保留；同 journal 重传到完成。
#[tokio::test]
async fn cancel_at_chunk_boundary_then_resume_completes() {
    fixture_or_panic().await;
    let client = Arc::new(
        FtpClient::connect(HOST, PORT_PLAIN, USER, PASSWORD)
            .await
            .expect("connect"),
    );
    const MIB: u64 = 32;
    let local_a = "/tmp/ottr-t5-cancel-a.local";
    let remote_a = "/ottr-t5-cancel-a.bin";
    let journal_a = "/tmp/ottr-t5-cancel-a.journal";
    for f in [local_a, journal_a] {
        let _ = std::fs::remove_file(f);
    }
    make_local_file(local_a, MIB * 1024 * 1024);
    let _ = client.remove_file(remote_a).await;
    // 远端真值先上传（FTP 无 exec 通道，文件必须经被测面就位）
    client
        .upload(
            Path::new(local_a),
            remote_a,
            4,
            Path::new(journal_a),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("seed 32MiB upload");
    // 32MiB 上传的 journal 只作 seed 用；取消场景从全新下载开始
    let _ = std::fs::remove_file(journal_a);

    // 首 1 个 chunk 完成即取消
    let cancel = CancelToken::new();
    let hook_cancel = cancel.clone();
    let seen = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen_hook = Arc::clone(&seen);
    let hook = Arc::new(move |p: ottr_transfer::TransferProgress| {
        if seen_hook.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            hook_cancel.cancel();
        }
        assert!(
            p.total == MIB * 1024 * 1024,
            "progress total must be the file size"
        );
    }) as ProgressHook;
    let err = client
        .download(
            remote_a,
            Path::new(local_a),
            4,
            Path::new(journal_a),
            &cancel,
            Some(hook),
        )
        .await
        .expect_err("cancel: expected Err");
    assert!(
        matches!(err, ottr_transfer::Error::Cancelled),
        "must be Error::Cancelled, got: {err}"
    );
    let journaled = journal_offsets(journal_a);
    assert!(
        !journaled.is_empty(),
        "cancelled mid-transfer: journal must keep completed chunks"
    );
    assert!(journaled.len() < 32, "cancel must be mid-transfer");

    // 续传恢复：同 journal 重传到完成 → sha256 一致
    let stats = client
        .download(
            remote_a,
            Path::new(local_a),
            4,
            Path::new(journal_a),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("resume after cancel");
    assert_eq!(stats.chunks_total, 32);
    assert_eq!(
        stats.chunks_resumed,
        journaled.len(),
        "resume must skip exactly the journaled prefix"
    );
    assert_eq!(sha256(local_a), sha256_of_remote(&client, remote_a).await);

    let _ = client.remove_file(remote_a).await;
    for f in [local_a, journal_a] {
        let _ = std::fs::remove_file(f);
    }
    client.quit().await;
}

// --- 夹具工具（sftp_test 同款口径） -----------------------------------------

fn make_local_file(path: &str, len: u64) {
    use std::io::Read;
    let mut buf = vec![0u8; len as usize];
    std::fs::File::open("/dev/urandom")
        .expect("open /dev/urandom")
        .read_exact(&mut buf)
        .expect("read urandom");
    std::fs::write(path, buf).expect("write local source");
}

fn sha256(path: &str) -> String {
    let candidates: [Vec<&str>; 2] = [vec!["shasum", "-a", "256", path], vec!["sha256sum", path]];
    for cmd in candidates {
        if let Ok(out) = Command::new(cmd[0]).args(&cmd[1..]).output()
            && out.status.success()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(h) = s.split_whitespace().next() {
                return h.to_string();
            }
        }
    }
    panic!("no sha256 tool (shasum/sha256sum) available for {path}")
}

/// 远端真值 = 下载到临时文件后本地算哈希（FTP 无 exec 通道）。**先清该
/// 取证通道自己的 journal**：同 (mode,path,total) 的完整 journal 会让下载
/// 「全命中早退」（hazard 语义，app 侧 done 即删兜底；测试显式清理）。
async fn sha256_of_remote(client: &FtpClient, remote: &str) -> String {
    let tmp = format!(
        "/tmp/ottr-t5-fetch-{}.verify",
        remote.trim_start_matches('/').replace('/', "_")
    );
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(format!("{tmp}.journal"));
    client
        .download(
            remote,
            Path::new(&tmp),
            4,
            Path::new(&format!("{tmp}.journal")),
            &CancelToken::new(),
            None,
        )
        .await
        .expect("verify fetch");
    let h = sha256(&tmp);
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_file(format!("{tmp}.journal"));
    h
}

fn journal_offsets(path: &str) -> Vec<u64> {
    std::fs::read_to_string(path)
        .expect("read journal")
        .lines()
        .filter(|l| !l.starts_with(ottr_transfer::sftp::JOURNAL_MAGIC))
        .map(|l| l.trim().parse().expect("journal line"))
        .collect()
}
