// 非本机明文 http 端点的保存前拦截测试（2026-11-02 安全审计）。
//
// 应用的能力门（desktop/capabilities/default.json）只放行**本机** http——
// 非本机明文 http 会把 API key 裸传在链路上，且插件侧无 CORS、webview 内任意
// 脚本都能读任意 http 地址。与其让用户配好了却在调用时报「url not allowed on
// the configured scope」，不如在设置页保存前说清。
import { describe, expect, it } from "vitest";
import { isRemotePlainHttp } from "./AISettings";

describe("isRemotePlainHttp", () => {
  it("本机明文 http 放行（Ollama / LM Studio 等本地端点）", () => {
    expect(isRemotePlainHttp("http://localhost:11434/v1")).toBe(false);
    expect(isRemotePlainHttp("http://127.0.0.1:11434/v1")).toBe(false);
    expect(isRemotePlainHttp("http://[::1]:11434/v1")).toBe(false);
    expect(isRemotePlainHttp("http://LOCALHOST:11434/v1")).toBe(false);
  });

  it("非本机明文 http → 拦截", () => {
    expect(isRemotePlainHttp("http://192.168.1.10:11434/v1")).toBe(true);
    expect(isRemotePlainHttp("http://example.com/v1")).toBe(true);
    expect(isRemotePlainHttp("http://ai.corp.internal:8000/v1")).toBe(true);
  });

  it("https 一律放行（无论主机）", () => {
    expect(isRemotePlainHttp("https://api.deepseek.com/v1")).toBe(false);
    expect(isRemotePlainHttp("https://192.168.1.10:8443/v1")).toBe(false);
  });

  it("解析不了的地址不误判（交给格式校验报错）", () => {
    expect(isRemotePlainHttp("not a url")).toBe(false);
    expect(isRemotePlainHttp("")).toBe(false);
  });
});
