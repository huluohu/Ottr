// AI settings 读写测试（T13）：默认值回落 / 钳制 / secrets 键名约定。
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  DEFAULT_MAX_TOKENS,
  apiKeySecretKey,
  loadAiSettings,
} from "./settings";

const mockedInvoke = invoke as unknown as Mock;

beforeEach(() => {
  mockedInvoke.mockReset();
});

function settingForKey(key: string, value: unknown) {
  mockedInvoke.mockImplementation((_cmd: string, args: { key: string }) =>
    args?.key === key ? Promise.resolve(value) : Promise.resolve(null),
  );
}

describe("loadAiSettings", () => {
  it("全空 settings → 全默认", async () => {
    mockedInvoke.mockResolvedValue(null);
    const s = await loadAiSettings();
    expect(s).toEqual({
      enabled: true,
      maxTokens: DEFAULT_MAX_TOKENS,
      providers: [],
      redaction: { hostname: true, custom: [] },
    });
  });

  it("providers/redaction 原样透传；enabled=false 生效", async () => {
    const providers = [
      { id: "p1", name: "DeepSeek", kind: "openai-compatible", baseURL: "https://api.deepseek.com", model: "deepseek-chat" },
    ];
    const redaction = { hostname: false, custom: [{ name: "rid", pattern: "R\\d+", enabled: true }] };
    settingForKey("ai.enabled", false);
    mockedInvoke.mockImplementation((_cmd: string, args: { key: string }) => {
      if (args?.key === "ai_providers") return Promise.resolve(providers);
      if (args?.key === "redaction") return Promise.resolve(redaction);
      if (args?.key === "ai.enabled") return Promise.resolve(false);
      return Promise.resolve(null);
    });
    const s = await loadAiSettings();
    expect(s.providers).toEqual(providers);
    expect(s.redaction).toEqual(redaction);
    expect(s.enabled).toBe(false);
  });

  it("maxTokens 钳制：>8192/负值/非数 → 默认", async () => {
    for (const bad of [999999, -5, 0, "x"]) {
      mockedInvoke.mockReset();
      settingForKey("ai.max_tokens", bad);
      expect((await loadAiSettings()).maxTokens).toBe(DEFAULT_MAX_TOKENS);
    }
  });

  it("单项读取失败（reject）不拖垮整体", async () => {
    mockedInvoke.mockImplementation((_cmd: string, args: { key: string }) =>
      args?.key === "redaction" ? Promise.reject(new Error("boom")) : Promise.resolve(null),
    );
    const s = await loadAiSettings();
    expect(s.redaction).toEqual({ hostname: true, custom: [] });
    expect(s.enabled).toBe(true);
  });
});

describe("apiKeySecretKey", () => {
  it("键名约定 ai.apikey.<id>", () => {
    expect(apiKeySecretKey("prov-1")).toBe("ai.apikey.prov-1");
  });
});
