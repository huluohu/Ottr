//! seed_vault（Phase 3 Task 7 验收 · GUI 走查工具）：向指定目录播种一个
//! **password-only 模式**库并写入夹具主机（127.0.0.1:2222 / spike / 密码
//! 凭据 + known_hosts verified + monitor_enabled=1），供 GUI 走查绕开
//! 钥匙链 ACL 弹窗（phase1-acceptance R10 环境残留：重建的二进制 CDHash
//! 变更触发 SecurityAgent 登录密码问询，自动化无法输入）——password 模式
//! open 即锁定、走 LockScreen 输主密码解锁，**全程零钥匙链访问**。
//! 逻辑核在 [`ottr_vault::seed`]（缺陷 35 修复点：known_hosts 预置键必须
//! 与连接期 TOFU 查找键同构，见 seed.rs 模块文档）。
//!
//! 【走查后恢复】调用方自行备份/还原 app 数据目录（本工具只碰给定的
//! vault 目录，不触碰钥匙链与其它文件）。
//!
//! Run: `cargo build --release -p ottr-vault --example seed_vault`
//!      `target/release/examples/seed_vault <vault_dir> [password=ottr-t7]`
use std::path::PathBuf;

fn main() {
    let mut args = std::env::args().skip(1);
    let dir = match args.next() {
        Some(d) => PathBuf::from(d),
        None => {
            eprintln!("usage: seed_vault <vault_dir> [password=ottr-t7]");
            std::process::exit(2);
        }
    };
    let password = args.next().unwrap_or_else(|| "ottr-t7".into());

    let outcome = ottr_vault::seed::seed_walkthrough_vault(&dir, &password).expect("seed vault");
    println!(
        "seeded vault at {} (password mode) credential_id={} host_id={} ([{}]:2222 → {} verified)",
        dir.display(),
        outcome.credential_id,
        outcome.host_id,
        "127.0.0.1",
        ottr_vault::seed::FIXTURE_FINGERPRINT
    );
}
