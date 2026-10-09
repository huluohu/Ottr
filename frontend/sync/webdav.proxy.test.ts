// WebDAV 生产代理包装测试（product-ready T4，BL-524 清偿）：默认 fetchImpl
// 切到 Rust 代理命令 sync_http_fetch——本文件覆盖包装器自身面：
//   * invoke 参数 golden（凭据经 config 显式传入；url/method/body 原样透传）；
//   * 回执 {status, body} → Response 还原（404=null 首同步 / 401·5xx 通道
//     错误消息面不变 / test() 布尔面不变——Mock fetch 单测零漂移）；
//   * status 越界（Response 构造器只吃 200-599）→ 明确错误；
//   * 非 Tauri 环境（无 __TAURI_INTERNALS__）→ 明确报错，不静默吃全局 fetch。
// invoke 参数 golden 只断言「凭据进 config」——Authorization 头由 Rust 拼
// （webdav.test.ts 的 init.headers golden 只服务 fetchImpl 注入路径）。
import { describe, expect, it } from "vitest";
import { sealEnvelope } from "./envelope";
import { createWebdavTransport, tauriWebdavFetch, type SyncHttpResult } from "./webdav";

const config = {
  server: "http://127.0.0.1:15773",
  remotePath: "backups/ottr-sync.json",
  username: "u1",
  password: "p1",
};

type InvokeCall = { cmd: string; args: Record<string, unknown> };

function invokeMock(results: Array<SyncHttpResult | Error>) {
  const calls: InvokeCall[] = [];
  const impl = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args: args ?? {} });
    const next = results.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("invokeMock: no scripted result");
    return next as T;
  };
  return { calls, impl };
}

const proxied = (results: Array<SyncHttpResult | Error>) =>
  createWebdavTransport(config, { fetchImpl: tauriWebdavFetch(config, { invokeImpl: invokeMock(results).impl }) });

describe("WebDAV 生产代理包装（tauriWebdavFetch）", () => {
  it("fetch：invoke 参数 golden——凭据进 config、url/method 透传、GET 无体 body=null", async () => {
    const env = await sealEnvelope("{}", "pw");
    const t = proxied([{ status: 200, body: JSON.stringify(env) }]);
    const got = await t.fetch();
    expect(got).toEqual(env);
  });

  it("fetch/push 全参数面：PUT 带 JSON 体；404→null 首同步；401/5xx 错误消息面不变", async () => {
    const env = await sealEnvelope("payload", "pw");
    const { calls, impl } = invokeMock([
      { status: 404, body: "" },
      { status: 201, body: "" },
    ]);
    const t = createWebdavTransport(config, { fetchImpl: tauriWebdavFetch(config, { invokeImpl: impl }) });
    expect(await t.fetch()).toBeNull(); // 首同步语义经代理不变
    await t.push(env);

    expect(calls[0]).toEqual({
      cmd: "sync_http_fetch",
      args: {
        config: { server: config.server, username: config.username, password: config.password },
        url: "http://127.0.0.1:15773/backups/ottr-sync.json",
        method: "GET",
        body: null,
      },
    });
    expect(calls[1]?.cmd).toBe("sync_http_fetch");
    expect(calls[1]?.args).toMatchObject({ method: "PUT", body: JSON.stringify(env) });

    // 非 2xx 非 404：transport 层既有错误消息面零漂移（HTTP <status>）
    const unauthorized = proxied([{ status: 401, body: "" }]);
    await expect(unauthorized.fetch()).rejects.toThrow("HTTP 401");
    const busy = proxied([{ status: 507, body: "" }]);
    await expect(busy.push(env)).rejects.toThrow("HTTP 507");
  });

  it("test()：2xx/404=true；401/5xx=false；invoke 抛错（网络错）=false 不悬挂", async () => {
    expect(await proxied([{ status: 200, body: "" }]).test()).toBe(true);
    expect(await proxied([{ status: 404, body: "" }]).test()).toBe(true);
    expect(await proxied([{ status: 401, body: "" }]).test()).toBe(false);
    expect(await proxied([{ status: 502, body: "" }]).test()).toBe(false);
    const t = createWebdavTransport(config, {
      fetchImpl: tauriWebdavFetch(config, { invokeImpl: invokeMock([new Error("sync-http: request failed: net down")]).impl }),
    });
    expect(await t.test()).toBe(false);
    // fetch 面：invoke 抛错原样上浮（通道故障不吞）
    const t2 = createWebdavTransport(config, {
      fetchImpl: tauriWebdavFetch(config, { invokeImpl: invokeMock([new Error("sync-http: request failed: net down")]).impl }),
    });
    await expect(t2.fetch()).rejects.toThrow("net down");
  });

  it("status 越界（<200 / >599）→ 明确错误（Response 构造器 RangeError 前置拦截）", async () => {
    for (const status of [199, 600, Number.NaN]) {
      const t = proxied([{ status, body: "" }]);
      await expect(t.fetch()).rejects.toThrow("invalid status");
    }
  });

  it("非 Tauri 环境：默认 fetchImpl（无 deps）报明确错误，不静默走全局 fetch", async () => {
    const t = createWebdavTransport(config); // 生产默认 = 代理包装
    await expect(t.fetch()).rejects.toThrow("non-Tauri environments must inject deps.fetchImpl");
    expect(await t.test()).toBe(false); // 布尔面照旧不悬挂
  });
});
