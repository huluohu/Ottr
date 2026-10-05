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
    apply_save_bookkeeping, edit_close, edit_dismiss, edit_open, edit_poll, edit_save, local_stamp,
    temp_path_for, temp_root, EditMap, EditPollStatus,
};
use ottr_ssh::{connect, AuthMethod, SshSession};
use ottr_transfer::ops::RemoteSnapshot;
use ottr_transfer::SftpClient;
use russh::keys::{parse_public_key_base64, HashAlg, PublicKey};
use russh::ChannelMsg;

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
    // Fix round 1 I-2：副本 0600、哈希/会话目录 0700（编辑对象常是敏感文件）
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&temp), 0o600, "temp copy must not be world-readable");
        assert_eq!(mode(temp.parent().unwrap()), 0o700, "hash dir must be 0700");
        assert_eq!(
            mode(temp.parent().unwrap().parent().unwrap()),
            0o700,
            "session dir must be 0700"
        );
    }
    assert!(
        edits
            .lock()
            .unwrap()
            .get(&sid)
            .is_some_and(|m| m.contains_key(&remote)),
        "edit session must be registered"
    );

    // --- 2. 模拟编辑（本地改临时副本，等价于用户在编辑器里保存）------------
    std::fs::write(&temp, b"v2 edited by user\n").expect("simulate edit");

    // --- 3. 轮询：首轮防抖，次轮自动回传 ------------------------------------
    let p1 = edit_poll(&edits, &client, &sid, &remote)
        .await
        .expect("poll 1");
    assert_eq!(p1, EditPollStatus::QUIET, "first observation must debounce");
    let p2 = edit_poll(&edits, &client, &sid, &remote)
        .await
        .expect("poll 2");
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
    exec(
        &session,
        &format!("printf 'third-party line\\n' >> {remote}"),
    )
    .await;
    std::fs::write(&temp, b"v3 local only\n").expect("second local edit");
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 3"),
        EditPollStatus::QUIET,
        "debounce again"
    );
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 4"),
        EditPollStatus::CONFLICT,
        "third-party remote change must be detected as conflict"
    );
    assert!(
        String::from_utf8_lossy(&client.open_remote_text(&remote).await.expect("read"))
            .contains("third-party line"),
        "conflict must NOT silently overwrite the remote"
    );

    // --- 6. 「保留本地」裁定：不再重弹，远端不动 ------------------------------
    edit_dismiss(&edits, &sid, &remote).expect("dismiss");
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 5"),
        EditPollStatus::QUIET,
        "dismissed conflict must not re-fire while local is unchanged"
    );
    assert!(
        String::from_utf8_lossy(&client.open_remote_text(&remote).await.expect("read"))
            .contains("third-party line"),
        "dismiss must not touch the remote"
    );

    // --- 7. 「覆盖」裁定：强制回传成功，sha256 对上 ---------------------------
    assert_eq!(
        edit_save(&edits, &client, &sid, &remote, true)
            .await
            .expect("force save"),
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
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 6"),
        EditPollStatus::QUIET,
    );
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 7"),
        EditPollStatus::SAVED,
        "post-overwrite snapshot must be fresh: no false conflict"
    );
    assert_eq!(
        client.open_remote_text(&remote).await.expect("read back"),
        b"v4 after overwrite\n"
    );

    // --- 9. 显式关闭：临时副本 + 表项 + 目录链零残留 --------------------------
    assert!(
        edit_close(&edits, &sid, &remote),
        "close must remove the session entry"
    );
    assert!(!temp.exists(), "temp copy must be removed on close");
    assert!(
        !temp_root().join(&sid).exists(),
        "emptied session temp dir must be removed (no residue)"
    );
    assert!(
        !edits
            .lock()
            .unwrap()
            .get(&sid)
            .is_some_and(|m| !m.is_empty()),
        "edit table entry must be gone"
    );

    // --- 10. 会话消失的轮询：幂等 gone（前端停轮询信号）-----------------------
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 8"),
        EditPollStatus::GONE,
    );

    // 清理远端
    let _ = exec(&session, &format!("rm -f {remote}")).await;
    let _ = session.disconnect().await;
}

