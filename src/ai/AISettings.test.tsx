// AISettings 组件测试（T13）：provider CRUD（key 走 secrets）、测试连接、
// 脱敏配置（hostname 开关 + 自定义规则正则预检）、通用开关。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
// 测试连接的端点侧：fetch mock（openai 兼容面非流式一发）
vi.stubGlobal(
  "fetch",
  vi.fn().mockResolvedValue(new Response('{"choices":[{"message":{"content":"pong"}}]}')),
);

import i18n from "../i18n";
import { AISettings } from "./AISettings";

const mockedInvoke = invoke as unknown as Mock;

const EXISTING = [
  {
    id: "p1",
    name: "DeepSeek",
    kind: "openai-compatible",
    baseURL: "https://api.deepseek.com",
    model: "deepseek-chat",
  },
];

function backendInvoke(cmd: string, args?: { key?: string }) {
  switch (cmd) {
    case "settings_get":
      if (args?.key === "ai_providers") return Promise.resolve(EXISTING);
      if (args?.key === "ai.enabled") return Promise.resolve(true);
      if (args?.key === "redaction")
        return Promise.resolve({ hostname: true, custom: [] });
      if (args?.key === "ai.max_tokens") return Promise.resolve(1024);
      return Promise.resolve(null);
    case "secret_get":
      return Promise.resolve("sk-saved");
    case "secret_contains":
      return Promise.resolve(true);
    case "secret_set":
    case "secret_delete":
    case "settings_set":
      return Promise.resolve(null);
    default:
      return Promise.resolve(null);
  }
}

function mockBackend() {
  mockedInvoke.mockImplementation(backendInvoke);
}

afterEach(() => cleanup());
beforeEach(async () => {
  mockedInvoke.mockReset();
  await i18n.changeLanguage("zh-CN");
  mockBackend();
});

describe("provider 列表与 CRUD", () => {
  it("打开时载入 provider 列表（默认徽标在首项）", async () => {
    render(<AISettings open onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("ai-provider-p1")).toBeTruthy();
    });
    expect(screen.getByTestId("ai-provider-p1").textContent).toContain("默认");
    expect(screen.getByTestId("ai-provider-p1").textContent).toContain("deepseek-chat");
  });

  it("mock kind provider 卡带「测试用」徽标；真实 kind 无徽标（批次三 T3，审计 16）", async () => {
    mockedInvoke.mockImplementation((cmd: string, args?: { key?: string }) => {
      if (cmd === "settings_get" && args?.key === "ai_providers") {
        return Promise.resolve([
          ...EXISTING,
          {
            id: "pm",
            name: "本地 Mock",
            kind: "mock",
            baseURL: "http://127.0.0.1:8080/v1",
            model: "mock-model",
          },
        ]);
      }
      return backendInvoke(cmd, args);
    });
    render(<AISettings open onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByTestId("ai-provider-pm")).toBeTruthy();
    });
    expect(screen.getByTestId("ai-mock-badge-pm").textContent).toBe("测试用");
    // kind 摘要行显示 Mock（非「OpenAI 兼容」）
    expect(screen.getByTestId("ai-provider-pm").textContent).toContain("Mock · mock-model");
    // 真实 provider 无徽标
    expect(screen.queryByTestId("ai-mock-badge-p1")).toBeNull();
  });

  it("表单 kind 选 Mock：不自动填 baseURL（测试端点地址显式给）", async () => {
    render(<AISettings open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("ai-add-provider"));
    fireEvent.change(screen.getByTestId("ai-field-kind"), { target: { value: "mock" } });
    expect((screen.getByTestId("ai-field-baseurl") as HTMLInputElement).value).toBe("");
    // 对照：切回 openai 兼容自动填官方端点（既有行为不回归）
    fireEvent.change(screen.getByTestId("ai-field-kind"), {
      target: { value: "openai-compatible" },
    });
    expect((screen.getByTestId("ai-field-baseurl") as HTMLInputElement).value).not.toBe("");
  });

  it("新增 provider（填 key）→ settings_set 全量 + secret_set 密封", async () => {
    render(<AISettings open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("ai-add-provider"));
    fireEvent.change(screen.getByTestId("ai-field-name"), { target: { value: "Ollama 本地" } });
    fireEvent.click(screen.getByTestId("ai-preset-ollama"));
    fireEvent.change(screen.getByTestId("ai-field-model"), { target: { value: "qwen2.5:7b" } });
    fireEvent.change(screen.getByTestId("ai-field-apikey"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByTestId("ai-form-save"));
    await waitFor(() => {
      const setCall = mockedInvoke.mock.calls.find(([c]) => c === "settings_set");
      expect(setCall?.[1].value).toHaveLength(2);
      expect(setCall?.[1].value[1]).toMatchObject({ name: "Ollama 本地", baseURL: "http://localhost:11434/v1" });
    });
    const secretCall = mockedInvoke.mock.calls.find(([c]) => c === "secret_set");
    expect(secretCall?.[1].value).toBe("sk-new");
    expect(String(secretCall?.[1].key)).toMatch(/^ai\.apikey\.prov-/);
  });

  it("删除 provider → 列表移除 + secret_delete（防孤儿密文）", async () => {
    render(<AISettings open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("ai-provider-delete-p1"));
    await waitFor(() => {
      const setCall = mockedInvoke.mock.calls.find(([c]) => c === "settings_set");
      expect(setCall?.[1].value).toHaveLength(0);
    });
    expect(mockedInvoke.mock.calls.some(([c]) => c === "secret_delete")).toBe(true);
  });

  it("测试连接：secret 出库 + 非流式一发成功展示回文", async () => {
    render(<AISettings open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("ai-provider-test-p1"));
    await waitFor(() => {
      expect(screen.getByTestId("ai-test-result-p1").textContent).toContain("pong");
    });
    expect(mockedInvoke.mock.calls.some(([c]) => c === "secret_get")).toBe(true);
    const body = JSON.parse((fetch as Mock).mock.calls[0][1].body);
    expect(body.stream).toBe(false);
  });

  it("测试连接失败：错误消息原样展示", async () => {
    (fetch as Mock).mockResolvedValueOnce(
      new Response('{"error":{"message":"bad key"}}', { status: 401 }),
    );
    render(<AISettings open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("ai-provider-test-p1"));
    await waitFor(() => {
      expect(screen.getByTestId("ai-test-result-p1").textContent).toContain("bad key");
    });
  });
});

