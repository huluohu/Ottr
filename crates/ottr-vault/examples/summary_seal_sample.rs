//! T12 Phase 2 验收·安全维：summary_enc 落盘密文抽检样本生成。
//!
//! 与 seal_sample.rs 同纪律：生产同款 seal 路径写真实 SQLite——先建主机行，
//! 再灌 3 条 history（会话命令序列），最后经 `SessionSummaries::insert`
//! （AES-256-GCM，AAD=`session_summaries:{id}:summary`，登记 scan_registry）
//! 密封一条含敏感标记串的纪要。验收脚本随后 sqlite3/strings 直查该文件：
//! 纪要明文必须零命中、summary_enc BLOB 必须存在且长度符合
//! 明文+12B nonce+16B tag。
//!
//! 运行：`cargo run -p ottr-vault --example summary_seal_sample`
//! 样本文件 /tmp/ottr-t12/summary-seal/vault.db。

use ottr_vault::Vault;
use ottr_vault::entities::{HostInput, Hosts};
use ottr_vault::history::{History, HistoryInput};
use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::summaries::{SessionSummaries, SummaryInput};

const SUMMARY_SAMPLE: &str =
    "T12-sample: 用户在 prod-db-01 上执行了 rm -rf /tmp/scratch 且密码=hunter2 被纪要复述";

fn main() {
    let dir = "/tmp/ottr-t12/summary-seal";
    std::fs::create_dir_all(dir).expect("create dir");
    for f in ["vault.db", "vault.db-wal", "vault.db-shm"] {
        std::fs::remove_file(format!("{dir}/{f}")).ok();
    }
    let vault =
        Vault::open_with(std::path::Path::new(dir), &InMemoryStorage::new()).expect("open vault");

    let host = Hosts::create(
        &vault,
        HostInput {
            name: "t12-summary-seal-host".into(),
            group_id: None,
            tags: vec![],
            address: "127.0.0.1".into(),
            port: 2222,
            username: Some("spike".into()),
            protocol: ottr_vault::entities::HostProtocol::Ssh,
            credential_id: None,
            jump_chain_id: None,
            encoding_override: None,
            theme_override: None,
            monitor_enabled: false,
            notes: None,
            is_production: false,
        },
    )
    .expect("create host");

    for i in 1..=3 {
        History::insert(
            &vault,
            &HistoryInput {
                host_id: host.id,
                session_id: Some("t12-seal-sess-3".to_string()),
                command: format!("echo demo-{i}"),
                exit_code: Some(0),
                cwd: Some("/tmp".into()),
            },
        )
        .expect("insert history");
    }

    let entry = SessionSummaries::insert(
        &vault,
        &SummaryInput {
            host_id: host.id,
            session_id: "t12-seal-sess-3".into(),
            summary: SUMMARY_SAMPLE.into(),
            command_count: 3,
        },
    )
    .expect("seal summary");

    println!("host id={} summary id={} sealed", host.id, entry.id);
    println!("sample_summary={SUMMARY_SAMPLE}");
    drop(vault);
    println!("sample_db={dir}/vault.db");
}
