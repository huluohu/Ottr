//! HTTP 插件 scope 匹配语义的**回归守卫**（2026-11-02 真机验证发现的生产缺陷）。
//!
//! **缺陷根因**：capability 里写的是 `http://**` / `https://**`。在
//! URLPattern 语义下，构造串**未指定端口**时，该模式等价于「该协议的默认
//! 端口」（http=80 / https=443）——因此**任何带显式端口的 URL 都不被放行**。
//!
//! **真实影响（真机 192.168.9.102 实测复现）**：
//!   * `http://127.0.0.1:8899/v1/chat/completions` → `url not allowed on the
//!     configured scope`（真机 ⌘J AI 生成直接报错）；
//!   * 应用**内置的 Ollama 本地端点预设** `http://localhost:11434/v1` → 同样
//!     不被放行 → 该预设**在真机上完全不可用**（用户按界面指引配好也连不上）；
//!   * 任何自托管 AI 端点（LiteLLM / vLLM / one-api 等非 80/443 端口）→ 同样
//!     不可用；
//!   * 只有恰好走默认端口的公网 HTTPS 端点（DeepSeek/OpenAI/智谱都是 443）
//!     能用——所以问题长期未被发现。
//!
//! **修法（第一批）**：scope 改用 `http://*:*/*` / `https://*:*/*`（显式放行
//! 任意端口）。
//!
//! **收窄（第二批，2026-11-02 安全审计）**：`http://*:*/*` 放行了**任意主机
//! 的明文 http**——插件侧请求由 Rust 发出、**不受 CORS 约束**，webview 内任意
//! 脚本都能读任意 http 地址（内网管理口、云厂商元数据 169.254.169.254、
//! 本机 6379…）。且非本机明文 http 会把 API key 裸传在链路上。
//!
//! 现口径：
//!   * `https://*:*/*` —— 任意 https 主机（BYOK 端点本就由用户自配）；
//!   * `http://localhost:*/*` / `http://127.0.0.1:*/*` / `http://[::1]:*/*`
//!     —— 明文 http 只放行**本机**（Ollama / LM Studio 等本地端点预设）；
//!   * deny：`169.254.169.254`（云厂商元数据）——deny 优先于 allow。
//!
//! 非本机端点必须用 https（设置页保存时校验并给文案）。
//! 本文件用**与插件同版本**的 `urlpattern` crate 把匹配语义钉死，防回归。
//!
//! 用法：cargo test --test http_scope_probe

use urlpattern::UrlPattern;
use urlpattern::UrlPatternMatchInput;

/// 插件 scope 的解析口径（tauri-plugin-http 2.8.0 `scope.rs::parse_url_pattern`）：
/// 空 pathname / search / hash 一律补 `*`。
fn plugin_scope_pattern(constructor: &str) -> UrlPattern {
    let mut init =
        urlpattern::UrlPatternInit::parse_constructor_string::<regex::Regex>(constructor, None)
            .expect("constructor parse");
    if init.search.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
        init.search.replace("*".to_string());
    }
    if init.hash.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
        init.hash.replace("*".to_string());
    }
    if init
        .pathname
        .as_ref()
        .map(|p| p.is_empty() || p == "/")
        .unwrap_or(true)
    {
        init.pathname.replace("*".to_string());
    }
    UrlPattern::parse(init, Default::default()).expect("pattern parse")
}

fn allowed(constructor: &str, url: &str) -> bool {
    let p = plugin_scope_pattern(constructor);
    p.test(UrlPatternMatchInput::Url(url.parse().expect("url parse")))
        .unwrap_or_default()
}