describe("脱敏配置", () => {
  it("hostname 开关 → redaction 落库", async () => {
    render(<AISettings open onClose={() => {}} />);
    const box = (await screen.findByTestId("ai-redact-hostname")) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => {
      const call = mockedInvoke.mock.calls.find(
        ([c, a]) => c === "settings_set" && (a as { key?: string })?.key === "redaction",
      );
      expect(call?.[1].value).toMatchObject({ hostname: false });
    });
  });

  it("自定义规则：合法正则入库", async () => {
    render(<AISettings open onClose={() => {}} />);
    fireEvent.change(await screen.findByTestId("ai-rule-name"), { target: { value: "order_id" } });
    fireEvent.change(screen.getByTestId("ai-rule-pattern"), { target: { value: "OTTR-\\d{6}" } });
    fireEvent.click(screen.getByTestId("ai-rule-add"));
    await waitFor(() => {
      const call = mockedInvoke.mock.calls.find(
        ([c, a]) => c === "settings_set" && (a as { key?: string })?.key === "redaction",
      );
      expect(call?.[1].value.custom).toHaveLength(1);
      expect(call?.[1].value.custom[0]).toMatchObject({ name: "order_id" });
    });
    expect(screen.getByTestId("ai-rule-0")).toBeTruthy();
  });

  it("非法正则：显式报错不落库", async () => {
    render(<AISettings open onClose={() => {}} />);
    fireEvent.change(await screen.findByTestId("ai-rule-name"), { target: { value: "bad" } });
    fireEvent.change(screen.getByTestId("ai-rule-pattern"), { target: { value: "([unclosed" } });
    fireEvent.click(screen.getByTestId("ai-rule-add"));
    expect(await screen.findByTestId("ai-settings-error")).toBeTruthy();
    expect(
      mockedInvoke.mock.calls.some(
        ([c, a]) => c === "settings_set" && (a as { key?: string })?.key === "redaction",
      ),
    ).toBe(false);
  });

  it("规则删除", async () => {
    render(<AISettings open onClose={() => {}} />);
    fireEvent.change(await screen.findByTestId("ai-rule-name"), { target: { value: "r1" } });
    fireEvent.change(screen.getByTestId("ai-rule-pattern"), { target: { value: "x+" } });
    fireEvent.click(screen.getByTestId("ai-rule-add"));
    await screen.findByTestId("ai-rule-0");
    fireEvent.click(screen.getByTestId("ai-rule-delete-0"));
    await waitFor(() => {
      expect(screen.queryByTestId("ai-rule-0")).toBeNull();
    });
  });
});

describe("通用", () => {
  it("ai.enabled 开关落库", async () => {
    render(<AISettings open onClose={() => {}} />);
    const box = (await screen.findByTestId("ai-enabled")) as HTMLInputElement;
    fireEvent.click(box);
    await waitFor(() => {
      const call = mockedInvoke.mock.calls.find(
        ([c, a]) => c === "settings_set" && (a as { key?: string })?.key === "ai.enabled",
      );
      expect(call?.[1].value).toBe(false);
    });
  });

  it("关闭（open=false）不渲染", () => {
    const { container } = render(<AISettings open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
