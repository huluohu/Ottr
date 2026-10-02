// WebDAV 同步通道（Phase 5 Task 2）——HTTP GET/PUT + Basic 认证，路径可配。
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

/** 可注入端口（Mock HTTP 单测；生产 = 全局 fetch）。 */
export interface WebdavDeps {
  fetchImpl?: typeof fetch;
}

const DEFAULT_REMOTE_PATH = "ottr-sync.json";

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

export function createWebdavTransport(config: WebdavConfig, deps: WebdavDeps = {}): SyncTransport {
  const doFetch = deps.fetchImpl ?? ((...args) => fetch(...args));
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
