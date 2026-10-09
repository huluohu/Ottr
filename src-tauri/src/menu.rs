//! A12（Task 14）：三端原生交互 Rust 侧——macOS 原生菜单、三端托盘、关窗到托盘。
//!
//! 结构（spec §13「菜单结构三端一致、呈现方式各异」）：
//!   * 菜单树 = [`menu_tree`]/[`tray_tree`] **纯数据**（无运行时即可单测，钉住
//!     结构/键位/双语标签）；`build_menu` 只是把数据走成 muda 菜单——构建面薄到
//!     不需要运行时测试；
//!   * 键位与前端 `src/shortcuts/registry.ts` 互为镜像（TS 侧 MIRRORED 测试 +
//!     本侧 `menu_tree_accelerators_match_frontend_registry` 双向锁定，改动键位
//!     必须两侧同步）；
//!   * 动作分派 = [`dispatch_of`] 纯分类：前端动作（ActionId 同字面量）经
//!     `ottr://menu-action` 事件转发给前端 handleAction（一处 action 多入口），
//!     退出/缩放/托盘专属动作 Rust 侧就地处理；
//!   * 关窗到托盘：`ui.close_to_tray`（vault settings，明文面；0 = 关，未设置 =
//!     开）。简报裁定三端统一「关窗到托盘 + 托盘退出」，不按 mac 关窗即退惯例。
//!
//! 语言：菜单文案随 vault settings `ui.language`（前端 setLang 后发
//! `ottr://ui-language`，本模块监听重建 app 菜单与托盘菜单）。未设置 → En
//! （与前端系统检测的中立侧一致）。
//!
//! KDE 全局菜单适配（dbusmenu，spec §13 标注「可选」）：Phase 1 跳过，Linux 与
//! Windows 共用自绘标题栏 + 汉堡菜单（前端 TitleBar），原生菜单仅 macOS 构建。

use tauri::menu::{AboutMetadata, CheckMenuItem, MenuBuilder, MenuEvent, MenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Listener, Manager, Runtime, Wry};

use crate::AppState;
use crate::vault::VaultState;

/// 菜单动作事件（载荷 = ActionId 字符串；前端 App.tsx 监听并分派 handleAction）。
pub const MENU_ACTION_EVENT: &str = "ottr://menu-action";
/// 前端语言切换通知（载荷为空，语义 = 「用 vault settings 现值重建菜单」）。
pub const UI_LANG_EVENT: &str = "ottr://ui-language";
/// 托盘 id（重建菜单文案时按 id 取回 TrayIcon）。
pub const TRAY_ID: &str = "ottr-tray";
/// 关窗到托盘开关（vault settings 键；0 = 关）。
pub const CLOSE_TO_TRAY_KEY: &str = "ui.close_to_tray";
/// 前端 `i18n.LANG_SETTING_KEY` 的 Rust 镜像（同键同源）。
const LANG_SETTING_KEY: &str = "ui.language";

/// 托盘图标（2026-10-10 用户裁定：黑长条剪影无识别性 → 改彩色应用徽章
/// 32×32 圆角水獭，三端一致；模板位图 tray.png 保留在 icons/ 备查）。
const TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/32x32.png");

// ---------------------------------------------------------------------------
// 菜单语言
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    Zh,
    En,
}

/// vault settings `ui.language` → 菜单语言。未设置/非法值 → En（中立侧）。
pub fn lang_from_vault(vault: &ottr_vault::Vault) -> Lang {
    match ottr_vault::Settings::get_str(vault, LANG_SETTING_KEY)
        .ok()
        .flatten()
        .as_deref()
    {
        Some("zh-CN") => Lang::Zh,
        _ => Lang::En,
    }
}

/// 当前菜单语言：vault settings 现读。vault 未就绪（Task 16.5：init 已移出
/// setup 主线程，菜单初始构建时 `VaultState` 尚未 manage）按 En 兜底——
/// vault-ready 后 `on_vault_ready` 会按 settings 真值重建纠偏，旧值最多存活到
/// 初始化完成。
fn menu_lang<R: Runtime>(app: &AppHandle<R>) -> Lang {
    app.try_state::<VaultState>()
        .map(|v| lang_from_vault(&v.0))
        .unwrap_or(Lang::En)
}

