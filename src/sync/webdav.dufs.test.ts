// WebDAV 通道真夹具端到端（Phase 5 Task 2）：dufs 容器（scripts/spike-dufs.sh
// 启动，127.0.0.1:15773，Basic user:pass，v0.46.0 摘要钉版）——真 HTTP PUT/GET
// + Basic 认证全链：信封推送 → 独立传输实例拉取 → 密封链开封对拍；错口令
// 401 面（test=false）；首次同步 404=null。文件名按轮随机化（容器可复用不依赖
// 旧态）。夹具不可达 → 立即 fail 并提示启动命令（trzsz e2e 同纪律）。
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { openEnvelope, sealEnvelope } from "./envelope";
import { createWebdavTransport } from "./webdav";

const HOST = "http://127.0.0.1:15773";
const USER = "user";
const PASS = "pass";

async function fixtureOrPanic(): Promise<void> {
  try {
    const res = await fetch(`${HOST}/`);
    // 401 = 服务在等认证（活着）；200/404 也算活
    if (res.status < 500) return;
    throw new Error(`unexpected status ${res.status}`);
  } catch {
    throw new Error(`dufs fixture unreachable at ${HOST} —— 先跑 scripts/spike-dufs.sh`);
  }
}

describe("WebDAV 通道（dufs 真容器）", () => {
  it("双端 roundtrip：A push → B fetch → 密封链 open；错口令/首次语义/连接测试", async () => {
    await fixtureOrPanic();
    // 扁平文件名：dufs（与多数 WebDAV 服务器一致）PUT 不自动建父目录——
    // remotePath 的父目录需服务端已存在（webdav.ts 文件头有注记）
    const remotePath = `ottr-sync-${Date.now()}-${Math.floor(Math.random() * 1e9)}.json`;
    const deviceA = createWebdavTransport({ server: HOST, remotePath, username: USER, password: PASS });
    const deviceB = createWebdavTransport({ server: HOST, remotePath, username: USER, password: PASS });

    // 首次同步：远端无信封 → null；连接测试 true（可达且已授权）
    expect(await deviceB.fetch()).toBeNull();
    expect(await deviceB.test()).toBe(true);

    // A 密封推送 → B 独立实例拉取同一信封 → 口令开封还原明文
    const plaintext = JSON.stringify({ hosts: [{ name: "web-01", port: 22 }], exported_at: Date.now() });
    const sealed = await sealEnvelope(plaintext, "e2e-pass");
    await deviceA.push(sealed);
    const got = await deviceB.fetch();
    expect(got).toEqual(sealed);
    expect(new TextDecoder().decode(await openEnvelope(got, "e2e-pass"))).toBe(plaintext);

    // B 修改再推（覆盖）→ A 拉到 B 版（last-writer-wins 传输层语义）
    const sealed2 = await sealEnvelope(JSON.stringify({ hosts: [], bumped: true }), "e2e-pass");
    await deviceB.push(sealed2);
    expect(await deviceA.fetch()).toEqual(sealed2);

    // 错口令：信封层拒绝（与通道无关，通道只搬运密文）——
    // 认证错在通道层的形态是 401：错误凭据的实例 test=false
    const stranger = createWebdavTransport({ server: HOST, remotePath, username: USER, password: "wrong" });
    expect(await stranger.test()).toBe(false);
    await expect(stranger.fetch()).rejects.toThrow("HTTP 401");
  }, 30_000);
});
