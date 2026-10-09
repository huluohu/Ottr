//! sudo 密码自动填充真夹具集成（Phase 3 Task 6，B9 收口）：真 ottr-sshd 容器
//! 真 PTY 跑 `sudo -S true`——
//! ① 断言提示串恰为 `[sudo] password for spike:`（前端 SudoAutofill 检测
//!    正则的真源锚点：夹具 sudo 挪动版本也不至于静默漂移）；
//! ② 填入 spike-pass（= 自动填充将写入 PTY 的同一内容）→ sudo 以退出码 0
//!    结束（`echo MARK-$?` == MARK-0），且全程只出现一次提示（无错密重试）。
//! 即「检测 → 填充 → 命令成功」整链的服务端真相；前端链路单测见
//! frontend/terminal/SudoAutofill.test.ts（喂同一提示串金样）。
//!
//! 夹具不可达 → SKIP（batch_fixture 同纪律）。容器须已 sudo 化
//! （fixtures/sshd/Dockerfile + entrypoint.sh，scripts/spike-sshd.sh 重建）。
//!
//! Run: `cargo test -p ottr --test sudo_fixture`
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ottr_ssh::{AuthMethod, HostKeyPolicy, connect};
use tokio::io::AsyncWriteExt as _;

const HOST: &str = "127.0.0.1";
const PORT: u16 = 2222;
const USER: &str = "spike";
const PASSWORD: &str = "spike-pass";

async fn fixture_up() -> bool {
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::net::TcpStream::connect((HOST, PORT)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

/// fixtures/known_hosts 首条端点行 → pin 策略（batch_fixture 同款）。
fn pinned_host_key_policy() -> HostKeyPolicy {
    use base64::Engine as _;
    let content = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/known_hosts"
    ))
    .expect("read fixtures/known_hosts（先跑 scripts/spike-sshd.sh）");
    let marker = format!("[{HOST}]:{PORT}");
    let base64_key = content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .find(|l| l.split_whitespace().next() == Some(marker.as_str()))
        .expect("known_hosts has entry for fixture endpoint")
        .split_whitespace()
        .nth(2)
        .expect("known_hosts line has base64 column")
        .to_string();
    let blob = base64::engine::general_purpose::STANDARD
        .decode(&base64_key)
        .expect("decode pinned key");
    use sha2::Digest;
    let digest = sha2::Sha256::digest(&blob);
    let expected = format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD
            .encode(digest)
            .trim_end_matches('=')
    );
    Arc::new(move |fingerprint: &str| fingerprint == expected)
}

/// 轮询共享输出缓冲直到含 needle（deadline 到点 panic——硬超时纪律）。
async fn wait_for(buf: &Arc<Mutex<Vec<u8>>>, needle: &str, secs: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timeout waiting for {needle:?}; buffer so far:\n{}",
            String::from_utf8_lossy(&buf.lock().unwrap())
        );
        if String::from_utf8_lossy(&buf.lock().unwrap()).contains(needle) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sudo_prompt_and_autofill_round() {
    if !fixture_up().await {
        println!("SKIP sudo_prompt_and_autofill_round: fixture down —— scripts/spike-sshd.sh");
        return;
    }
    let session = tokio::time::timeout(
        Duration::from_secs(15),
        connect(
            HOST,
            PORT,
            USER,
            AuthMethod::Password(PASSWORD.into()),
            pinned_host_key_policy(),
        ),
    )
    .await
    .expect("connect within 15s")
    .expect("connect fixture");

    // 真 PTY + exec（open_pty 通道直接跑 sudo —— 成败看通道 ExitStatus，无
    // 二段命令；shell 形态下 sudo 退出恢复 termios 会冲掉排队输入，实测踩坑）。
    let mut channel = tokio::time::timeout(Duration::from_secs(10), session.open_pty(80, 24))
        .await
        .expect("open_pty within 10s")
        .expect("open_pty");
    tokio::time::timeout(Duration::from_secs(10), channel.exec(true, "sudo -S true"))
        .await
        .expect("exec within 10s")
        .expect("exec sudo");

    let mut writer = channel.make_writer();
    let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let exit: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    {
        let reader_buf = Arc::clone(&buf);
        let exit_clone = Arc::clone(&exit);
        tokio::spawn(async move {
            while let Some(msg) = channel.wait().await {
                match msg {
                    russh::ChannelMsg::Data { data } => {
                        reader_buf.lock().unwrap().extend_from_slice(&data)
                    }
                    russh::ChannelMsg::ExtendedData { data, .. } => {
                        // sudo 的提示写 stderr——PTY 场景混入同流（前端看到的就是它）
                        reader_buf.lock().unwrap().extend_from_slice(&data);
                    }
                    russh::ChannelMsg::ExitStatus { exit_status } => {
                        *exit_clone.lock().unwrap() = Some(exit_status);
                    }
                    russh::ChannelMsg::Close => break,
                    _ => {}
                }
            }
        });
    }

    // ① sudo 打印提示且逐字匹配（检测正则的真源锚点）。
    wait_for(&buf, "[sudo] password for spike:", 15).await;
    let snapshot =
        |buf: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&buf.lock().unwrap()).into_owned();
    let first_prompt_count = snapshot(&buf).matches("[sudo] password for").count();
    assert_eq!(first_prompt_count, 1, "首次提示恰一次");

    // 真人节奏（前端自动填充同样带这个小延迟，见 SudoAutofill FILL_DELAY_MS）：
    // sudo 打印提示后还要 tcsetattr 关回显——TCSAFLUSH 语义会**丢弃尚未读取的
    // 入缓冲**，过早喂密码恰好被冲掉，sudo 永远等不到那一行（实测踩坑）。
    tokio::time::sleep(Duration::from_millis(300)).await;

    // ② 填充（自动填充将写入 PTY 的同一内容：密码 + 回车）。
    writer
        .write_all(PASSWORD.as_bytes())
        .await
        .expect("write password");
    writer.write_all(b"\n").await.expect("write enter");

    // ③ 成功证据：sudo -S true 退出码 0（正确密码 → 一次提示、无重试）。
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while exit.lock().unwrap().is_none() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timeout waiting for sudo exit; buffer so far:\n{}",
            snapshot(&buf)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert_eq!(
        *exit.lock().unwrap(),
        Some(0),
        "自动填充后 sudo 须以 0 退出"
    );
    let out = snapshot(&buf);
    assert_eq!(
        out.matches("[sudo] password for").count(),
        1,
        "正确密码后不得再出提示（错了会重问）：\n{out}"
    );
    assert!(
        !out.contains("Sorry, try again"),
        "密码被拒（自动填充面失败）：\n{out}"
    );
}