/// 菜单文案表（zh/en；PredefinedMenuItem 的系统项文案由系统自动本地化，不进表）。
fn text(lang: Lang, key: &str) -> &'static str {
    let zh = lang == Lang::Zh;
    match key {
        "app" => "Ottr",
        "settings" => {
            if zh {
                "设置…"
            } else {
                "Settings…"
            }
        }
        "file" => {
            if zh {
                "文件"
            } else {
                "File"
            }
        }
        "new_group" => {
            if zh {
                "新建分组"
            } else {
                "New Group"
            }
        }
        "new_host" => {
            if zh {
                "新建主机"
            } else {
                "New Host"
            }
        }
        "split_right" => {
            if zh {
                "向右分屏"
            } else {
                "Split Right"
            }
        }
        "split_down" => {
            if zh {
                "向下分屏"
            } else {
                "Split Down"
            }
        }
        "edit" => {
            if zh {
                "编辑"
            } else {
                "Edit"
            }
        }
        "view" => {
            if zh {
                "视图"
            } else {
                "View"
            }
        }
        "zoom_in" => {
            if zh {
                "放大"
            } else {
                "Zoom In"
            }
        }
        "zoom_out" => {
            if zh {
                "缩小"
            } else {
                "Zoom Out"
            }
        }
        "zoom_reset" => {
            if zh {
                "实际大小"
            } else {
                "Actual Size"
            }
        }
        "window" => {
            if zh {
                "窗口"
            } else {
                "Window"
            }
        }
        "help" => {
            if zh {
                "帮助"
            } else {
                "Help"
            }
        }
        "palette" => {
            if zh {
                "命令面板…"
            } else {
                "Command Palette…"
            }
        }
        "help_github" => {
            if zh {
                "项目主页"
            } else {
                "Project Homepage"
            }
        }
        "tray_show" => {
            if zh {
                "显示主窗口"
            } else {
                "Show Main Window"
            }
        }
        "tray_disconnect_all" => {
            if zh {
                "断开全部连接"
            } else {
                "Disconnect All"
            }
        }
        "theme" => {
            if zh {
                "主题"
            } else {
                "Theme"
            }
        }
        "theme_light" => {
            if zh {
                "亮色"
            } else {
                "Light"
            }
        }
        "theme_dark" => {
            if zh {
                "暗色"
            } else {
                "Dark"
            }
        }
        "theme_system" => {
            if zh {
                "跟随系统"
            } else {
                "System"
            }
        }
        "theme_oled" => {
            if zh {
                "曜黑"
            } else {
                "Dark OLED"
            }
        }
        "theme_amethyst" => {
            if zh {
                "幻紫"
            } else {
                "Amethyst"
            }
        }
        "theme_verdant" => {
            if zh {
                "青野"
            } else {
                "Verdant"
            }
        }
        "theme_glass" => {
            if zh {
                "雾镜"
            } else {
                "Frosted Glass"
            }
        }
        "tools" => {
            if zh {
                "工具"
            } else {
                "Tools"
            }
        }
        "tool_notify_center" => {
            if zh {
                "通知中心"
            } else {
                "Notification Center"
            }
        }
        "tool_credentials" => {
            if zh {
                "凭据…"
            } else {
                "Credentials…"
            }
        }
        "tool_alerts" => {
            if zh {
                "告警规则"
            } else {
                "Alert Rules"
            }
        }
        "tool_mcp" => "MCP",
        "tool_ai" => {
            if zh {
                "AI 设置"
            } else {
                "AI Settings"
            }
        }
        "tool_forwards" => {
            if zh {
                "端口转发"
            } else {
                "Port Forwards"
            }
        }
        "tool_jump_chains" => {
            if zh {
                "跳板链"
            } else {
                "Jump Chains"
            }
        }
        "tool_overview" => {
            if zh {
                "多主机总览"
            } else {
                "Overview"
            }
        }
        "tool_batch" => {
            if zh {
                "批量执行"
            } else {
                "Batch Exec"
            }
        }
        "tool_cron" => {
            if zh {
                "定时任务"
            } else {
                "Scheduled Tasks"
            }
        }
        "tool_sync" => {
            if zh {
                "同步"
            } else {
                "Sync"
            }
        }
        "tool_export_csv" => {
            if zh {
                "导出主机 CSV…"
            } else {
                "Export Hosts CSV…"
            }
        }
        "tray_quit" => {
            if zh {
                "退出 Ottr"
            } else {
                "Quit Ottr"
            }
        }
        _ => "",
    }
}

// ---------------------------------------------------------------------------
// 菜单树（纯数据；单测钉住结构与键位）
// ---------------------------------------------------------------------------

/// muda 预定义项（系统行为 + 系统文案；mac 上 AppKit 自动本地化）。
#[allow(dead_code)] // 同 menu_tree：win/linux 构建仅测试消费
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Predef {
    About,
    Services,
    Hide,
    HideOthers,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
    Fullscreen,
    BringAllToFront,
}

#[derive(Clone, Debug)]
pub enum MenuNode {
    /// 带动作的普通项。id = 前端 ActionId 或 Rust 专属动作（view.zoom* / tray.*）。
    Item {
        id: &'static str,
        label: &'static str,
        accelerator: Option<&'static str>,
    },
    /// 勾选项（主题七选）：构建为 CheckMenuItem；勾选状态由 [`ThemeMenuState`]
    /// 持有并经 `menu_set_theme` 命令驱动（前端 mode 单一来源）。
    Check {
        id: &'static str,
        label: &'static str,
    },
    Predef(Predef),
    Sep,
    Sub {
        label: &'static str,
        items: Vec<MenuNode>,
    },
}

/// 主题七态 id（与前端 THEME_IDS 同序同值；快切菜单/设置网格/原生菜单三处共用）。
pub const THEME_IDS: [&str; 7] = [
    "light", "dark", "system", "oled", "amethyst", "verdant", "glass",
];

/// 原生「工具」菜单项 key（与前端 TopbarMenu 工具下拉同源，runToolAction 消费）。
pub const TOOL_KEYS: [&str; 12] = [
    "notify-center",
    "credentials",
    "alerts",
    "mcp",
    "ai",
    "forwards",
    "jump-chains",
    "overview",
    "batch",
    "cron",
    "sync",
    "export-hosts-csv",
];

