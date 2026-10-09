// WebDAV 通道单测（Phase 5 Task 2）——Mock fetch 记录请求（channels.test.ts
// 同纪律，零真发）；真容器端到端在 webdav.dufs.test.ts。
import { describe, expect, it } from "vitest";
import { sealEnvelope } from "./envelope";
import { basicAuthHeader, createWebdavTransport } from "./webdav";

type Req = { url: string; init: RequestInit };

function mockFetch(responder: (req: Req, nth: number) => Response | Promise<Response>) {
  const calls: Req[] = [];
  const impl = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const req: Req = { url: String(input), init: init ?? {} };
    const nth = calls.length;
    calls.push(req);
    return await responder(req, nth);
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const config = {
  server: "http://127.0.0.1:15773",
  remotePath: "backups/ottr-sync.json",
  username: "user",
  password: "pass",
};

describe("WebDAV 通道", () => {
  it("fetch：GET + Basic 头 golden；404→null；200→信封解析", async () => {
    const env = await sealEnvelope("{}", "pw");
    const { calls, impl } = mockFetch((_req, nth) =>
      nth === 0
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify(env), { status: 200 }),
    );
    const t = createWebdavTransport(config, { fetchImpl: impl });

    expect(await t.fetch()).toBeNull(); // 首次同步
    const got = await t.fetch();
    expect(got).toEqual(env);

    expect(calls[0]).toMatchObject({ url: "http://127.0.0.1:15773/backups/ottr-sync.json", init: { method: "GET" } });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(basicAuthHeader("user", "pass"));
  });

  it("fetch：非 2xx 非 404（401/500）→ 抛错且状态码入消息", async () => {
    for (const status of [401, 500]) {
      const t = createWebdavTransport(config, { fetchImpl: mockFetch(() => new Response(null, { status })).impl });
      await expect(t.fetch()).rejects.toThrow(`HTTP ${status}`);
    }
  });

  it("push：PUT + JSON 体 golden（服务端路径可配 + 尾斜杠容错）", async () => {
    const env = await sealEnvelope("payload", "pw");
    const { calls, impl } = mockFetch(() => new Response(null, { status: 201 }));
    const t = createWebdavTransport({ ...config, server: "http://dav.example.com/" }, { fetchImpl: impl });
    await t.push(env);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: "http://dav.example.com/backups/ottr-sync.json",
      init: { method: "PUT" },
    });
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(calls[0].init.body).toBe(JSON.stringify(env));

    const bad = createWebdavTransport(config, { fetchImpl: mockFetch(() => new Response(null, { status: 507 })).impl });
    await expect(bad.push(env)).rejects.toThrow("HTTP 507");
  });

  it("test：200/404=true；401/网络错=false（布尔面直给 UI 不抛）", async () => {
    for (const [status, want] of [[200, true], [404, true], [401, false], [403, false], [502, false]] as const) {
      const t = createWebdavTransport(config, { fetchImpl: mockFetch(() => new Response(null, { status })).impl });
      expect(await t.test(), `status ${status}`).toBe(want);
    }
    const netFail = createWebdavTransport(config, {
      fetchImpl: mockFetch(() => {
        throw new TypeError("network down");
      }).impl,
    });
    expect(await netFail.test()).toBe(false);
  });

  it("通道全链：seal → push → fetch → open（信封与通道同栈端到端）", async () => {
    let stored: string | null = null;
    const t = createWebdavTransport(config, {
      fetchImpl: mockFetch((req) => {
        if (req.init.method === "PUT") {
          stored = String(req.init.body);
          return new Response(null, { status: 201 });
        }
        return stored === null ? new Response(null, { status: 404 }) : new Response(stored, { status: 200 });
      }).impl,
    });
    const { openEnvelope } = await import("./envelope");
    expect(await t.fetch()).toBeNull(); // 首次：远端无信封
    const sealed = await sealEnvelope('{"hosts":[1]}', "通道口令");
    await t.push(sealed);
    const fetched = await t.fetch();
    expect(fetched).not.toBeNull();
    expect(new TextDecoder().decode(await openEnvelope(fetched, "通道口令"))).toBe('{"hosts":[1]}');
    expect(await t.test()).toBe(true);
  });

  it("Basic 头：UTF-8 用户名/口令（latin1 之外字符）", () => {
    expect(basicAuthHeader("水獭", "pa:ss")).toBe(`Basic ${btoa(String.fromCharCode(...new TextEncoder().encode("水獭:pa:ss")))}`);
  });
});
