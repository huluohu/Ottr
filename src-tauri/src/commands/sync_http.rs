//! 同步通道 HTTP 代理（product-ready T4，BL-524 清偿）：WebDAV 通道的
//! webview 侧网络面换轨——原生 fetch（src/sync/webdav.ts）走 webview 网络栈，
//! 生产被 CORS 拦死（自建 WebDAV/dufs 不发跨域响应头；tauri.conf connect-src
//! 亦不放宽），同步功能生产不可用。本模块提供 `sync_http_fetch` 单命令：
//! webview 经 invoke 把（endpoint 凭据 + url + method + body）交给 Rust
//! reqwest 发真请求，回执 `{status, body}` 由 TS 还原成 Response 语义
//! （res.ok / res.status===404 判首同步的面零漂移）。
//!
//! 【安全面】（代理 = webview 可达的网络原语，四面钉死）：
//!   * **同源钉死**：`url` 的 origin（scheme + host + port 全等）必须与
//!     `config.server` 的 origin 一致，否则拒绝——代理只能打配置里那台
//!     WebDAV 服务器，不能被当任意 SSRF 跳板（webview 进程被攻破后 invoke
//!     可达任意命令，Rust 层是权威边界，sync_git 同款裁定）；
//!   * **method 白名单**：GET/PUT/DELETE/PROPFIND/MKCOL/HEAD（同步传输层
//!     实际只发 GET/PUT；DELETE/PROPFIND/MKCOL 留给 WebDAV 目录面，其余
//!     一律拒绝——大小写敏感，HTTP method 本就 case-sensitive）；
//!   * **header 不收口**：不接受任意 header 参数——Authorization 只在 Rust
//!     侧拼（Basic，UTF-8 安全编码与 webdav.ts basicAuthHeader 同语义），
//!     Content-Type 对 PUT 固定 application/json；
//!   * **凭据不扩散**：username/password 只经 invoke 参数进内存，拼进
//!     Authorization 后即弃；绝不写日志、绝不进错误消息、绝不进 URL
//!     （server/url 显式拒绝内嵌 userinfo——否则 reqwest 错误消息回显 URL
//!     会把 URL 凭据带出去）。错误消息只含 origin（userinfo 拒绝后无凭据面）。
//!
//! 【硬边界】：
//!   * 重定向禁用（`redirect(Policy::none)`）——跟随重定向可被 302 摆渡到
//!     其他 origin，同源钉死即失效；3xx 照 {status} 透传，TS 层 res.ok=false
//!     自然按通道故障抛错；
//!   * 响应体上限 16MB（流式累计截断）——信封是分类 JSON（数百条凭据实测
//!     256KB 量级，sync_git 大信封回归同源），16MB ≈ 60 倍余量，防被攻破/
//!     恶意的服务器用巨型响应打爆 webview 进程内存；
//!   * 总超时 30s（reqwest Client::builder().timeout，连接+响应整体）——
//!     同步是分钟级节奏的用户显式动作，不可达/黑洞连接半分钟内必须失败，
//!     与 smtp_send 的 SEND_TIMEOUT 同标定；
//!   * 每次调用独立 Client（无池跨请求复用：假服务器/真服务器连接关闭后
//!     复用旧连接的 stale 面不存在；同步节奏下握手开销可忽略）。
//!
//! 【选型】reqwest 0.12（default-features=false + rustls-tls）：异步栈与
//! tauri::async_runtime（tokio）同运行时；ureq 同步栈需 spawn_blocking 自垫
//! （且引第二套 TLS 决策），不取。命令体薄壳，`sync_http_fetch_core` 为
//! pub 核心——Rust 集成测试（dufs 真通道）不经 Tauri 运行时直接调。
//!
//! 【凭据经参数显式传入（设计裁定）】：webview 已持有通道配置（设置表单
//! 草稿 + settings.get 本就把它带进 webview），代理不新增暴露面；单一事实
//! 源，设置页「测试连接」用未保存草稿构建 transport 的既有语义天然可用。
//! 备选案（Rust 侧自读 vault settings 的 sync.config.webdav）被否：草稿
//! 测试连接直接失效（草稿未落库），且 Rust 侧多一个 settings 读取方 =
//! 双事实源（表单 vs 落库），暴露面更大而非更小。
use std::time::Duration;

use base64::Engine;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::redirect::Policy;
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize};

