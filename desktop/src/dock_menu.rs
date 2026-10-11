//! macOS Dock 右键菜单（2026-10-10 用户报告「Dock 右键没反应」——根因 =
//! Tauri 2 无官方 Dock 菜单 API（2.12 仅 set_dock_visibility），全仓从未实现）。
//!
//! 原理：tao 的 NSApplication delegate 类未实现 `applicationDockMenu:`，
//! 用 libobjc `class_addMethod` 向该类运行时补挂本方法；Dock 右键时返回
//! 缓存的 NSMenu（与托盘同源的菜单树，见 [`crate::menu::dock_tree`]）。
//! 菜单项统一 action = `fire:`，从 representedObject 读动作 id，交
//! install() 传入的处理器分派（与托盘 on_menu_event 同一匹配表）。
//!
//! 线程：install 在 Tauri setup（主线程）；rebuild 经 run_on_main_thread
//! 派发（rebuild_menus 可能来自 vault-init 线程）。

use std::cell::RefCell;
use std::sync::{Arc, OnceLock};

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject, Sel};
use objc2::{ClassType, MainThreadMarker, MainThreadOnly, msg_send, sel};
use objc2_app_kit::{NSApplication, NSEvent, NSMenu, NSMenuItem};
use objc2_foundation::NSString;
use tauri::{AppHandle, Wry};

use crate::menu::MenuNode;

/// 菜单动作处理器（menu.rs 构建：与托盘 on_menu_event 同一匹配表）。
pub type DockAction = Arc<dyn Fn(&str) + Send + Sync>;

static HANDLER: OnceLock<DockAction> = OnceLock::new();
// NSMenu 非 Send/Sync：只在主线程访问（fire 与 rebuild 都派发在主线程）。
thread_local! {
    static MENU: RefCell<Option<Retained<NSMenu>>> = const { RefCell::new(None) };
}
static TARGET: OnceLock<Retained<DockTarget>> = OnceLock::new();

objc2::define_class!(
    #[unsafe(super(NSObject))]
    struct DockTarget;

    impl DockTarget {
        // 菜单项统一动作：representedObject = 动作 id 字符串。
        #[unsafe(method(fire:))]
        unsafe fn fire(&self, sender: &NSMenuItem) {
            let Some(obj) = sender.representedObject() else {
                return;
            };
            let Ok(id) = obj.downcast::<NSString>() else {
                return;
            };
            if let Some(handler) = HANDLER.get() {
                handler(id.to_string().as_str());
            }
        }
    }
);

// 无状态目标（fire 只读全局静态），跨线程共享安全。
unsafe impl Send for DockTarget {}
unsafe impl Sync for DockTarget {}

/// Message 类型 → 基类不透明引用（objc2 无自动强转，手写零成本转换）。
fn as_any<T: objc2::Message>(obj: &T) -> &AnyObject {
    unsafe { &*(obj as *const T as *const AnyObject) }
}

/// 托盘右键原生弹窗（2026-10-11）：muda 0.20 收到右键事件后的
/// setMenu+performClick 弹出路径在本机 macOS 27 上静默失效（事件到达、
/// 菜单不弹）——绕开它，直接用同一菜单树构建 NSMenu 并在事件坐标处弹出。
/// 无位置参数：弹出时读 NSEvent::mouseLocation（全局点坐标、左下原点）。
/// 用户右键瞬间光标必然在图标上——不依赖事件坐标（状态栏图标可能被
/// Ice 类工具重排、或折叠进 «，事件坐标与视觉位置不可信）。
pub fn popup_tray_menu(handle: &AppHandle<Wry>, tree: Vec<MenuNode>, handler: DockAction) {
    let _ = HANDLER.set(handler);
    let _ = handle.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let _target: Retained<DockTarget> = unsafe { msg_send![DockTarget::class(), new] };
        let menu = build(&tree, mtm);
        // mouseLocation = 全局点坐标（左下原点），与 popup 坐标系一致，零换算。
        let mouse = NSEvent::mouseLocation();
        menu.popUpMenuPositioningItem_atLocation_inView(None, mouse, None);
    });
}

