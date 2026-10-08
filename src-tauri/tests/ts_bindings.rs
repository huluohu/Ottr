//! TS 类型绑定生成（tauri-specta 试点，2026-10-08 遗留项①）：
//! vault 域四组命令（hosts / known_hosts / credentials / snippets，24 条）的
//! 签名与类型自动导出为 `src/vault/bindings.generated.ts`，并以「重生成一致性」
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
        ]);

    let committed =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/vault/bindings.generated.ts");

    let regenerated = {
        let tmp = std::env::temp_dir().join("ottr-bindings-regenerated.ts");
        builder
            .export(specta_typescript::Typescript::default(), &tmp)
            .expect("export bindings to temp");
        std::fs::read_to_string(&tmp).expect("read regenerated bindings")
    };

    let on_disk = match std::fs::read_to_string(&committed) {
        Ok(s) => s,
        Err(_) => {
            // 首次生成：产物落库（此后一致性断言接管）。
            std::fs::write(&committed, &regenerated).expect("write initial bindings");
            panic!(
                "bindings.generated.ts 首次生成完成——请把它随本改动一起提交（src/vault/bindings.generated.ts）"
            );
        }
    };

    assert_eq!(
        regenerated, on_disk,
        "Rust 侧签名/类型漂移：重新生成 bindings.generated.ts 并随改动一起 review 提交\n\
         （删除 src/vault/bindings.generated.ts 后重跑本测试即可重新落库）"
    );
}
