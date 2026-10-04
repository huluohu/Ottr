// WebDAV 同步通道（Phase 5 Task 2；product-ready T4 生产代理 BL-524 清偿）
// ——HTTP GET/PUT + Basic 认证，路径可配。
//
// 语义面（SyncTransport 契约落点）：
//   * fetch：GET <server>/<remotePath>，404 = 首次同步 → null；200 → 信封校验；
//     其余非 2xx = 通道故障抛错（认证失败 401/403 也抛——fetch 的错误要浮给
//     编排层，test() 的布尔面才吞）；
//   * push：PUT 覆盖写（201/204/200 皆可）；last-writer-wins（无 If-Match/
//     ETag CAS——并发保护归 Task 3 编排层的双改指纹检测，文件头有声明）；
//   * test：GET 探测，2xx/404 = true（404 = 服务器可达且已授权，只是还没文件）；
//     401/403/5xx/网络错 = false。
//
// 依赖注入沿渠道适配器（ChannelDeps.fetchImpl 同款）：单测 Mock fetch 记录
// 请求，端到端真容器（fixtures/dufs，sigoden/dufs）零适配直连。
//
// 生产网络面（product-ready T4，BL-524）：默认 fetchImpl = tauriWebdavFetch
// ——webview 原生 fetch 生产被 CORS 拦死（自建 WebDAV/dufs 不发跨域响应头，
// tauri.conf connect-src 亦不放宽），改经 invoke 走 Rust reqwest 代理命令
// sync_http_fetch（src-tauri commands/sync_http.rs：同源钉死 + method 白名单
// + Authorization/Content-Type 全在 Rust 侧拼）。回执 {status, body} 还原成
// Response——本文件上方全部语义（404=null / 错误消息 HTTP <status> / test
// 布尔面）零漂移；vitest/端到端测试显式注入 fetchImpl（node fetch 或 Mock）。
import { parseEnvelopeJson, type SyncTransport } from "./transport";
import type { SyncEnvelope } from "./envelope";

export interface WebdavConfig {
  /** 服务器根（如 https://dav.example.com 或自建 dufs http://127.0.0.1:15773）。 */
  server: string;
  /** 信封远端路径（相对 server；缺省 ottr-sync.json）。 */
  remotePath?: string;
  username: string;
  password: string;
}

/** 可注入端口（Mock HTTP 单测 / node 端到端；生产缺省 = tauriWebdavFetch
 * Rust 代理，见下方裁定）。 */
export interface WebdavDeps {
  fetchImpl?: typeof fetch;
}

const DEFAULT_REMOTE_PATH = "ottr-sync.json";

// 注记：push 是裸 PUT——WebDAV 服务器对「父目录不存在」普遍返回 404/409
// （dufs 实测 404），本通道不自动 MKCOL（最小面）；remotePath 请落在服务器
// 侧已存在的目录下（自建服务器/网盘默认根目录即可）。

/** Basic 认证头值（UTF-8 安全：btoa 只吃 latin1，先过 UTF-8 字节化）。 */
export function basicAuthHeader(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

function urlOf(config: WebdavConfig): string {
  const server = config.server.replace(/\/+$/, "");
  const path = (config.remotePath ?? DEFAULT_REMOTE_PATH).replace(/^\/+/, "");
  return `${server}/${path}`;
}

/** Rust HTTP 代理命令（src-tauri commands/sync_http.rs）的回执面。 */
export interface SyncHttpResult {
  status: number;
  body: string;
}

/** 代理 fetch 的注入面（单测 mock invoke；生产动态 import）。 */
export interface WebdavProxyDeps {
  invokeImpl?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}

const PROXY_UNAVAILABLE =
  "webdav proxy: tauri IPC unavailable (non-Tauri environments must inject deps.fetchImpl)";

/** Tauri IPC 可达性（webview 注入 __TAURI_INTERNALS__；测试可用空对象放行）。 */
function hasTauriInternals(): boolean {
  const w = globalThis as unknown as { window?: Record<string, unknown> | undefined };
  return typeof w.window === "object" && w.window !== null && "__TAURI_INTERNALS__" in w.window;
}

/**
 * 生产 fetchImpl（webview 专用，product-ready T4 / BL-524）：原生 fetch 走
 * webview 网络栈，生产被 CORS 拦死——改走 Rust reqwest 代理命令
 * sync_http_fetch。凭据经 config 显式传入（单一事实源：设置表单/settings.get
 * 本就把配置带进 webview；草稿「测试连接」天然可用，备选案 Rust 自读 vault
 * settings 会破坏草稿测试并引入双事实源，裁定否）。同源钉死/method 白名单/
 * header 拼接都在 Rust 侧权威执行——本包装发出的 init.headers 只服务
 * fetchImpl 注入路径的语义面，代理路径不透传任意 header。回执 {status, body}
 * → Response 还原：res.ok / res.status===404 判首同步 / test() 布尔面零漂移。
 */
export function tauriWebdavFetch(config: WebdavConfig, deps: WebdavProxyDeps = {}): typeof fetch {
  return async (input, init) => {
    const invokeCmd = async <T,>(cmd: string, args: Record<string, unknown>): Promise<T> => {
      if (deps.invokeImpl) return deps.invokeImpl<T>(cmd, args);
      if (!hasTauriInternals()) throw new Error(PROXY_UNAVAILABLE);
      const core = (await import("@tauri-apps/api/core")) as typeof import("@tauri-apps/api/core");
      return core.invoke<T>(cmd, args);
    };
    const result = await invokeCmd<SyncHttpResult>("sync_http_fetch", {
      config: { server: config.server, username: config.username, password: config.password },
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    // Response 构造器只吃 200-599：越界前置拦截（正常不会发生——Rust 回执
    // status 取自真实 HTTP 响应；此处是防御面不是语义面）
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) {
      throw new Error(`webdav proxy: invalid status ${JSON.stringify(result.status)}`);
    }
    return new Response(result.body, { status: result.status });
  };
}

export function createWebdavTransport(config: WebdavConfig, deps: WebdavDeps = {}): SyncTransport {
  const doFetch = deps.fetchImpl ?? tauriWebdavFetch(config);
  const url = urlOf(config);

  async function get(): Promise<Response> {
    return doFetch(url, { method: "GET", headers: { Authorization: basicAuthHeader(config.username, config.password) } });
  }

  return {
    kind: "webdav",

    async fetch(): Promise<SyncEnvelope | null> {
      const res = await get();
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`webdav fetch failed: HTTP ${res.status} ${url}`.trimEnd());
      }
      return parseEnvelopeJson(await res.text());
    },

    async push(envelope: SyncEnvelope): Promise<void> {
      const res = await doFetch(url, {
        method: "PUT",
        headers: {
          Authorization: basicAuthHeader(config.username, config.password),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(envelope),
      });
      if (!res.ok) {
        throw new Error(`webdav push failed: HTTP ${res.status} ${url}`.trimEnd());
      }
    },

    async test(): Promise<boolean> {
      try {
        const res = await get();
        return res.ok || res.status === 404;
      } catch {
        return false;
      }
    },
  };
}