/// 构建 NSMenu（主线程）。
fn build(tree: &[MenuNode], mtm: MainThreadMarker) -> Retained<NSMenu> {
    let menu = NSMenu::new(mtm);
    let target: &DockTarget = TARGET
        .get()
        .expect("[dock] install() must run before build()")
        .as_ref();
    for node in tree {
        match node {
            MenuNode::Item { id, label, .. } | MenuNode::Check { id, label } => {
                let id_s = NSString::from_str(id);
                let label_s = NSString::from_str(label);
                let item: Retained<NSMenuItem> = unsafe {
                    NSMenuItem::initWithTitle_action_keyEquivalent(
                        NSMenuItem::alloc(mtm),
                        &label_s,
                        Some(sel!(fire:)),
                        &NSString::from_str(""),
                    )
                };
                unsafe {
                    item.setTarget(Some(as_any(target)));
                    item.setRepresentedObject(Some(as_any(&*id_s)));
                }
                menu.addItem(&item);
            }
            MenuNode::Sep => {
                let sep = NSMenuItem::separatorItem(mtm);
                menu.addItem(&sep);
            }
            // dock_tree 不含子菜单/系统预置项（Dock 菜单保持扁平轻量）
            MenuNode::Predef(_) | MenuNode::Sub { .. } => {}
        }
    }
    menu
}

/// `applicationDockMenu:` 实现：返回缓存菜单（autorelease 归还 Dock）。
unsafe extern "C" fn dock_menu_imp(_this: &AnyObject, _cmd: Sel) -> *mut NSMenu {
    eprintln!("[dock] Dock queried applicationDockMenu");
    MENU.with_borrow(|m| match m.as_ref() {
        Some(menu) => Retained::autorelease_return(menu.clone()),
        None => std::ptr::null_mut(),
    })
}

unsafe extern "C" {
    // SEL 按值传递（objc2::Sel = repr(transparent) 指针包装，C ABI 即指针本身）。
    // 曾写成 *const Sel——传入的是「指向 SEL 的指针的值」，libobjc 把该地址
    // 当 selector 注册成垃圾条目：addMethod 返回 true 但永远查询不到。
    fn class_addMethod(
        cls: *mut AnyClass,
        name: Sel,
        imp: *const core::ffi::c_void,
        types: *const core::ffi::c_char,
    ) -> bool;
}

/// setup（主线程）调用：缓存处理器与目标对象，构建菜单，向 delegate 类补挂
/// `applicationDockMenu:`。tao 未实现该方法，class_addMethod 必成功；
/// 若未来 tao 实现了（返回 false），本模块静默退让不覆盖。
pub fn install(tree: Vec<MenuNode>, handler: DockAction) {
    let _ = HANDLER.set(handler);
    let Some(mtm) = MainThreadMarker::new() else {
        eprintln!("[dock] install must run on main thread");
        return;
    };
    let target: Retained<DockTarget> = unsafe { msg_send![DockTarget::class(), new] };
    let _ = TARGET.set(target);
    MENU.with_borrow_mut(|m| *m = Some(build(&tree, mtm)));

    let ns_app = NSApplication::sharedApplication(mtm);
    let delegate: *mut AnyObject = unsafe { msg_send![&ns_app, delegate] };
    if delegate.is_null() {
        eprintln!("[dock] NSApp delegate missing");
        return;
    }
    let cls: *mut AnyClass = unsafe { msg_send![delegate, class] };
    // SAFETY: cls 由运行时返回的非空 Class 指针
    let cls_ref: &AnyClass = unsafe { &*cls };
    eprintln!(
        "[dock] delegate class = {}",
        cls_ref.name().to_string_lossy()
    );
    let application_dock_menu = sel!(applicationDockMenu:);
    let ok = unsafe {
        class_addMethod(
            cls,
            application_dock_menu,
            dock_menu_imp as *const core::ffi::c_void,
            c"@@:@".as_ptr(),
        )
    };
    eprintln!("[dock] applicationDockMenu installed: {ok}");
    // delegate 类名（一次性可观测性：确认补挂在 tao 的 delegate 类上）
    let cls_ref: &AnyClass = unsafe { &*cls };
    eprintln!(
        "[dock] delegate class = {}",
        cls_ref.name().to_string_lossy()
    );
}

/// 菜单树重建（语言切换/ vault 就绪纠偏）。可在任意线程调用，内部派发主线程。
pub fn rebuild(handle: &AppHandle<Wry>, tree: Vec<MenuNode>) {
    if HANDLER.get().is_none() {
        return; // 未 install（非 macOS 路径不会走到）
    }
    let _ = handle.run_on_main_thread(move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        MENU.with_borrow_mut(|m| *m = Some(build(&tree, mtm)));
    });
}