/// Fix round 1 I-1：**await 窗口内二次保存（追尾）→ 最终态最终回传**。
/// do_save 的 read→write_remote_text().await 窗口（VS Code afterDelay=1s 够
/// 得着）里编辑器又存了一版：远端拿到的是读时旧内容。修复前会把「新指纹」
/// 记进 saved_local → 下一轮 poll 判 Unchanged → 最终态静默分叉丢失。这里用
/// 与 do_save 完全相同的原语序列（读前指纹/读/二次保存/写远端）+ 生产同款
/// 记账函数（apply_save_bookkeeping）确定性复刻该交错，断言：记账被拒绝
/// （saved_local 不动、pending 武装）→ 后续 poll 重传 → 远端 == 最终态。
#[tokio::test]
async fn await_window_second_save_eventually_syncs() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");

    let sid = format!("e2e-tail-{}", std::process::id());
    let remote = format!("/tmp/ottr-t3-tail-{}.txt", std::process::id());
    let edits: EditMap = EditMap::default();
    exec(&session, &format!("printf 'v1\\n' > {remote}")).await;

    let temp = edit_open(&edits, &client, &sid, &remote)
        .await
        .expect("edit_open");
    std::fs::write(&temp, b"v2 first save\n").expect("first local edit");
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 1"),
        EditPollStatus::QUIET,
    );
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 2"),
        EditPollStatus::SAVED,
        "v2 must sync normally"
    );
    assert_eq!(
        client.open_remote_text(&remote).await.expect("read"),
        b"v2 first save\n"
    );

    // --- 复刻 do_save 的 read→write await 窗口（同一原语序列 + 生产记账函数）---
    std::fs::write(&temp, b"v3 second save\n").expect("local edit (the read)");
    let stamp_at_read = local_stamp(&temp).expect("stamp before read");
    let payload = std::fs::read(&temp).expect("read temp (do_save 的读)");
    // 【窗口内】编辑器二次保存（await 期间发生的真实场景）
    std::fs::write(&temp, b"v4 final state\n").expect("second save INSIDE await window");
    // do_save 继续：把读到的旧内容写远端
    let after = client
        .write_remote_text(&remote, &payload)
        .await
        .expect("write (old content wins the race)");
    {
        let mut map = edits.lock().unwrap();
        let entry = map
            .get_mut(&sid)
            .and_then(|m| m.get_mut(&remote))
            .expect("entry alive");
        let booked = apply_save_bookkeeping(
            entry,
            stamp_at_read,
            local_stamp(&temp),
            RemoteSnapshot::capture(&after),
        );
        assert!(!booked, "drifted stamp must NOT be booked (I-1)");
        assert_ne!(
            entry.saved_local.mtime_ns,
            local_stamp(&temp).unwrap().mtime_ns,
            "saved_local must stay armed at the pre-drift stamp"
        );
        assert!(
            entry.pending.is_some(),
            "pending must be armed to the drift"
        );
    }
    // 修复前的失败态正是「记账了新指纹」→ poll Unchanged → v4 永不回传。
    // 修复后：pending 已武装到当前指纹 → 下一轮 poll 即 Ready 重传最终态。
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 3"),
        EditPollStatus::SAVED,
        "armed pending re-transfers the final state on the next poll"
    );
    assert_eq!(
        client.open_remote_text(&remote).await.expect("read"),
        b"v4 final state\n",
        "remote must converge to the LAST local state (no silent fork)"
    );

    assert!(edit_close(&edits, &sid, &remote));
    let _ = exec(&session, &format!("rm -f {remote}")).await;
    let _ = session.disconnect().await;
}

