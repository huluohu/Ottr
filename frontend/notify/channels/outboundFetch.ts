// 外发 HTTP 统一收口（2026-10-16「Load failed」修复）：webview 内裸 fetch
// 是跨域请求——webhook API / LLM API 均不带 CORS 头，预检必被浏览器层拦下
// （WebKit 报 TypeError: Load failed；curl/其他工具无同源限制，故「别处可
// 用」）。Tauri 环境改走 tauri-plugin-http（Rust reqwest：无 CORS，安装器
// capability 按 https://**/http://** 授权）；非 Tauri（vitest/纯浏览器 dev）
// 回落全局 fetch——provider.test 等既有 vi.stubGlobal("fetch") 桩零扰动。
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let pluginFetch: typeof fetch | undefined;

async function resolveFetch(): Promise<typeof fetch> {
  if (!IS_TAURI) return globalThis.fetch;
  if (!pluginFetch) {
    const mod = await import("@tauri-apps/plugin-http");
    pluginFetch = mod.fetch as typeof fetch;
  }
  return pluginFetch;
}

export async function outboundFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const f = await resolveFetch();
  return f(input, init);
}
