//! 远端文件本地编辑**端到端**（Phase 2 Task 3 Step 3，B10 上半）：
//! 真夹具（127.0.0.1:2222，`scripts/spike-sshd.sh`）全链演练——
//! 下载 → 模拟编辑（本地改临时副本）→ 自动回传 → 远端内容对上（独立
//! sha256 取证）→ 第三方改写 → 冲突侦出 → 保留本地不重弹 → 强制覆盖 →
//! 快照新鲜（后续保存不再误报）→ 显式关闭零残留。
//!
//! 走的是命令域的可测生命周期核（edit_open/edit_poll/edit_save/edit_close，
//! 与 tauri 命令薄包装同一函数体）；「起系统编辑器」不在测试范围（不 spawn
//! 真编辑器），由组件测试覆盖命令面接线。夹具不可达即 fail 并提示启动命令
//! （与 ottr-transfer sftp_test 同纪律）。
//!
//! Run: `cargo test -p ottr --test remote_edit_fixture`

use std::process::Command;
use std::sync::Arc;

use ottr_lib::{
    edit_close, edit_open, edit_poll, edit_dismiss, edit_save, temp_path_for, temp_root,
    EditMap, EditPollStatus,
};
use ottr_ssh::{AuthMethod, SshSession, connect};
use ottr_transfer::SftpClient;
use russh::ChannelMsg;
use russh::keys::{HashAlg, PublicKey, parse_public_key_base64};

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";
const KNOWN_HOSTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../fixtures/known_hosts");

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

/// 全链：打开 → 编辑 → 自动回传 → 冲突 → 保留 → 覆盖 → 快照新鲜 → 关闭零残留。
#[tokio::test]
async fn remote_edit_end_to_end() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");

    let sid = format!("e2e-{}", std::process::id());
    let remote = format!("/tmp/ottr-t3-e2e-{}.txt", std::process::id());
    let edits: EditMap = EditMap::default();

    // 独立通道建立远端初值（ground truth 不经被测代码）
    exec(&session, &format!("printf 'v1\\n' > {remote}")).await;

    // --- 1. 打开编辑会话：下载到临时目录 + 快照登记 ------------------------
    let temp = edit_open(&edits, &client, &sid, &remote)
        .await
        .expect("edit_open");
    assert_eq!(
        temp,
        temp_path_for(&sid, &remote),
        "temp path must follow the ottr-edit layout"
    );
    assert_eq!(
        std::fs::read_to_string(&temp).expect("read temp"),
        "v1\n",
        "downloaded copy must match remote content"
    );
    assert!(
        edits.lock().unwrap().get(&sid).is_some_and(|m| m.contains_key(&remote)),
        "edit session must be registered"
    );

    // --- 2. 模拟编辑（本地改临时副本，等价于用户在编辑器里保存）------------
    std::fs::write(&temp, b"v2 edited by user\n").expect("simulate edit");

    // --- 3. 轮询：首轮防抖，次轮自动回传 ------------------------------------
    let p1 = edit_poll(&edits, &client, &sid, &remote).await.expect("poll 1");
    assert_eq!(p1, EditPollStatus::QUIET, "first observation must debounce");
    let p2 = edit_poll(&edits, &client, &sid, &remote).await.expect("poll 2");
    assert_eq!(p2, EditPollStatus::SAVED, "stable change must auto-save");

    // --- 4. 远端内容对上（独立 sha256 取证 + 字节比对）-----------------------
    assert_eq!(
        sha256_local(temp.to_str().unwrap()),
        sha256_remote(&session, &remote).await,
        "remote sha256 must equal edited local copy after auto-save"
    );
    assert_eq!(
        client.open_remote_text(&remote).await.expect("read back"),
        b"v2 edited by user\n"
    );

    // --- 5. 第三方改写远端 → 冲突侦出（不回传）-------------------------------
    exec(&session, &format!("printf 'third-party line\\n' >> {remote}")).await;
    std::fs::write(&temp, b"v3 local only\n").expect("second local edit");
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote).await.expect("poll 3"),
        EditPollStatus::QUIET,
        "debounce again"
    );
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote).await.expect("poll 4"),
        EditPollStatus::CONFLICT,
        "third-party remote change must be detected as conflict"
    );
    assert!(
        String::from_utf8_lossy(&client.open_remote_text(&remote).await.expect("read")).contains("third-party line"),
        "conflict must NOT silently overwrite the remote"
    );

    // --- 6. 「保留本地」裁定：不再重弹，远端不动 ------------------------------
    edit_dismiss(&edits, &sid, &remote).expect("dismiss");
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote).await.expect("poll 5"),
        EditPollStatus::QUIET,
        "dismissed conflict must not re-fire while local is unchanged"
    );
    assert!(
        String::from_utf8_lossy(&client.open_remote_text(&remote).await.expect("read")).contains("third-party line"),
        "dismiss must not touch the remote"
    );

    // --- 7. 「覆盖」裁定：强制回传成功，sha256 对上 ---------------------------
    assert_eq!(
        edit_save(&edits, &client, &sid, &remote, true).await.expect("force save"),
        EditPollStatus::SAVED,
    );
    assert_eq!(
        sha256_local(temp.to_str().unwrap()),
        sha256_remote(&session, &remote).await,
        "remote must equal local copy after forced overwrite"
    );
    assert_eq!(
        client.open_remote_text(&remote).await.expect("read back"),
        b"v3 local only\n"
    );

    // --- 8. 覆盖后快照已更新为写后 stat：再编辑自动回传不再误报冲突 ----------
    std::fs::write(&temp, b"v4 after overwrite\n").expect("third local edit");
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote).await.expect("poll 6"),
        EditPollStatus::QUIET,
    );
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote).await.expect("poll 7"),
        EditPollStatus::SAVED,
        "post-overwrite snapshot must be fresh: no false conflict"
    );
    assert_eq!(
        client.open_remote_text(&remote).await.expect("read back"),
        b"v4 after overwrite\n"
    );

    // --- 9. 显式关闭：临时副本 + 表项 + 目录链零残留 --------------------------
    assert!(edit_close(&edits, &sid, &remote), "close must remove the session entry");
    assert!(!temp.exists(), "temp copy must be removed on close");
    assert!(
        !temp_root().join(&sid).exists(),
        "emptied session temp dir must be removed (no residue)"
    );
    assert!(
        !edits.lock().unwrap().get(&sid).is_some_and(|m| !m.is_empty()),
        "edit table entry must be gone"
    );

    // --- 10. 会话消失的轮询：幂等 gone（前端停轮询信号）-----------------------
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote).await.expect("poll 8"),
        EditPollStatus::GONE,
    );

    // 清理远端
    let _ = exec(&session, &format!("rm -f {remote}")).await;
    let _ = session.disconnect().await;
}