/// Fix round 1 M-2：远端被第三方删除 → poll 返回一次性 `remote_gone`（不是
/// 静默 Err 死循环）、编辑会话自清（表项 + 临时副本零残留）。
#[tokio::test]
async fn remote_deleted_reports_remote_gone_and_cleans() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");

    let sid = format!("e2e-rmgone-{}", std::process::id());
    let remote = format!("/tmp/ottr-t3-rmgone-{}.txt", std::process::id());
    let edits: EditMap = EditMap::default();
    exec(&session, &format!("printf 'v1\\n' > {remote}")).await;

    let temp = edit_open(&edits, &client, &sid, &remote)
        .await
        .expect("edit_open");
    // 第三方删除远端文件 + 本地有未回传修改
    exec(&session, &format!("rm -f {remote}")).await;
    std::fs::write(&temp, b"local edit, remote deleted\n").expect("local edit");

    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 1"),
        EditPollStatus::QUIET,
        "debounce first"
    );
    assert_eq!(
        edit_poll(&edits, &client, &sid, &remote)
            .await
            .expect("poll 2"),
        EditPollStatus::REMOTE_GONE,
        "deleted remote must surface as one-shot remote_gone, not a silent error loop"
    );
    assert!(
        !edits.lock().unwrap().contains_key(&sid),
        "session entry must self-clean"
    );
    assert!(!temp.exists(), "temp copy must be cleaned");
    assert!(!temp_root().join(&sid).exists(), "no residue");

    let _ = session.disconnect().await;
}

/// Fix round 1 M-1：超过 10MB 上限的文件拒绝编辑（显式错误，不进轮询）。
#[tokio::test]
async fn oversize_edit_is_rejected() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");

    let sid = format!("e2e-big-{}", std::process::id());
    let remote = format!("/tmp/ottr-t3-big-{}.bin", std::process::id());
    let edits: EditMap = EditMap::default();
    // 11MB > 10MB 上限
    exec(
        &session,
        &format!("dd if=/dev/zero of={remote} bs=1048576 count=11 2>/dev/null"),
    )
    .await;

    let err = edit_open(&edits, &client, &sid, &remote)
        .await
        .err()
        .expect("oversize must be rejected");
    assert!(
        err.contains("too large"),
        "error must name the size limit, got: {err}"
    );
    assert!(
        !edits
            .lock()
            .unwrap()
            .get(&sid)
            .is_some_and(|m| !m.is_empty()),
        "no edit session may be registered for an oversize file"
    );
    assert!(
        !temp_path_for(&sid, &remote).exists(),
        "no temp copy may be created for an oversize file"
    );

    let _ = exec(&session, &format!("rm -f {remote}")).await;
    let _ = session.disconnect().await;
}

/// BL-506 二进制嗅探（TDD 红）：远端含 NUL 字节的文件 → edit_open 以
/// `binary_file` 稳定令牌拒绝（TS FilePanel 按令牌映射专用提示），不落临时
/// 副本、不登记会话；纯文本对照面照常打开（同会话 id，互不影响）。
#[tokio::test]
async fn edit_open_rejects_binary_remote_file() {
    fixture_or_panic().await;
    let session = connect_fixture().await;
    let client = SftpClient::open(&session).await.expect("sftp open");

    let sid = format!("e2e-bin-{}", std::process::id());
    let remote = format!("/tmp/ottr-t3-bin-{}.bin", std::process::id());
    let edits: EditMap = EditMap::default();

    // 真二进制（含 NUL）远端文件——独立通道建立（ground truth 不经被测代码）
    exec(&session, &format!("printf 'bin\\x0001' > {remote}")).await;

    let err = edit_open(&edits, &client, &sid, &remote)
        .await
        .err()
        .expect("binary remote must be rejected");
    assert!(
        err.starts_with("binary_file"),
        "stable token for TS mapping, got: {err}"
    );
    assert!(
        !edits
            .lock()
            .unwrap()
            .get(&sid)
            .is_some_and(|m| m.contains_key(&remote)),
        "no edit session may be registered for a binary file"
    );
    assert!(
        !temp_path_for(&sid, &remote).exists(),
        "no temp copy may be left behind for a binary file"
    );

    // 对照：纯文本照常打开（探针不误伤文本）
    let text_remote = format!("/tmp/ottr-t3-bin-{}.txt", std::process::id());
    exec(&session, &format!("printf 'plain\\n' > {text_remote}")).await;
    let temp = edit_open(&edits, &client, &sid, &text_remote)
        .await
        .expect("text file opens normally");
    assert_eq!(
        std::fs::read(&temp).expect("read temp"),
        b"plain\n",
        "text download unaffected by the probe"
    );
    assert!(edit_close(&edits, &sid, &text_remote));

    let _ = exec(&session, &format!("rm -f {remote} {text_remote}")).await;
    let _ = session.disconnect().await;
}