/// 应用菜单树（HIG：应用/文件/编辑/视图/窗口/帮助）。
/// 带键位的条目与前端 registry 镜像（见模块文档）。
/// allow(dead_code)：win/linux 构建不装原生菜单（自绘标题栏承担），仅测试消费。
#[allow(dead_code)]
pub fn menu_tree(lang: Lang) -> Vec<MenuNode> {
    vec![
        MenuNode::Sub {
            label: text(lang, "app"),
            items: vec![
                MenuNode::Predef(Predef::About),
                MenuNode::Sep,
                MenuNode::Item {
                    id: "settings.open",
                    label: text(lang, "settings"),
                    accelerator: Some("CmdOrCtrl+,"),
                },
                MenuNode::Sep,
                MenuNode::Predef(Predef::Services),
                MenuNode::Predef(Predef::Hide),
                MenuNode::Predef(Predef::HideOthers),
                MenuNode::Sep,
                MenuNode::Predef(Predef::Quit),
            ],
        },
        MenuNode::Sub {
            label: text(lang, "file"),
            items: vec![
                MenuNode::Item {
                    id: "hosts.new",
                    label: text(lang, "new_host"),
                    accelerator: Some("CmdOrCtrl+N"),
                },
                MenuNode::Item {
                    id: "hosts.new_group",
                    label: text(lang, "new_group"),
                    accelerator: None,
                },
                MenuNode::Sep,
                MenuNode::Predef(Predef::CloseWindow),
            ],
        },
        MenuNode::Sub {
            label: text(lang, "edit"),
            // 标准剪辑菜单：mac 文本输入框的复制/粘贴必经（WebView 原生不带的兜底）。
            items: vec![
                MenuNode::Predef(Predef::Undo),
                MenuNode::Predef(Predef::Redo),
                MenuNode::Sep,
                MenuNode::Predef(Predef::Cut),
                MenuNode::Predef(Predef::Copy),
                MenuNode::Predef(Predef::Paste),
                MenuNode::Predef(Predef::SelectAll),
            ],
        },
        MenuNode::Sub {
            label: text(lang, "view"),
            items: vec![
                MenuNode::Item {
                    id: "session.splitRight",
                    label: text(lang, "split_right"),
                    accelerator: Some("CmdOrCtrl+D"),
                },
                MenuNode::Item {
                    id: "session.splitDown",
                    label: text(lang, "split_down"),
                    accelerator: Some("CmdOrCtrl+Shift+D"),
                },
                MenuNode::Sep,
                // 主题七选子菜单（2026-10-08 菜单栏启用批次）：与顶栏快切/
                // 设置网格同源同词；勾选态经 menu_set_theme 跟随前端 mode。
                MenuNode::Sub {
                    label: text(lang, "theme"),
                    items: vec![
                        MenuNode::Check {
                            id: "theme.set.light",
                            label: text(lang, "theme_light"),
                        },
                        MenuNode::Check {
                            id: "theme.set.dark",
                            label: text(lang, "theme_dark"),
                        },
                        MenuNode::Check {
                            id: "theme.set.system",
                            label: text(lang, "theme_system"),
                        },
                        MenuNode::Check {
                            id: "theme.set.oled",
                            label: text(lang, "theme_oled"),
                        },
                        MenuNode::Check {
                            id: "theme.set.amethyst",
                            label: text(lang, "theme_amethyst"),
                        },
                        MenuNode::Check {
                            id: "theme.set.verdant",
                            label: text(lang, "theme_verdant"),
                        },
                        MenuNode::Check {
                            id: "theme.set.glass",
                            label: text(lang, "theme_glass"),
                        },
                    ],
                },
                MenuNode::Sep,
                MenuNode::Item {
                    id: "view.zoom_in",
                    label: text(lang, "zoom_in"),
                    accelerator: Some("CmdOrCtrl+="),
                },
                MenuNode::Item {
                    id: "view.zoom_out",
                    label: text(lang, "zoom_out"),
                    accelerator: Some("CmdOrCtrl+-"),
                },
                MenuNode::Item {
                    id: "view.zoom_reset",
                    label: text(lang, "zoom_reset"),
                    accelerator: Some("CmdOrCtrl+0"),
                },
                MenuNode::Sep,
                MenuNode::Predef(Predef::Fullscreen),
            ],
        },
        // 工具菜单（2026-10-08 菜单栏启用批次）：与顶栏「工具」下拉同源
        // （id = tool.<key>，前端 runToolAction 单一分派）；macOS 惯例位于
        // 视图与窗口之间。
        MenuNode::Sub {
            label: text(lang, "tools"),
            items: vec![
                MenuNode::Item {
                    id: "tool.notify-center",
                    label: text(lang, "tool_notify_center"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.credentials",
                    label: text(lang, "tool_credentials"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.alerts",
                    label: text(lang, "tool_alerts"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.mcp",
                    label: text(lang, "tool_mcp"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.ai",
                    label: text(lang, "tool_ai"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.forwards",
                    label: text(lang, "tool_forwards"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.jump-chains",
                    label: text(lang, "tool_jump_chains"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.overview",
                    label: text(lang, "tool_overview"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.batch",
                    label: text(lang, "tool_batch"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.cron",
                    label: text(lang, "tool_cron"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.sync",
                    label: text(lang, "tool_sync"),
                    accelerator: None,
                },
                MenuNode::Item {
                    id: "tool.export-hosts-csv",
                    label: text(lang, "tool_export_csv"),
                    accelerator: None,
                },
            ],
        },
        MenuNode::Sub {
            label: text(lang, "window"),
            items: vec![
                MenuNode::Predef(Predef::Minimize),
                MenuNode::Predef(Predef::Zoom),
                MenuNode::Sep,
                MenuNode::Predef(Predef::BringAllToFront),
            ],
        },
        MenuNode::Sub {
            label: text(lang, "help"),
            // MVP 无帮助文档：命令面板（命令即文档，搜索即发现）+ GitHub 仓库
            // （浏览器打开，Issue 反馈入口）。
            items: vec![
                MenuNode::Item {
                    id: "palette.toggle",
                    label: text(lang, "palette"),
                    accelerator: Some("CmdOrCtrl+K"),
                },
                MenuNode::Sep,
                MenuNode::Item {
                    id: "help.github",
                    label: text(lang, "help_github"),
                    accelerator: None,
                },
            ],
        },
    ]
}

/// 托盘右键菜单树（三端一致；简报定值：显示主窗 / 断开全部 / 退出）。
pub fn tray_tree(lang: Lang) -> Vec<MenuNode> {
    vec![
        MenuNode::Item {
            id: "tray.show",
            label: text(lang, "tray_show"),
            accelerator: None,
        },
        MenuNode::Sep,
        MenuNode::Item {
            id: "tray.disconnect_all",
            label: text(lang, "tray_disconnect_all"),
            accelerator: None,
        },
        MenuNode::Sep,
        MenuNode::Item {
            id: "tray.quit",
            label: text(lang, "tray_quit"),
            accelerator: None,
        },
    ]
}

/// 菜单动作分类（纯函数，测试钉住「树里每个 Item id 都有分派」）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dispatch {
    /// 转发前端 handleAction（`ottr://menu-action` 载荷 = ActionId 字面量）。
    Frontend,
    /// 真退出（app.exit(0)；绕过关窗到托盘拦截）。
    Quit,
    ZoomIn,
    ZoomOut,
    ZoomReset,
    /// 托盘：显示主窗。
    TrayShow,
    /// 托盘：断开全部会话。
    TrayDisconnectAll,
    /// 帮助：浏览器打开 GitHub 仓库（Issue 反馈入口）。
    OpenGitHub,
}

pub fn dispatch_of(id: &str) -> Option<Dispatch> {
    // 主题七选（theme.set.<id>）与工具菜单（tool.<key>）：转前端统一分派
    // （App.tsx runToolAction / setMode；id 形状由 THEME_IDS/TOOL_KEYS 钉住）。
    if id
        .strip_prefix("theme.set.")
        .is_some_and(|t| THEME_IDS.contains(&t))
        || id
            .strip_prefix("tool.")
            .is_some_and(|k| TOOL_KEYS.contains(&k))
    {
        return Some(Dispatch::Frontend);
    }
    match id {
        "settings.open" | "hosts.new" | "hosts.new_group" | "session.splitRight"
        | "session.splitDown" | "palette.toggle" => Some(Dispatch::Frontend),
        "help.github" => Some(Dispatch::OpenGitHub),
        "app.quit" | "tray.quit" => Some(Dispatch::Quit),
        "view.zoom_in" => Some(Dispatch::ZoomIn),
        "view.zoom_out" => Some(Dispatch::ZoomOut),
        "view.zoom_reset" => Some(Dispatch::ZoomReset),
        "tray.show" => Some(Dispatch::TrayShow),
        "tray.disconnect_all" => Some(Dispatch::TrayDisconnectAll),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 构建（薄：把 MenuNode 走成 muda 菜单；构建需 AppHandle，不做运行时单测）
// ---------------------------------------------------------------------------

#[allow(dead_code)] // 同 menu_tree：win/linux 构建仅测试消费
fn build_menu<R: Runtime>(
    app: &AppHandle<R>,
    tree: &[MenuNode],
) -> tauri::Result<tauri::menu::Menu<R>> {
    let mut mb = MenuBuilder::new(app);
    for node in tree {
        if let MenuNode::Sub { label, items } = node {
            mb = mb.item(&build_submenu(app, label, items)?);
        }
    }
    mb.build()
}

/// 构建菜单并收集全部 Check 项（主题勾选状态管理的注册面）。
/// 同 menu_tree：win/linux 构建不装原生菜单（调用点在 cfg(macos) 块内），
/// Linux 视角 dead_code——allow 不沿调用链传播，被调者须各自标注
/// （v0.1.0 后 clippy 门首跑真绿时实测暴露）。
#[allow(dead_code)]
fn build_menu_with_checks<R: Runtime>(
    app: &AppHandle<R>,
    tree: &[MenuNode],
) -> tauri::Result<(tauri::menu::Menu<R>, Vec<CheckMenuItem<R>>)> {
    let mut checks = Vec::new();
    let mut mb = MenuBuilder::new(app);
    for node in tree {
        if let MenuNode::Sub { label, items } = node {
            mb = mb.item(&build_submenu_collect(app, label, items, &mut checks)?);
        }
    }
    Ok((mb.build()?, checks))
}

/// 通知中心菜单项状态（未读数进文案：「通知中心 (3)」；0/None = 素文案）。
/// 与 [`ThemeMenuState`] 同模式：构建时登记、命令面驱动、重建重放。
#[derive(Default)]
pub struct NotifyMenuState {
    item: std::sync::Mutex<Option<tauri::menu::MenuItem<Wry>>>,
    unread: std::sync::Mutex<Option<u64>>,
}

#[allow(dead_code)] // 同 menu_tree
fn build_submenu<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    items: &[MenuNode],
) -> tauri::Result<tauri::menu::Submenu<R>> {
    build_submenu_collect(app, label, items, &mut Vec::new())
}

/// [`build_submenu`] 的收集版：Check 项构建为 CheckMenuItem 并登记到 `checks`
/// （主题勾选状态注册面）；嵌套 Sub 递归（2026-10-08 主题子菜单起两层以上）。
fn build_submenu_collect<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    items: &[MenuNode],
    checks: &mut Vec<CheckMenuItem<R>>,
) -> tauri::Result<tauri::menu::Submenu<R>> {
    let mut sb = SubmenuBuilder::new(app, label);
    for node in items {
        sb = match node {
            MenuNode::Sep => sb.separator(),
            MenuNode::Predef(p) => add_predef(sb, app, *p)?,
            MenuNode::Item {
                id,
                label,
                accelerator,
            } => sb.item(&MenuItem::with_id(app, *id, *label, true, *accelerator)?),
            MenuNode::Check { id, label } => {
                let item = CheckMenuItem::with_id(app, *id, *label, true, false, None::<&str>)?;
                checks.push(item.clone());
                sb.item(&item)
            }
            MenuNode::Sub { label, items } => {
                sb.item(&build_submenu_collect(app, label, items, checks)?)
            }
        };
    }
    sb.build()
}

#[allow(dead_code)] // 同 menu_tree
fn add_predef<'m, R: Runtime>(
    sb: SubmenuBuilder<'m, R, AppHandle<R>>,
    app: &AppHandle<R>,
    p: Predef,
) -> tauri::Result<SubmenuBuilder<'m, R, AppHandle<R>>> {
    Ok(match p {
        Predef::About => sb.about(Some(AboutMetadata {
            name: Some(
                app.config()
                    .product_name
                    .clone()
                    .unwrap_or_else(|| "Ottr".into()),
            ),
            version: Some(app.package_info().version.to_string()),
            authors: Some(vec!["@huluohu".into()]),
            website: Some(REPO_URL.into()),
            website_label: Some("github.com/huluohu/Ottr".into()),
            credits: Some(format!("By @huluohu\n{REPO_URL}")),
            ..Default::default()
        })),
        Predef::Services => sb.services(),
        Predef::Hide => sb.hide(),
        Predef::HideOthers => sb.hide_others(),
        Predef::Quit => sb.quit(),
        Predef::CloseWindow => sb.close_window(),
        Predef::Undo => sb.undo(),
        Predef::Redo => sb.redo(),
        Predef::Cut => sb.cut(),
        Predef::Copy => sb.copy(),
        Predef::Paste => sb.paste(),
        Predef::SelectAll => sb.select_all(),
        Predef::Minimize => sb.minimize(),
        Predef::Zoom => sb.maximize(),
        Predef::Fullscreen => sb.fullscreen(),
        Predef::BringAllToFront => sb.bring_all_to_front(),
    })
}

// ---------------------------------------------------------------------------
// 分派（app 菜单全局 handler + 托盘专属 handler）
// ---------------------------------------------------------------------------

/// app 菜单全局事件：前端动作转发事件；退出/缩放就地处理。
/// 托盘 id（tray.*）不在此处理（托盘 builder 自带 handler，避免双派）。
fn on_app_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    match dispatch_of(id) {
        Some(Dispatch::Frontend) => {
            if let Err(e) = app.emit(MENU_ACTION_EVENT, id.to_string()) {
                eprintln!("[menu] emit {MENU_ACTION_EVENT} failed: {e}");
            }
        }
        Some(Dispatch::Quit) => app.exit(0),
        Some(Dispatch::ZoomIn) => apply_zoom(app, Some(ZOOM_STEP)),
        Some(Dispatch::ZoomOut) => apply_zoom(app, Some(1.0 / ZOOM_STEP)),
        Some(Dispatch::ZoomReset) => apply_zoom(app, None),
        Some(Dispatch::OpenGitHub) => open_repo_url(),
        _ => {}
    }
}

/// 仓库地址（帮助菜单入口 + 关于面板共用）。
const REPO_URL: &str = "https://github.com/huluohu/Ottr";

/// 浏览器打开仓库页（spawn 即返回，不等浏览器）。
/// macOS `open` / Linux `xdg-open` / Windows `cmd /C start`——三端写法同
/// remote_edit `open_in_editor`。
#[allow(dead_code)] // 同 menu_tree：win/linux 构建不装原生菜单，仅测试消费
fn open_repo_url() {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(REPO_URL);
        c
    };
    #[cfg(target_os = "linux")]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(REPO_URL);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", ""]);
        c.arg(REPO_URL);
        c
    };
    if let Err(e) = cmd.spawn() {
        eprintln!("[menu] open repo url failed: {e}");
    }
}

/// webview 缩放（视图菜单）：delta=None 重置 1.0；步进 ×1.1 / ÷1.1，clamp [0.5,3]。
/// 当前倍率记在 managed [`ZoomState`]（set_zoom 是绝对值语义，无读回）。
#[derive(Default)]
pub struct ZoomState(std::sync::Mutex<f64>);

const ZOOM_STEP: f64 = 1.1;

fn apply_zoom<R: Runtime>(app: &AppHandle<R>, delta: Option<f64>) {
    let state = app.state::<ZoomState>();
    let mut current = state.0.lock().unwrap();
    *current = match delta {
        None => 1.0,
        Some(d) => (*current * d).clamp(0.5, 3.0),
    };
    if let Some(w) = app.get_webview_window("main")
        && let Err(e) = w.set_zoom(*current)
    {
        eprintln!("[menu] set_zoom({}) failed: {e}", *current);
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 托盘左键：主窗显示/隐藏切换（简报定值）。已显示 → 隐藏；否则显示+聚焦。
fn toggle_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main_window(app);
        }
    }
}

// ---------------------------------------------------------------------------
// 主题勾选状态（前端 mode 单一来源 → 原生菜单 checkmark 跟随）
// ---------------------------------------------------------------------------

/// 当前存活的主题 CheckMenuItem（按 id）+ 最近一次同步的主题 id。
/// 菜单重建（语言切换/vault-ready）换新实例后由 [`register_theme_checks`]
/// 重放勾选。win/linux 不装原生菜单，state 恒空（命令幂等 no-op）。
#[derive(Default)]
pub struct ThemeMenuState {
    items: std::sync::Mutex<std::collections::HashMap<String, CheckMenuItem<Wry>>>,
    current: std::sync::Mutex<Option<String>>,
}

/// 构建产物登记（重建时重放勾选，保状态不闪失）。
/// 同 build_menu_with_checks：仅 cfg(macos) 调用点可达。
#[allow(dead_code)]
fn register_theme_checks(app: &AppHandle<Wry>, checks: Vec<CheckMenuItem<Wry>>) {
    let state = app.state::<ThemeMenuState>();
    let remembered = state.current.lock().unwrap().clone();
    let mut items = state.items.lock().unwrap();
    items.clear();
    for item in checks {
        let id = item.id().as_ref().to_string();
        if let Some(theme) = remembered.as_deref()
            && id == format!("theme.set.{theme}")
            && let Err(e) = item.set_checked(true)
        {
            eprintln!("[menu] theme check replay failed: {e}");
        }
        items.insert(id, item);
    }
}

/// 前端主题同步命令：置对应项勾选、清其余（mode 变化即调；幂等）。
/// 未知 id（老版本前端/竞态）静默忽略——菜单勾选只是跟随显示，真源在前端。
#[tauri::command]
pub fn menu_set_theme(theme_id: String, app: AppHandle) -> Result<(), String> {
    let state = app.state::<ThemeMenuState>();
    *state.current.lock().unwrap() = Some(theme_id.clone());
    let items = state.items.lock().unwrap();
    for (id, item) in items.iter() {
        let checked = id == &format!("theme.set.{theme_id}");
        // 值未变时 set_checked 也安全（muda 幂等），不做读回优化（省一次 IPC 往返）。
        if let Err(e) = item.set_checked(checked) {
            return Err(format!("set theme check: {e}"));
        }
    }
    Ok(())
}

/// 构建产物登记通知中心菜单项（按 id 找 tool.notify-center；重建重放未读数）。
/// 同 build_menu_with_checks：仅 cfg(macos) 调用点可达。
#[allow(dead_code)]
fn register_notify_item(app: &AppHandle<Wry>, tree: &[MenuNode]) {
    fn find_label(tree: &[MenuNode], id: &str) -> Option<&'static str> {
        for node in tree {
            match node {
                MenuNode::Item { id: i, label, .. } if *i == id => return Some(label),
                MenuNode::Sub { items, .. } => {
                    if let Some(l) = find_label(items, id) {
                        return Some(l);
                    }
                }
                _ => {}
            }
        }
        None
    }
    let Some(label) = find_label(tree, "tool.notify-center") else {
        return;
    };
    let item =
        tauri::menu::MenuItem::with_id(app, "tool.notify-center", label, true, None::<&str>).ok();
    let state = app.state::<NotifyMenuState>();
    *state.item.lock().unwrap() = item;
    // 重建重放：把记忆的未读数刷进新实例文案。
    let unread = *state.unread.lock().unwrap();
    if let (Some(item), Some(n)) = (state.item.lock().unwrap().as_ref(), unread)
        && let Some(l) = find_label(tree, "tool.notify-center")
    {
        let text = if n > 0 {
            format!("{l} ({n})")
        } else {
            l.to_string()
        };
        if let Err(e) = item.set_text(text) {
            eprintln!("[menu] notify item replay failed: {e}");
        }
    }
}

/// 前端未读数同步命令（useNotifyStore unread 变化即调；幂等）。
/// 文案 = 菜单树词条 + 计数后缀（0 = 素文案）。win/linux 无原生菜单 → no-op。
#[tauri::command]
pub fn menu_set_notify_count(unread: u64, app: AppHandle) -> Result<(), String> {
    let state = app.state::<NotifyMenuState>();
    *state.unread.lock().unwrap() = Some(unread);
    let guard = state.item.lock().unwrap();
    let Some(item) = guard.as_ref() else {
        return Ok(());
    };
    let base = item.text().map_err(|e| e.to_string())?;
    // 素文案 = 剥掉历史计数后缀（"通知中心 (3)" → "通知中心"），再按新值拼。
    let base = base.split(" (").next().unwrap_or(&base).to_string();
    let text = if unread > 0 {
        format!("{base} ({unread})")
    } else {
        base
    };
    item.set_text(text).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// setup（lib.rs run() 调用；mac 菜单 + 三端托盘 + 语言重建监听）
// ---------------------------------------------------------------------------

pub fn setup(app: &AppHandle<Wry>) -> tauri::Result<()> {
    // macOS 原生菜单（HIG）。win/linux：decorations:false 菜单栏不可见，
    // 对应交互由前端自绘标题栏/汉堡菜单承担（src/titlebar/TitleBar.tsx），
    // 故不构建（菜单 accelerator 的 win/linux 键盘面由前端 registry 全局监听兜住）。
    // 语言：Task 16.5 起 vault 就绪前此处拿不到 settings——menu_lang 按 En 兜底，
    // vault-ready 后 on_vault_ready 重建纠偏。
    app.manage(ThemeMenuState::default());
    app.manage(NotifyMenuState::default());
    #[cfg(target_os = "macos")]
    {
        let lang = menu_lang(app);
        let (menu, checks) = build_menu_with_checks(app, &menu_tree(lang))?;
        app.set_menu(menu)?;
        register_theme_checks(app, checks);
        register_notify_item(app, &menu_tree(lang));
    }
    app.manage(ZoomState::default());
    app.on_menu_event(on_app_menu_event);

    // 托盘（三端）：模板图标 + 右键菜单 + 左键切换主窗。
    let lang = menu_lang(app);
    let tray_menu = build_menu(app, &tray_tree(lang))?;
    let icon = tauri::image::Image::from_bytes(TRAY_ICON_BYTES)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(false)
        .tooltip("Ottr")
        .menu(&tray_menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match dispatch_of(event.id().as_ref()) {
            Some(Dispatch::TrayShow) => show_main_window(app),
            Some(Dispatch::TrayDisconnectAll) => {
                let n = crate::disconnect_all_inner(&app.state::<AppState>().sessions);
                eprintln!("[tray] disconnect all: {n} session(s)");
            }
            Some(Dispatch::Quit) => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    // 语言切换 → 重建 app 菜单（mac）与托盘菜单文案（前端 setLang 发事件）。
    let handle = app.clone();
    app.listen(UI_LANG_EVENT, move |_| rebuild_menus(&handle));
    Ok(())
}

/// vault 后台初始化就绪（Task 16.5，lib.rs 的 vault-init 线程调用）：初始菜单/
/// 托盘在 vault 就绪前以 En 兜底构建（menu_lang），这里按 settings 真值重建
/// 纠偏。语言本就是 En 时重建无害（同文案）。
pub fn on_vault_ready(app: &AppHandle<Wry>) {
    rebuild_menus(app);
}

/// 按 vault settings 现值重建 app 菜单（mac）与托盘菜单文案。UI_LANG_EVENT
/// 监听与 [`on_vault_ready`] 共用；vault 未就绪（try_state 落空）按 En 兜底。
fn rebuild_menus(handle: &AppHandle<Wry>) {
    let lang = menu_lang(handle);
    #[cfg(target_os = "macos")]
    match build_menu_with_checks(handle, &menu_tree(lang)) {
        Ok((menu, checks)) => {
            if let Err(e) = handle.set_menu(menu) {
                eprintln!("[menu] rebuild failed: {e}");
            }
            register_theme_checks(handle, checks);
            register_notify_item(handle, &menu_tree(lang));
        }
        Err(e) => eprintln!("[menu] rebuild build failed: {e}"),
    }
    if let Some(tray) = handle.tray_by_id(TRAY_ID) {
        match build_menu(handle, &tray_tree(lang)) {
            Ok(menu) => {
                if let Err(e) = tray.set_menu(Some(menu)) {
                    eprintln!("[tray] set_menu failed: {e}");
                }
            }
            Err(e) => eprintln!("[tray] rebuild build failed: {e}"),
        }
    }
}

// ---------------------------------------------------------------------------
// 关窗到托盘
// ---------------------------------------------------------------------------

/// `ui.close_to_tray`（0 = 关；未设置/其余 = 开）。读取失败按开（关窗到托盘是
/// 默认行为，读配置失败不应把「点 X」变成「丢会话退出」）。
pub fn close_to_tray_enabled(vault: &ottr_vault::Vault) -> bool {
    !matches!(
        ottr_vault::Settings::get_u64(vault, CLOSE_TO_TRAY_KEY),
        Ok(Some(0))
    )
}

/// CloseRequested 拦截：开关开 → prevent_close + 隐藏（会话保活，托盘可回）。
/// vault 未就绪（Task 16.5 启动窗口期）按开兜底——与下方配置读取失败同口径
/// （不把「点 X」变成「丢会话退出」）。
pub fn on_close_requested<R: Runtime>(app: &AppHandle<R>, api: &tauri::CloseRequestApi) {
    let enabled = app
        .try_state::<VaultState>()
        .map(|v| close_to_tray_enabled(&v.0))
        .unwrap_or(true);
    if enabled {
        api.prevent_close();
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    }
}

// ---------------------------------------------------------------------------
// 测试（纯数据面：树结构 / 键位镜像 / 分派全覆盖 / 双语标签 / 托盘开关）
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn item_ids(tree: &[MenuNode]) -> Vec<&'static str> {
        let mut ids = Vec::new();
        for node in tree {
            match node {
                MenuNode::Item { id, .. } | MenuNode::Check { id, .. } => ids.push(*id),
                MenuNode::Sub { items, .. } => ids.extend(item_ids(items)),
                _ => {}
            }
        }
        ids
    }

    #[test]
    fn app_menu_tree_matches_hig_layout() {
        let tree = menu_tree(Lang::En);
        let subs: Vec<&str> = tree
            .iter()
            .filter_map(|n| match n {
                MenuNode::Sub { label, .. } => Some(*label),
                _ => None,
            })
            .collect();
        assert_eq!(
            subs,
            vec!["Ottr", "File", "Edit", "View", "Tools", "Window", "Help"]
        );
    }

    /// 与前端 registry（src/shortcuts/registry.ts MIRRORED 测试）互为镜像：
    /// 改键位必须两侧同步（TS 侧断言 ⌘K/Ctrl+K 展示，本侧钉 accelerator 字面量）。
    #[test]
    fn menu_tree_accelerators_match_frontend_registry() {
        let tree = menu_tree(Lang::En);
        let mut accels: Vec<(&str, &str)> = Vec::new();
        for node in &tree {
            if let MenuNode::Sub { items, .. } = node {
                for n in items {
                    if let MenuNode::Item {
                        id,
                        accelerator: Some(a),
                        ..
                    } = n
                    {
                        accels.push((id, *a));
                    }
                }
            }
        }
        assert_eq!(
            accels,
            vec![
                ("settings.open", "CmdOrCtrl+,"),
                ("hosts.new", "CmdOrCtrl+N"),
                ("session.splitRight", "CmdOrCtrl+D"),
                ("session.splitDown", "CmdOrCtrl+Shift+D"),
                ("view.zoom_in", "CmdOrCtrl+="),
                ("view.zoom_out", "CmdOrCtrl+-"),
                ("view.zoom_reset", "CmdOrCtrl+0"),
                ("palette.toggle", "CmdOrCtrl+K"),
            ]
        );
    }

    #[test]
    fn every_item_id_has_dispatch_and_ids_unique() {
        for (name, tree) in [("app", menu_tree(Lang::En)), ("tray", tray_tree(Lang::Zh))] {
            let ids = item_ids(&tree);
            let mut sorted = ids.clone();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), ids.len(), "{name}: duplicate ids");
            for id in ids {
                assert!(
                    dispatch_of(id).is_some(),
                    "{name}: id {id} 无分派（事件会黑洞）"
                );
            }
        }
    }

    #[test]
    fn predefined_items_cover_edit_and_window() {
        let tree = menu_tree(Lang::En);
        let mut predefs = Vec::new();
        for node in &tree {
            if let MenuNode::Sub { label, items } = node {
                for n in items {
                    if let MenuNode::Predef(p) = n {
                        predefs.push((*label, *p));
                    }
                }
            }
        }
        // 编辑菜单标准剪辑（文本输入必需）+ 窗口菜单最小化/缩放/前置
        assert!(predefs.contains(&("Edit", Predef::Copy)));
        assert!(predefs.contains(&("Edit", Predef::Paste)));
        assert!(predefs.contains(&("Edit", Predef::SelectAll)));
        assert!(predefs.contains(&("Window", Predef::Minimize)));
        assert!(predefs.contains(&("Window", Predef::Zoom)));
        assert!(predefs.contains(&("Ottr", Predef::Quit)));
        assert!(predefs.contains(&("Ottr", Predef::About)));
    }

    #[test]
    fn bilingual_labels_nonempty() {
        for lang in [Lang::Zh, Lang::En] {
            for tree in [menu_tree(lang), tray_tree(lang)] {
                for node in &tree {
                    match node {
                        MenuNode::Sub { label, .. } => assert!(!label.is_empty()),
                        MenuNode::Item { label, .. } | MenuNode::Check { label, .. } => {
                            assert!(!label.is_empty())
                        }
                        _ => {}
                    }
                }
            }
        }
        assert_eq!(text(Lang::Zh, "tray_disconnect_all"), "断开全部连接");
        assert_eq!(text(Lang::En, "tray_disconnect_all"), "Disconnect All");
    }

    /// 主题子菜单（视图下）：七项 = 前端 THEME_IDS 同序（dispatch 前缀测试
    /// 另行覆盖 id 合法性）。2026-10-08 菜单栏启用批次起钉住。
    #[test]
    fn theme_submenu_lists_all_seven_themes() {
        let tree = menu_tree(Lang::En);
        let view = tree
            .iter()
            .find_map(|n| match n {
                MenuNode::Sub {
                    label: "View",
                    items,
                } => Some(items),
                _ => None,
            })
            .expect("View submenu");
        let theme = view
            .iter()
            .find_map(|n| match n {
                MenuNode::Sub {
                    label: "Theme",
                    items,
                } => Some(items),
                _ => None,
            })
            .expect("Theme submenu");
        let ids: Vec<String> = theme
            .iter()
            .map(|n| match n {
                MenuNode::Check { id, .. } => (*id).to_string(),
                _ => panic!("theme submenu only contains checks"),
            })
            .collect();
        let expected: Vec<String> = THEME_IDS.iter().map(|t| format!("theme.set.{t}")).collect();
        assert_eq!(ids, expected);
    }

    /// 工具菜单：11 项 = 前端 TopbarMenu 工具下拉同源（tool.<key>）。
    #[test]
    fn tools_submenu_mirrors_topbar_tools() {
        let tree = menu_tree(Lang::Zh);
        let tools = tree
            .iter()
            .find_map(|n| match n {
                MenuNode::Sub {
                    label: "工具",
                    items,
                } => Some(items),
                _ => None,
            })
            .expect("工具 submenu（zh）");
        let ids: Vec<String> = tools
            .iter()
            .map(|n| match n {
                MenuNode::Item { id, .. } => (*id).to_string(),
                _ => panic!("tools submenu only contains items"),
            })
            .collect();
        let expected: Vec<String> = TOOL_KEYS.iter().map(|k| format!("tool.{k}")).collect();
        assert_eq!(ids, expected);
    }

    #[test]
    fn tray_menu_is_show_disconnect_quit() {
        let ids = item_ids(&tray_tree(Lang::Zh));
        assert_eq!(ids, vec!["tray.show", "tray.disconnect_all", "tray.quit"]);
    }

    #[test]
    fn close_to_tray_defaults_on_and_zero_disables() {
        let dir = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            dir.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .expect("open in-memory vault");
        // 未设置 = 开（默认关窗到托盘）
        assert!(close_to_tray_enabled(&vault));
        ottr_vault::Settings::set_u64(&vault, CLOSE_TO_TRAY_KEY, 0).unwrap();
        assert!(!close_to_tray_enabled(&vault));
        ottr_vault::Settings::set_u64(&vault, CLOSE_TO_TRAY_KEY, 1).unwrap();
        assert!(close_to_tray_enabled(&vault));
    }

    #[test]
    fn menu_lang_follows_vault_setting() {
        let dir = tempfile::tempdir().unwrap();
        let vault = ottr_vault::Vault::open_with(
            dir.path(),
            &ottr_vault::master_key::InMemoryStorage::new(),
        )
        .expect("open in-memory vault");
        assert_eq!(lang_from_vault(&vault), Lang::En, "未设置 → En");
        ottr_vault::Settings::set_str(&vault, LANG_SETTING_KEY, "zh-CN").unwrap();
        assert_eq!(lang_from_vault(&vault), Lang::Zh);
        ottr_vault::Settings::set_str(&vault, LANG_SETTING_KEY, "fr-FR").unwrap();
        assert_eq!(lang_from_vault(&vault), Lang::En, "非法值 → En");
    }
}