/// 与 desktop/capabilities/default.json 的 scope 写法保持一致——改 capability
/// 必须同步改这里，否则本守卫测的是另一套模式。
const SCOPE_ALLOW: &[&str] = &[
    "https://*:*/*",
    "http://localhost:*/*",
    "http://127.0.0.1:*/*",
];
/// deny 段：元数据地址 + 常见本地敏感服务端口（纵深防御，见 capability 注释）。
const SCOPE_DENY: &[&str] = &[
    "http://169.254.169.254/*",
    "https://169.254.169.254/*",
    "http://localhost:6379/*",
    "http://127.0.0.1:6379/*",
    "http://localhost:5432/*",
    "http://127.0.0.1:5432/*",
    "http://localhost:2375/*",
    "http://127.0.0.1:2375/*",
];

/// 复刻插件的判定（scope.rs::Scope::is_allowed）：**deny 优先**，再任一 allow 命中。
fn scope_allows(url: &str) -> bool {
    if SCOPE_DENY.iter().any(|c| allowed(c, url)) {
        return false; // deny 优先于 allow（与插件 scope.rs::is_allowed 同口径）
    }
    SCOPE_ALLOW.iter().any(|c| allowed(c, url))
}

/// 必须放行的 AI 端点形态：公网 https（任意端口）+ 本机明文 http。
const MUST_ALLOW: &[&str] = &[
    // 公网默认端口（DeepSeek / OpenAI / 智谱 —— 恰好都是 443，问题长期未暴露）
    "https://api.deepseek.com/chat/completions",
    "https://api.openai.com/v1/chat/completions",
    // 公网显式端口（自建网关 / 反代，走 https）
    "https://api.example.com:8443/v1/chat/completions",
    // 本机（Ollama 预设 = 应用内置项）
    "http://localhost:11434/v1/chat/completions",
    "http://127.0.0.1:11434/v1/chat/completions",
    // 无端口本机 / 带查询串
    "http://localhost/",
    "http://localhost:11434/v1?limit=50",
];

/// 必须**拒绝**的形态：非本机明文 http + 云厂商元数据地址。
///
/// 注：`http://[::1]:*/*`（IPv6 本机）**无法表达**——URLPattern 的 hostname
/// 词法器不吃方括号（实测 `UrlPattern::parse` 报 invalid name）。故 IPv6 本机
/// 地址不在这份 scope 里，本机端点请用 localhost / 127.0.0.1。
const MUST_DENY: &[&str] = &[
    // 非本机明文 http（API key 裸传 + webview 内任意脚本可读）
    "http://example.com:8443/v1/chat/completions",
    "http://192.168.9.102:8080/v1",
    "http://192.168.9.102/v1",
    "http://169.254.169.254/latest/meta-data/",
    // 本机敏感服务端口（纵深防御 deny 段）
    "http://127.0.0.1:6379/",
    "http://localhost:5432/",
    "http://127.0.0.1:2375/",
];

#[test]
fn capability_scope_allows_https_and_localhost_http() {
    for url in MUST_ALLOW {
        assert!(scope_allows(url), "scope 必须放行 {url}");
    }
}

#[test]
fn capability_scope_denies_remote_http_and_metadata() {
    for url in MUST_DENY {
        assert!(
            !scope_allows(url),
            "scope 必须拒绝 {url}（明文 http 非本机 / 元数据）"
        );
    }
}

#[test]
fn legacy_double_star_scope_rejects_explicit_ports() {
    // 缺陷形态记录：`http://**` / `https://**` 在 URLPattern 语义下等价于
    // 「默认端口」，带显式端口的 URL 一律不放行——这正是真机报错的根因。
    // 本断言把根因钉死：若哪天 urlpattern 改了语义，本测试会提醒复核。
    assert!(!allowed(
        "http://**",
        "http://127.0.0.1:8899/v1/chat/completions"
    ));
    assert!(!allowed(
        "http://**",
        "http://localhost:11434/v1/chat/completions"
    ));
    assert!(!allowed("https://**", "https://api.example.com:8443/v1"));
    // 无端口时旧写法是放行的——这解释了为什么只有部分端点可用。
    assert!(allowed(
        "http://**",
        "http://example.com/v1/chat/completions"
    ));
    assert!(allowed(
        "https://**",
        "https://api.deepseek.com/chat/completions"
    ));
}
