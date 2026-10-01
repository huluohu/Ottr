//! 迁移导入器（Phase 2 Task 10，B3）：Xshell 会话目录 / Tabby 配置 →
//! ssh_config 同构 ParseOutcome → 统一 ImportReport（去重落库复用
//! ssh_config::import_entries，前端导入对话框第三/四入口零特判）。
pub mod tabby;
pub mod xshell;