/// 响应体上限（流式累计截断；论证见模块文档【硬边界】）。
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
/// 单次请求总超时（连接 + 响应整体）。
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// method 白名单（同步传输层实际只发 GET/PUT，其余留给 WebDAV 目录面）。
const ALLOWED_METHODS: [&str; 6] = ["GET", "PUT", "DELETE", "PROPFIND", "MKCOL", "HEAD"];

/// 通道端点凭据（webdav 配置的代理所需子面——remotePath 不需要：URL 由
/// TS 侧 urlOf 拼好整体传入，Rust 只做同源钉死）。Debug 手写脱敏：结构体
/// 含密码，派生 Debug 会让未来任何 {:?} 日志面变成凭据泄漏点（T4 评审 P2）。
#[derive(Clone, Deserialize, PartialEq)]
pub struct SyncHttpEndpoint {
    pub server: String,
    pub username: String,
    pub password: String,
}

impl std::fmt::Debug for SyncHttpEndpoint {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncHttpEndpoint")
            .field("server", &self.server)
            .field("username", &self.username)
            .field("password", &"[REDACTED]")
            .finish()
    }
}

/// 代理回执（fetch 语义还原面：TS 侧 `new Response(body, {status})`）。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SyncHttpResult {
    pub status: u16,
    pub body: String,
}

/// Basic 认证头值（UTF-8 安全：Rust 字符串本就是 UTF-8 字节，与 webdav.ts
/// basicAuthHeader 的 TextEncoder 语义一致）。
fn basic_auth(username: &str, password: &str) -> String {
    format!(
        "Basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!("{username}:{password}").as_bytes())
    )
}

/// origin 比对面（scheme + host + port；Url 对特殊 scheme 归一 host 小写，
/// port_or_known_default 补 http=80/https=443 缺省口——显式 :80 与省略同源）。
fn origin_of(url: &Url) -> (String, String, Option<u16>) {
    (
        url.scheme().to_string(),
        url.host_str().unwrap_or("").to_lowercase(),
        url.port_or_known_default(),
    )
}

