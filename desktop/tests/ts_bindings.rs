//! TS 类型绑定生成（tauri-specta 试点，2026-10-08 遗留项①）：
//! vault 域四组命令（hosts / known_hosts / credentials / snippets，24 条）的
//! 签名与类型自动导出为 `frontend/vault/bindings.generated.ts`，并以「重生成一致性」
//! 断言守护——Rust 侧签名/字段漂移会让重生成结果与提交物 diff，本测试即红
//! （提交更新产物即是一次显式 review）。生产 Builder 链零改动（推广路径见
//! docs/structure-refactor-plan.md §2）。
//!
//! 已知边界（推广时逐域处理，见方案文档）：`Channel<InvokeResponseBody>` 原始
//! 字节面（PTY on_data）不参与生成；顶层参数 camelCase 转换由 Tauri 运行时
//! 完成，生成物按 specta 口径命名，前端消费对拍属推广阶段任务。

use tauri_specta::{Builder, collect_commands};

#[test]
fn vault_domain_bindings_are_up_to_date() {
    // specta 对大型类型图（62 命令 + 实体族）的导出是深递归——测试线程默认
    // 2MB 栈会爆；放到 64MB 栈的专属线程跑（断言与产物 IO 都在其中完成）。
    let result = std::thread::Builder::new()
        .stack_size(64 * 1024 * 1024)
        .spawn(run_bindings_check)
        .expect("spawn bindings thread")
        .join();
    match result {
        Ok(Ok(())) => {}
        Ok(Err(msg)) => panic!("{msg}"),
        Err(_) => panic!("bindings thread panicked"),
    }
}

fn run_bindings_check() -> Result<(), String> {
    let builder = Builder::<tauri::Wry>::new()
        // 主机/凭据 id 是 i64：前端全链按 number 消费（恒 < 2^53），显式按
        // number 导出与现状口径一致（方法名带 dangerously = 大数会截断的告诫）。
        .dangerously_cast_bigints_to_number()
        .commands(collect_commands![
            ottr_lib::vault::hosts_list,
            ottr_lib::vault::hosts_get,
            ottr_lib::vault::hosts_create,
            ottr_lib::vault::hosts_update,
            ottr_lib::vault::hosts_delete,
            ottr_lib::vault::hosts_list_by_group,
            ottr_lib::vault::hosts_search,
            ottr_lib::vault::known_hosts_list,
            ottr_lib::vault::known_hosts_upsert,
            ottr_lib::vault::known_hosts_verify,
            ottr_lib::vault::known_hosts_mark_changed,
            ottr_lib::vault::known_hosts_delete,
            ottr_lib::vault::credentials_list,
            ottr_lib::vault::credentials_get,
            ottr_lib::vault::credentials_create,
            ottr_lib::vault::credentials_update,
            ottr_lib::vault::credentials_delete,
            ottr_lib::vault::credentials_reveal,
            ottr_lib::vault::snippets_list,
            ottr_lib::vault::snippets_get,
            ottr_lib::vault::snippets_search,
            ottr_lib::vault::snippets_create,
            ottr_lib::vault::snippets_update,
            ottr_lib::vault::snippets_delete,
            // —— 2026-10-08 推广第二批：vault 域剩余（58/62 条；安全状态机/重置/
            //    初始化为密码语义面排除；settings/sync 四条 serde_json::Value 命令
            //    因 specta rc 对自引用 Value 内联展开报无限递归而排除，见
            //    docs/structure-refactor-plan.md 边界记录；settings/sync/nc/ar/notify
            //    五组（任何触达 serde_json::Value 的命令，21 条）排除——上游 rc
            //    限制：Value 官方 Type 实现为自引用内联枚举，specta-typescript
            //    0.0.12 拒绝内联循环；治本方案（#[serde(transparent)] Json 包装
            //    + 手写 any primitive Type）列第三批。本批入面 41 条）——
            //    初始化为密码语义面，明确不进生成面）——
            ottr_lib::vault::secret_set,
            ottr_lib::vault::secret_get,
            ottr_lib::vault::secret_delete,
            ottr_lib::vault::secret_contains,
            ottr_lib::vault::history_insert,
            ottr_lib::vault::history_search,
            ottr_lib::vault::history_list_session,
            ottr_lib::vault::summary_insert,
            ottr_lib::vault::summary_list,
            ottr_lib::vault::host_groups_list,
            ottr_lib::vault::host_groups_create,
            ottr_lib::vault::host_groups_update,
            ottr_lib::vault::host_groups_delete,
            ottr_lib::vault::import_ssh_config,
            ottr_lib::vault::import_xshell_sessions,
            ottr_lib::vault::import_tabby_config,
            ottr_lib::vault::export_hosts_csv,
        ]);

    let committed = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../frontend/vault/bindings.generated.ts");

    let regenerated = {
        let tmp = std::env::temp_dir().join("ottr-bindings-regenerated.ts");
        builder
            .export(specta_typescript::Typescript::default(), &tmp)
            .map_err(|e| format!("export bindings to temp: {e}"))?;
        std::fs::read_to_string(&tmp).map_err(|e| format!("read regenerated: {e}"))?
    };

    let on_disk = match std::fs::read_to_string(&committed) {
        Ok(s) => s,
        Err(_) => {
            // 首次生成：产物落库（此后一致性断言接管）。
            std::fs::write(&committed, &regenerated)
                .map_err(|e| format!("write initial bindings: {e}"))?;
            return Err(String::from(
                "bindings.generated.ts 首次生成完成——请把它随本改动一起提交（frontend/vault/bindings.generated.ts）",
            ));
        }
    };

    if regenerated != on_disk {
        return Err(String::from(
            "Rust 侧签名/类型漂移：重新生成 bindings.generated.ts 并随改动一起 review 提交\n\
             （删除 frontend/vault/bindings.generated.ts 后重跑本测试即可重新落库）",
        ));
    }
    Ok(())
}
