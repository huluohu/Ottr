//! cron_jobs / cron_runs TDD（Phase 4 Task 1，Phase 3 缺口①——存储侧）：
//! 0016 迁移建表（schema_version 16）、任务 CRUD 回读、schedule/script
//! 非空+长度护栏、FK 悬空拒绝、运行历史插入/倒序/保留窗口裁剪、status
//! 合法集、任务删除级联清历史、未知 id NotFound。
//! 纪律（同 alert_rules_test）：tempfile 临时目录 + InMemoryStorage，绝不
//! 触碰真实用户目录与真钥匙链。明文面（无 *_enc 列，不涉 scan_registry）。
//!
//! 五段式语义（*/N/列表/范围/边界）的 golden 在 ottr-monitor::cron 的
//! crate 内测试（解析器不在本 crate——存储层不是解析器，分工见模块文档）。

use ottr_vault::cron_jobs::{
    CronJobInput, CronJobs, CronRunInput, CronRuns, CRON_RUNS_KEEP, CRON_SCHEDULE_MAX_BYTES,
    CRON_SCRIPT_MAX_BYTES,
};
use ottr_vault::master_key::InMemoryStorage;
use ottr_vault::{HostInput, Hosts, Vault, VaultError};

fn open_vault(dir: &std::path::Path) -> Vault {
    Vault::open_with(dir, &InMemoryStorage::new()).expect("open vault")
}

fn host_input(name: &str) -> HostInput {
    HostInput {
        protocol: Default::default(),
        name: name.into(),
        group_id: None,
        tags: vec![],
        address: "10.0.0.1".into(),
        port: 2222,
        username: Some("spike".into()),
        credential_id: None,
        jump_chain_id: None,
        encoding_override: None,
        theme_override: None,
        monitor_enabled: false,
        is_production: false,
        notes: None,
    }
}

fn input(host_id: i64) -> CronJobInput {
    CronJobInput {
        host_id,
        schedule: "*/5 * * * *".into(),
        script: "echo hi".into(),
        channels: vec![1, 2],
        enabled: true,
    }
}

fn run_input(cron_id: i64, ts: i64) -> CronRunInput {
    CronRunInput {
        cron_id,
        status: "ok".into(),
        exit_code: Some(0),
        output_digest: Some("deadbeef".into()),
        output_path: None,
        duration_ms: 12,
        ts,
    }
}

#[test]
fn migration_0016_bumps_schema_version() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    // ≥16（0016 已应用）；恰等 latest 会随后续迁移（0017 mcp_grants…）漂移。
    assert!(vault.schema_version().unwrap() >= 16);
}

#[test]
fn create_get_list_update_delete_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("fx")).unwrap().id;
    let job = CronJobs::create(&vault, &input(h)).unwrap();
    assert_eq!(job.schedule, "*/5 * * * *");
    assert_eq!(job.channels, vec![1, 2]);
    assert!(job.enabled);
    assert_eq!(job.created_at, job.updated_at);

    // schedule 落库 trim（多余空白不进库）
    let mut i = input(h);
    i.schedule = "  0 12 * * 1  ".into();
    let job2 = CronJobs::create(&vault, &i).unwrap();
    assert_eq!(job2.schedule, "0 12 * * 1");

    let listed = CronJobs::list(&vault).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[0].id, job.id);

    // update 全量替换（enabled 翻转回读）
    let mut upd = input(h);
    upd.schedule = "0 0 * * 0".into();
    upd.enabled = false;
    let updated = CronJobs::update(&vault, job.id, &upd).unwrap();
    assert_eq!(updated.schedule, "0 0 * * 0");
    assert!(!updated.enabled);
    assert!(updated.updated_at >= updated.created_at);

    CronJobs::delete(&vault, job.id).unwrap();
    assert!(matches!(
        CronJobs::delete(&vault, job.id),
        Err(VaultError::NotFound(_))
    ));
    assert_eq!(CronJobs::list(&vault).unwrap().len(), 1);
}

#[test]
fn invalid_inputs_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("fx")).unwrap().id;

    let mut i = input(h);
    i.schedule = "   ".into();
    assert!(matches!(
        CronJobs::create(&vault, &i),
        Err(VaultError::InvalidInput(_))
    ));
    let mut i = input(h);
    i.schedule = "a".repeat(CRON_SCHEDULE_MAX_BYTES + 1);
    assert!(matches!(
        CronJobs::create(&vault, &i),
        Err(VaultError::InvalidInput(_))
    ));
    let mut i = input(h);
    i.script = "  ".into();
    assert!(matches!(
        CronJobs::create(&vault, &i),
        Err(VaultError::InvalidInput(_))
    ));
    let mut i = input(h);
    i.script = "x".repeat(CRON_SCRIPT_MAX_BYTES + 1);
    assert!(matches!(
        CronJobs::create(&vault, &i),
        Err(VaultError::InvalidInput(_))
    ));
    // 不存在的主机 → FK 拒绝
    assert!(CronJobs::create(&vault, &input(999_999)).is_err());
}

#[test]
fn runs_insert_list_prune_and_cascade() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("fx")).unwrap().id;
    let job = CronJobs::create(&vault, &input(h)).unwrap();

    for n in 0..(CRON_RUNS_KEEP + 5) {
        let mut ri = run_input(job.id, 1_000 + n as i64);
        if n % 4 != 0 {
            ri.status = "failed".into();
            ri.exit_code = Some(1);
        }
        ri.output_digest = Some(format!("digest-{n}"));
        CronRuns::insert(&vault, &ri).unwrap();
    }
    let runs = CronRuns::list_for_job(&vault, job.id, 200).unwrap();
    assert_eq!(runs.len() as i64, CRON_RUNS_KEEP, "保留窗口裁剪");
    // ts 降序：最新在前；最老 5 条（1000..1004）被裁
    assert_eq!(runs[0].ts, 1_000 + CRON_RUNS_KEEP as i64 + 4);
    assert_eq!(runs.last().unwrap().ts, 1_005);
    assert!(runs.iter().all(|r| r.ts > 1_004));

    // status 合法集
    let mut bad = run_input(job.id, 1);
    bad.status = "weird".into();
    assert!(matches!(
        CronRuns::insert(&vault, &bad),
        Err(VaultError::InvalidInput(_))
    ));

    // 删任务 → 历史级联清空
    CronJobs::delete(&vault, job.id).unwrap();
    assert!(CronRuns::list_for_job(&vault, job.id, 10)
        .unwrap()
        .is_empty());
}

#[test]
fn list_recent_spans_jobs_desc() {
    let dir = tempfile::tempdir().unwrap();
    let vault = open_vault(dir.path());
    let h = Hosts::create(&vault, host_input("fx")).unwrap().id;
    let a = CronJobs::create(&vault, &input(h)).unwrap();
    let b = CronJobs::create(&vault, &input(h)).unwrap();
    for (jid, ts) in [(a.id, 100), (b.id, 200), (a.id, 300)] {
        CronRuns::insert(&vault, &run_input(jid, ts)).unwrap();
    }
    let recent = CronRuns::list_recent(&vault, 10).unwrap();
    let tss: Vec<i64> = recent.iter().map(|r| r.ts).collect();
    assert_eq!(tss, vec![300, 200, 100], "横切面 ts 降序");
}
