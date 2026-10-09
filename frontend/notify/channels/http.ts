// 渠道适配器 HTTP 小面（B5）：JSON/表单 POST 的公共收口（Mock HTTP 单测
// 统一注入 fetchImpl）+ HMAC-SHA256 签名（钉钉/飞书加签，Web Crypto）。
// 全部走 `postJson`/`postForm` 的 `deps.fetchImpl`——适配器自身零全局副作用。
import { defaultDeps, type ChannelDeps } from "./types";

/** 非 2xx → Error（含状态码与响应片段；「发送测试」错误面直用）。 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, snippet: string) {
    super(`HTTP ${status}: ${snippet.slice(0, 200)}`);
    this.status = status;
  }
}

/** JSON POST（Content-Type: application/json；返回解析后的响应体——
 * 各渠道业务码校验在适配器内做）。 */
export async function postJson<T = unknown>(
  url: string,
  payload: unknown,
  deps: ChannelDeps = {},
  headers: Record<string, string> = {},
): Promise<T> {
  const doFetch = deps.fetchImpl ?? defaultDeps.fetchImpl;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return readBody<T>(res);
}

/** 表单 POST（application/x-www-form-urlencoded；ServerChan/Pushover）。 */
export async function postForm<T = unknown>(
  url: string,
  fields: Record<string, string>,
  deps: ChannelDeps = {},
): Promise<T> {
  const doFetch = deps.fetchImpl ?? defaultDeps.fetchImpl;
  const res = await doFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });
  return readBody<T>(res);
}

/** 文本 POST（ntfy：body=消息正文，标题等走自定义头）。 */
export async function postText(
  url: string,
  text: string,
  deps: ChannelDeps = {},
  headers: Record<string, string> = {},
): Promise<string> {
  const doFetch = deps.fetchImpl ?? defaultDeps.fetchImpl;
  const res = await doFetch(url, { method: "POST", headers, body: text });
  await assertOk(res);
  return res.text();
}

async function readBody<T>(res: Response): Promise<T> {
  await assertOk(res);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

async function assertOk(res: Response): Promise<void> {
  if (!res.ok) {
    let snippet = "";
    try {
      snippet = await res.text();
    } catch {
      // body 读取失败只降级错误片段
    }
    throw new HttpError(res.status, snippet);
  }
}

/** HMAC-SHA256(key, message) → base64（Web Crypto；jsdom/node webcrypto 可用）。 */
export async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin);
}
