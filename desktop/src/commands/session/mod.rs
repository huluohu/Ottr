//! 会话命令域（Task 0 拆分纯搬家；本次结构收敛再拆子模块——仍是纯代码搬移，
//! 零逻辑改动，`git diff -w` 可逐段核对）：
//! * [`attach`] —— attach（scripts 直传面 / vault host 面 + 跳板链）+ 会话
//!   生命周期命令（drop / quit / disconnect_all）；
//! * [`hostkey`] —— 主机指纹 pin（夹具）+ TOFU 状态机与前端问询裁定；
//! * [`register`] —— 连接注册生命周期骨架（open_and_register / register_opened
//!   / open_shell_channel / 收尾断开）；
//! * [`relay`] —— write / stats / tail / resize + 合批转发循环
//!   （forward_pty_loop / flush_batch）；
//! * [`shell_integration`] —— shell 集成自动注入。
//!   共享状态经 `crate::commands::state`；vault 门卫/密钥解析复用 crate::vault、
//!   crate::keys、crate::security（零逻辑改动）。

mod attach;
mod hostkey;
mod register;
mod relay;
mod shell_integration;

pub(crate) use attach::{
    attach_host_session, attach_session, disconnect_all_inner, drop_session, quit_app,
    session_disconnect_all,
};
pub(crate) use hostkey::{host_key_decision, tofu_host_key_policy};
pub use relay::{SessionCloseReason, forward_pty_loop};
pub(crate) use relay::{resize_session, session_stats, session_tail, write_session};
pub use shell_integration::{ShellIntegrationOutcome, inject_shell_integration};

// Tauri 命令宏（#[tauri::command] 生成的隐藏 __cmd__ 项）定义在各子模块，
// generate_handler 按 `commands::session::<name>` 前缀解析时需一并再导出。
pub(crate) use attach::__cmd__attach_host_session;
pub(crate) use attach::__cmd__attach_session;
pub(crate) use attach::__cmd__drop_session;
pub(crate) use attach::__cmd__quit_app;
pub(crate) use attach::__cmd__session_disconnect_all;
pub(crate) use attach::__tauri_command_name_attach_host_session;
pub(crate) use attach::__tauri_command_name_attach_session;
pub(crate) use attach::__tauri_command_name_drop_session;
pub(crate) use attach::__tauri_command_name_quit_app;
pub(crate) use attach::__tauri_command_name_session_disconnect_all;
pub(crate) use hostkey::__cmd__host_key_decision;
pub(crate) use hostkey::__tauri_command_name_host_key_decision;
pub(crate) use relay::__cmd__resize_session;
pub(crate) use relay::__cmd__session_stats;
pub(crate) use relay::__cmd__session_tail;
pub(crate) use relay::__cmd__write_session;
pub(crate) use relay::__tauri_command_name_resize_session;
pub(crate) use relay::__tauri_command_name_session_stats;
pub(crate) use relay::__tauri_command_name_session_tail;
pub(crate) use relay::__tauri_command_name_write_session;