/// URL 入口校验（server 与 url 共用）：可解析、http/https、拒绝内嵌
/// userinfo（凭据不进 URL 的硬边界；错误消息不回显原文防间接泄漏）。
fn parse_endpoint_url(raw: &str, what: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    let url = Url::parse(trimmed).map_err(|_| format!("sync-http: {what} is not a valid URL"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!(
            "sync-http: {what} scheme must be http or https (got {})",
            url.scheme()
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!(
            "sync-http: {what} must not embed credentials (use the username/password fields)"
        ));
    }
    Ok(url)
}

/// 代理核心（pub：Rust 集成测试不经 Tauri 运行时直调）。错误消息不含凭据、
/// 不含 URL 原文（userinfo 已在入口拒绝，reqwest 错误回显的 URL 无凭据面）。
pub async fn sync_http_fetch_core(
    endpoint: &SyncHttpEndpoint,
    url: &str,
    method: &str,
    body: Option<String>,
) -> Result<SyncHttpResult, String> {
    // 1. method 白名单（在任何解析/联网前拒绝——拒绝路径零网络面）
    if !ALLOWED_METHODS.contains(&method) {
        return Err(format!("sync-http: method not allowed: {method}"));
    }
    let method = Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("sync-http: method parse: {e}"))?;
    // 2. server/url 入口校验 + 同源钉死
    let server = parse_endpoint_url(&endpoint.server, "server")?;
    let target = parse_endpoint_url(url, "url")?;
    if origin_of(&server) != origin_of(&target) {
        return Err(format!(
            "sync-http: url origin {:?} does not match server origin {:?} (proxy is pinned to the configured server)",
            origin_of(&target),
            origin_of(&server)
        ));
    }
    // 3. 独立 Client：无重定向（同源钉死不被 302 摆渡）+ 总超时
    let client = Client::builder()
        .redirect(Policy::none())
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("sync-http: client build: {e}"))?;
    let mut req = client.request(method, target).header(
        AUTHORIZATION,
        basic_auth(&endpoint.username, &endpoint.password),
    );
    if let Some(b) = body {
        // Content-Type 由 Rust 固定（信封恒 JSON；不接受任意 header 参数）
        req = req.header(CONTENT_TYPE, "application/json").body(b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("sync-http: request failed: {e}"))?;
    let status = resp.status().as_u16();
    // 4. 响应体流式累计 + 上限截断（resp.text() 无上限面，不用）
    let mut resp = resp;
    let mut bytes: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                    return Err(format!(
                        "sync-http: response exceeds {} bytes limit",
                        MAX_RESPONSE_BYTES
                    ));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(e) => return Err(format!("sync-http: read body: {e}")),
        }
    }
    Ok(SyncHttpResult {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

/// webview 唯一入口（命令薄壳；校验与网络全在核心）。
#[tauri::command]
pub async fn sync_http_fetch(
    config: SyncHttpEndpoint,
    url: String,
    method: String,
    body: Option<String>,
) -> Result<SyncHttpResult, String> {
    sync_http_fetch_core(&config, &url, &method, body).await
}

// ---------------------------------------------------------------------------
// 测试：std::net::TcpListener 手写最小 HTTP 假服务器（不加测试依赖）覆盖
// 转发/认证头/同源钉死/method 白名单/状态透传/凭据不泄漏/体积上限；真通道
// （dufs 夹具 127.0.0.1:15773）PUT→GET→DELETE 往返 fail-loud（webdav.dufs
// 测试同纪律）。经 tauri::async_runtime::block_on 驱动异步核心（sync_git
// 测试同款，无需 Tauri 运行时）。
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
    use std::sync::mpsc::{Receiver, Sender, channel};

    /// 读一个完整 HTTP 请求（请求行 + 头 + Content-Length 定长体）——只支持
    /// 本代理发出的请求形态（无 chunked）。
    fn read_http_request(stream: &mut TcpStream) -> std::io::Result<String> {
        let mut buf: Vec<u8> = Vec::with_capacity(4096);
        let mut chunk = [0u8; 4096];
        let head_end = loop {
            if let Some(pos) = find(&buf, b"\r\n\r\n") {
                break pos + 4;
            }
            let n = stream.read(&mut chunk)?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "eof before head end",
                ));
            }
            buf.extend_from_slice(&chunk[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
        let content_length = head
            .split("\r\n")
            .skip(1)
            .find_map(|line| {
                let (k, v) = line.split_once(':')?;
                if k.trim().eq_ignore_ascii_case("content-length") {
                    v.trim().parse::<usize>().ok()
                } else {
                    None
                }
            })
            .unwrap_or(0);
        let target = head_end + content_length;
        while buf.len() < target {
            let n = stream.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }

    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    /// 一次性假服务器：accept `responses.len()` 个连接，逐连接读完整请求 →
    /// 原文送 `captured` → 回 canned 响应 → 双向关闭。
    fn spawn_fake(responses: Vec<String>, captured: Sender<String>) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            for resp in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let req = read_http_request(&mut stream).unwrap_or_default();
                let _ = captured.send(req);
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
                let _ = stream.shutdown(Shutdown::Both);
            }
        });
        addr
    }

    /// 占住一个端口（同源拒绝测试的「另一台服务器」；不服务）。
    fn occupy_port() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").expect("bind");
        l.local_addr().expect("addr").port()
    }

    fn http_ok(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
    }

    fn http_status(status: u16, reason: &str) -> String {
        format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\n\r\n")
    }

    /// 大小写不敏感取头值（hyper 落线头名小写，但按 RFC 面写测试）。
    fn header_value<'a>(req: &'a str, name: &str) -> Option<&'a str> {
        req.split("\r\n")
            .skip(1)
            .take_while(|line| !line.is_empty())
            .find_map(|line| {
                let (k, v) = line.split_once(':')?;
                k.trim().eq_ignore_ascii_case(name).then(|| v.trim())
            })
    }

    fn request_line(req: &str) -> &str {
        req.split("\r\n").next().unwrap_or("")
    }

    fn body_of(req: &str) -> &str {
        req.split("\r\n\r\n").nth(1).unwrap_or("")
    }

    fn endpoint(server: String) -> SyncHttpEndpoint {
        SyncHttpEndpoint {
            server,
            username: "u53rname-x".into(),
            password: "p4ssword-x".into(),
        }
    }

    fn run(
        core: impl std::future::Future<Output = Result<SyncHttpResult, String>>,
    ) -> Result<SyncHttpResult, String> {
        tauri::async_runtime::block_on(core)
    }

    // --- 转发：method/url/体/认证头到达，回执还原 ---

    #[test]
    fn forwards_put_with_auth_header_and_content_type() {
        let (tx, rx): (Sender<String>, Receiver<String>) = channel();
        let addr = spawn_fake(vec![http_ok("{\"resp\":1}")], tx);
        let ep = endpoint(format!("http://{addr}"));
        let out = run(sync_http_fetch_core(
            &ep,
            &format!("http://{addr}/ottr-sync.json"),
            "PUT",
            Some("{\"k\":1}".into()),
        ))
        .expect("put ok");
        assert_eq!(out.status, 200);
        assert_eq!(out.body, "{\"resp\":1}");

        let req = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("request captured");
        assert!(
            request_line(&req).starts_with("PUT /ottr-sync.json HTTP/1.1"),
            "req: {req}"
        );
        assert_eq!(
            header_value(&req, "authorization").map(|h| h.to_string()),
            Some(format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD
                    .encode(format!("{}:{}", ep.username, ep.password))
            ))
        );
        assert_eq!(header_value(&req, "content-type"), Some("application/json"));
        assert_eq!(body_of(&req), "{\"k\":1}");
    }

    #[test]
    fn forwards_get_without_body_and_without_content_type() {
        let (tx, rx): (Sender<String>, Receiver<String>) = channel();
        let addr = spawn_fake(vec![http_ok("payload")], tx);
        let ep = endpoint(format!("http://{addr}"));
        let out = run(sync_http_fetch_core(
            &ep,
            &format!("http://{addr}/backups/s.json"),
            "GET",
            None,
        ))
        .expect("get ok");
        assert_eq!(out.status, 200);
        assert_eq!(out.body, "payload");

        let req = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("request captured");
        assert!(
            request_line(&req).starts_with("GET /backups/s.json HTTP/1.1"),
            "req: {req}"
        );
        assert!(header_value(&req, "authorization").is_some());
        assert!(
            header_value(&req, "content-type").is_none(),
            "GET 无体不带 Content-Type"
        );
        assert_eq!(body_of(&req), "");
    }

    // --- method 白名单（拒绝路径零网络面） ---

    #[test]
    fn rejects_non_whitelisted_methods_before_network() {
        let (tx, rx): (Sender<String>, Receiver<String>) = channel();
        let addr = spawn_fake(vec![http_ok("never")], tx);
        let ep = endpoint(format!("http://{addr}"));
        for method in ["TRACE", "OPTIONS", "CONNECT", "PATCH", "get", "put", ""] {
            let out = run(sync_http_fetch_core(
                &ep,
                &format!("http://{addr}/x"),
                method,
                None,
            ));
            assert!(out.is_err(), "must reject method {method:?}");
            let msg = out.unwrap_err();
            assert!(msg.contains("method not allowed"), "{method:?}: {msg}");
        }
        assert!(rx.try_recv().is_err(), "白名单外 method 不得触达网络面");
    }

    // --- 同源钉死 ---

    #[test]
    fn rejects_cross_origin_url_before_network() {
        let (tx, rx): (Sender<String>, Receiver<String>) = channel();
        let addr = spawn_fake(vec![http_ok("never")], tx);
        let other_port = occupy_port();
        let ep = endpoint(format!("http://{addr}"));
        // 端口不同
        let cross = format!("http://127.0.0.1:{other_port}/ottr-sync.json");
        let out = run(sync_http_fetch_core(&ep, &cross, "GET", None));
        assert!(out.is_err());
        assert!(out.unwrap_err().contains("origin"), "须是同源拒绝语义");
        // scheme 不同（同 host:port，http vs https）
        let cross_scheme = format!("https://{addr}/ottr-sync.json");
        let out = run(sync_http_fetch_core(&ep, &cross_scheme, "GET", None));
        assert!(out.is_err());
        assert!(out.unwrap_err().contains("origin"));
        // host 不同（localhost ≠ 127.0.0.1）
        let cross_host = format!("http://localhost:{}/ottr-sync.json", addr.port());
        let out = run(sync_http_fetch_core(&ep, &cross_host, "GET", None));
        assert!(out.is_err());
        assert!(out.unwrap_err().contains("origin"));
        assert!(rx.try_recv().is_err(), "同源拒绝不得触达网络面");
    }

    #[test]
    fn accepts_explicit_default_port_as_same_origin() {
        // 显式缺省端口与省略端口同源（port_or_known_default 语义）——纯函数面
        // 直测（本机 :80 可能有真实服务在跑，不依赖网络环境的巧合）。
        let explicit = Url::parse("http://127.0.0.1:80/a").unwrap();
        let omitted = Url::parse("http://127.0.0.1/a").unwrap();
        assert_eq!(origin_of(&explicit), origin_of(&omitted));
        let explicit_tls = Url::parse("https://dav.example.com:443/a").unwrap();
        let omitted_tls = Url::parse("https://dav.example.com/a").unwrap();
        assert_eq!(origin_of(&explicit_tls), origin_of(&omitted_tls));
        // 反面：显式非缺省端口 ≠ 缺省端口
        assert_ne!(
            origin_of(&Url::parse("http://127.0.0.1:8080/a").unwrap()),
            origin_of(&omitted)
        );
    }

    // --- 状态透传（fetch 语义依赖：404=首同步；401/5xx 由 TS 层映射） ---

    #[test]
    fn passes_404_401_5xx_through_with_status_surface() {
        for (status, reason) in [
            (404u16, "Not Found"),
            (401, "Unauthorized"),
            (500, "Internal Server Error"),
        ] {
            let (tx, rx): (Sender<String>, Receiver<String>) = channel();
            let addr = spawn_fake(vec![http_status(status, reason)], tx);
            let ep = endpoint(format!("http://{addr}"));
            let out = run(sync_http_fetch_core(
                &ep,
                &format!("http://{addr}/s.json"),
                "GET",
                None,
            ))
            .unwrap_or_else(|e| panic!("status {status} must pass through: {e}"));
            assert_eq!(out.status, status);
            assert_eq!(out.body, "");
            drop(rx);
        }
    }

    // --- 凭据不进 URL / 不进错误消息 ---

    #[test]
    fn rejects_credentials_embedded_in_urls() {
        let addr = spawn_fake(vec![], channel().0);
        let port = addr.port();
        // url 内嵌 userinfo（即使 origin 一致也拒——凭据只走 username/password 字段）
        let ep = endpoint(format!("http://127.0.0.1:{port}"));
        let out = run(sync_http_fetch_core(
            &ep,
            &format!("http://u:p@127.0.0.1:{port}/s.json"),
            "GET",
            None,
        ));
        let msg = out.unwrap_err();
        assert!(msg.contains("must not embed credentials"), "{msg}");
        // server 内嵌 userinfo 同拒
        let ep2 = endpoint(format!("http://u:p@127.0.0.1:{port}"));
        let out = run(sync_http_fetch_core(
            &ep2,
            &format!("http://127.0.0.1:{port}/s.json"),
            "GET",
            None,
        ));
        assert!(out.unwrap_err().contains("must not embed credentials"));
    }

    #[test]
    fn error_messages_never_contain_credentials() {
        let ep = endpoint("http://127.0.0.1:9".into()); // discard 端口：连接必败
        // 网络错
        let out = run(sync_http_fetch_core(
            &ep,
            "http://127.0.0.1:9/s.json",
            "GET",
            None,
        ));
        let net_err = out.unwrap_err();
        // 同源错
        let out = run(sync_http_fetch_core(
            &ep,
            "http://127.0.0.1:10/s.json",
            "GET",
            None,
        ));
        let origin_err = out.unwrap_err();
        // 白名单错 + 内嵌凭据错 + 非法 URL 错
        let method_err = run(sync_http_fetch_core(
            &ep,
            "http://127.0.0.1:9/x",
            "TRACE",
            None,
        ))
        .unwrap_err();
        let userinfo_err = run(sync_http_fetch_core(
            &ep,
            "http://u:p@127.0.0.1:9/s.json",
            "GET",
            None,
        ))
        .unwrap_err();
        let badurl_err = run(sync_http_fetch_core(&ep, "http://[bad", "GET", None)).unwrap_err();
        let out = run(sync_http_fetch_core(
            &SyncHttpEndpoint {
                server: "ftp://nope".into(),
                username: "u53rname-x".into(),
                password: "p4ssword-x".into(),
            },
            "http://127.0.0.1:9/s.json",
            "GET",
            None,
        ));
        let scheme_err = out.unwrap_err();
        for (what, msg) in [
            ("network", net_err.as_str()),
            ("origin", origin_err.as_str()),
            ("method", method_err.as_str()),
            ("userinfo", userinfo_err.as_str()),
            ("badurl", badurl_err.as_str()),
            ("scheme", scheme_err.as_str()),
        ] {
            assert!(!msg.contains("u53rname-x"), "{what} 错误含用户名: {msg}");
            assert!(!msg.contains("p4ssword-x"), "{what} 错误含口令: {msg}");
        }
    }

    // --- 响应体上限（16MB 流式截断） ---

    #[test]
    fn rejects_response_over_limit() {
        // 17MB 响应（> 16MB 上限）：假服务器整块回，核心须在累计超限时报错
        let big = "x".repeat(17 * 1024 * 1024);
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{big}",
            big.len()
        );
        let (tx, rx): (Sender<String>, Receiver<String>) = channel();
        let addr = spawn_fake(vec![resp], tx);
        let ep = endpoint(format!("http://{addr}"));
        let out = run(sync_http_fetch_core(
            &ep,
            &format!("http://{addr}/s.json"),
            "GET",
            None,
        ));
        let msg = out.unwrap_err();
        assert!(msg.contains("exceeds"), "{msg}");
        drop(rx);
    }

    #[test]
    fn accepts_response_at_limit() {
        // 恰好 16MB：不超限，全量取回
        let big = "y".repeat(MAX_RESPONSE_BYTES);
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{big}",
            big.len()
        );
        let (tx, rx): (Sender<String>, Receiver<String>) = channel();
        let addr = spawn_fake(vec![resp], tx);
        let ep = endpoint(format!("http://{addr}"));
        let out = run(sync_http_fetch_core(
            &ep,
            &format!("http://{addr}/s.json"),
            "GET",
            None,
        ))
        .expect("at-limit response must pass");
        assert_eq!(out.body.len(), MAX_RESPONSE_BYTES);
        drop(rx);
    }

    // --- dufs 真通道（fail-loud：夹具不可达即 panic 并给启动提示） ---

    fn require_dufs() -> SyncHttpEndpoint {
        let ep = SyncHttpEndpoint {
            server: "http://127.0.0.1:15773".into(),
            username: "user".into(),
            password: "pass".into(),
        };
        let probe = std::net::TcpStream::connect("127.0.0.1:15773");
        assert!(
            probe.is_ok(),
            "dufs fixture unreachable at 127.0.0.1:15773 —— 先跑 docker start ottr-dufs（scripts/spike-dufs.sh）"
        );
        ep
    }

    #[test]
    fn dufs_roundtrip_put_get_delete() {
        let ep = require_dufs();
        let name = format!(
            "ottr-sync-rust-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let base = "http://127.0.0.1:15773";
        let url = format!("{base}/{name}");

        // 首同步语义：GET 缺文件 = 404 原样透传
        let out = run(sync_http_fetch_core(&ep, &url, "GET", None)).expect("get 404 ok");
        assert_eq!(out.status, 404);

        // PUT 信封（application/json）→ 2xx
        let envelope = "{\"ottr-sync\":1,\"note\":\"t4 rust proxy\"}";
        let out = run(sync_http_fetch_core(
            &ep,
            &url,
            "PUT",
            Some(envelope.into()),
        ))
        .expect("put ok");
        assert!(
            (200..300).contains(&out.status),
            "dufs PUT 须 2xx，got {}",
            out.status
        );

        // GET → 200 + 原文
        let out = run(sync_http_fetch_core(&ep, &url, "GET", None)).expect("get ok");
        assert_eq!(out.status, 200);
        assert_eq!(out.body, envelope);

        // 错口令 → 401 透传（状态保真，TS 层映射认证失败）
        let stranger = SyncHttpEndpoint {
            server: ep.server.clone(),
            username: "user".into(),
            password: "wrong".into(),
        };
        let out = run(sync_http_fetch_core(&stranger, &url, "GET", None)).expect("401 passthrough");
        assert_eq!(out.status, 401);

        // DELETE 清场 → 2xx；再 GET = 404（容器可复用不依赖旧态）
        let out = run(sync_http_fetch_core(&ep, &url, "DELETE", None)).expect("delete ok");
        assert!(
            (200..300).contains(&out.status),
            "dufs DELETE 须 2xx，got {}",
            out.status
        );
        let out = run(sync_http_fetch_core(&ep, &url, "GET", None)).expect("get 404 ok");
        assert_eq!(out.status, 404);
    }
}
