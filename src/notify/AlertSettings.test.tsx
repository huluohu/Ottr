// AlertSettings 组件测试（Phase 3 Task 3，B5）：渠道/规则两区 CRUD 表单、
// 必填校验、secret 留空 = 保留现值（编辑回填纪律）、测试按钮成功/失败面、
// 保存后重挂载与引擎 reload。vaultApi 走 invoke mock；channelRegistry/rules
// 模块整体 stub（组件测试边界——适配器/引擎另有单测）。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

afterEach(cleanup);

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./channelRegistry", () => ({
  remountChannels: vi.fn(async () => {}),
  testChannel: vi.fn(async () => {}),
}));
vi.mock("./rules", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./rules")>();
  return { ...mod, engine: { reload: vi.fn(async () => {}) } };
});

import { remountChannels, testChannel } from "./channelRegistry";
import { engine } from "./rules";
import { AlertSettings } from "./AlertSettings";
import { useVaultStore } from "../vault/store";
import type { AlertRule, NotifyChannel } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

// T4 分区化：渠道/规则独占切换（SegmentedControl）——规则区用例先切分区。
function showRulesSection() {
  const switcher = screen.getByTestId("alert-section-switch");
  const rulesBtn = Array.from(switcher.querySelectorAll("button")).find(
    (b) => b.textContent === "Rules",
  );
  fireEvent.click(rulesBtn!);
}

const channelRow: NotifyChannel = {
  id: 3,
  kind: "telegram",
  template_overrides: null,
  enabled: true,
  created_at: 1,
  updated_at: 1,
};

const ruleRow: AlertRule = {
  id: 9,
  host_id: 1,
  kind: "disk",
  params: { mount: "/", threshold: 90 },
  channels: [3],
  rate_limit: 0,
  mute_window: null,
  last_fired: null,
  created_at: 1,
  updated_at: 1,
};

function seedInvoke() {
  mockedInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "nc_list":
        return [channelRow];
      case "nc_create":
        return { ...channelRow, id: 10, kind: (args!.input as { kind: string }).kind };
      case "nc_update":
        return channelRow;
      case "nc_reveal_config":
        return { bot_token: "OLD", chat_id: "-100" };
      case "nc_delete":
      case "ar_delete":
        return null;
      case "ar_list":
        return [ruleRow];
      case "ar_create":
        return { ...ruleRow, id: 11 };
      case "ar_update":
        return ruleRow;
      default:
        throw new Error(`unexpected: ${cmd}`);
    }
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
  seedInvoke();
  vi.mocked(remountChannels).mockClear();
  vi.mocked(testChannel).mockClear();
  vi.mocked(engine.reload).mockClear();
  useVaultStore.setState({
    hosts: [
      {
        id: 1, name: "web-01", group_id: null, tags: [], address: "10.0.0.1", port: 22,
        username: null, protocol: "ssh", credential_id: null, jump_chain_id: null,
        encoding_override: null, theme_override: null, monitor_enabled: true,
        is_production: false, notes: null, created_at: 1, updated_at: 1,
      },
    ],
    hostGroups: [],
    credentials: [],
    loading: false,
    error: null,
  });
});

describe("AlertSettings 渠道区", () => {
  it("open=false 不渲染；open=true 拉渠道与规则列表", async () => {
    const { rerender } = render(<AlertSettings open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("alert-settings")).toBeNull();
    rerender(<AlertSettings open={true} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("alert-channel-3")).toBeDefined());
    expect(mockedInvoke).toHaveBeenCalledWith("nc_list");
    expect(mockedInvoke).toHaveBeenCalledWith("ar_list"); // 挂载即拉两区数据
    showRulesSection(); // 规则分区独占挂载后可见
    expect(screen.getByTestId("alert-rule-9")).toBeDefined();
  });

  it("添加渠道：选类型→填字段→保存（nc_create 载荷=字段面）+ 重挂载", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("alert-add-channel"));
    fireEvent.change(screen.getByTestId("alert-channel-kind"), { target: { value: "telegram" } });
    fireEvent.change(screen.getByTestId("alert-field-bot_token"), { target: { value: "TOK" } });
    fireEvent.change(screen.getByTestId("alert-field-chat_id"), { target: { value: "-1" } });
    fireEvent.click(screen.getByTestId("alert-channel-save"));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("nc_create", {
      input: expect.objectContaining({
        kind: "telegram",
        config: { bot_token: "TOK", chat_id: "-1" },
        enabled: true,
      }),
    }));
    expect(remountChannels).toHaveBeenCalled();
    expect(screen.queryByTestId("alert-channel-form")).toBeNull(); // 表单收起
  });

  it("必填校验：缺字段保存报错且不落库", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("alert-add-channel"));
    fireEvent.change(screen.getByTestId("alert-channel-kind"), { target: { value: "telegram" } });
    fireEvent.click(screen.getByTestId("alert-channel-save"));
    await waitFor(() => expect(screen.getByTestId("alert-form-error")).toBeDefined());
    expect(mockedInvoke).not.toHaveBeenCalledWith("nc_create", expect.anything());
  });

  it("编辑渠道：secret 不回显、留空保存 = 保留原值；非 secret 字段可改", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("alert-channel-edit-3"));
    await waitFor(() => {
      const token = screen.getByTestId("alert-field-bot_token") as HTMLInputElement;
      expect(token.value).toBe(""); // 明文不回显
    });
    expect((screen.getByTestId("alert-field-chat_id") as HTMLInputElement).value).toBe("-100");
    fireEvent.click(screen.getByTestId("alert-channel-save"));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("nc_update", {
      id: 3,
      patch: expect.objectContaining({
        kind: "telegram",
        config: { bot_token: "OLD", chat_id: "-100" }, // 留空回填原值
      }),
    }));
  });

  it("发送测试：真发成功 ✓ / 失败 ✗（错误原文上屏）", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    vi.mocked(testChannel).mockResolvedValueOnce(undefined);
    fireEvent.click(await screen.findByTestId("alert-channel-test-3"));
    const okRow = await screen.findByTestId("alert-channel-result-3");
    await waitFor(() => expect(okRow.textContent).toContain("✓"));
    vi.mocked(testChannel).mockRejectedValueOnce(new Error("HTTP 401: bad token"));
    fireEvent.click(screen.getByTestId("alert-channel-test-3"));
    const row = await screen.findByTestId("alert-channel-result-3");
    await waitFor(() => {
      expect(row.textContent).toContain("✗");
      expect(row.textContent).toContain("HTTP 401");
    });
    expect(testChannel).toHaveBeenCalledWith("telegram", { bot_token: "OLD", chat_id: "-100" });
  });

  it("删除渠道：nc_delete + 重挂载", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("alert-channel-delete-3"));
    await waitFor(() => expect(remountChannels).toHaveBeenCalled());
    expect(mockedInvoke).toHaveBeenCalledWith("nc_delete", { id: 3 });
  });
});

// T4 分区化：本组用例先切到规则分区（showRulesSection）再操作。
describe("AlertSettings 规则区", () => {
  it("添加规则：主机/类型/参数/渠道多选→保存（ar_create）+ 引擎 reload", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    showRulesSection();
    fireEvent.click(await screen.findByTestId("alert-add-rule"));
    fireEvent.change(screen.getByTestId("alert-rule-host"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("alert-rule-kind"), { target: { value: "cpu" } });
    fireEvent.change(screen.getByTestId("alert-rule-cpu-threshold"), { target: { value: "85" } });
    fireEvent.change(screen.getByTestId("alert-rule-consecutive"), { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("alert-rule-channel-3"));
    fireEvent.click(screen.getByTestId("alert-rule-save"));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("ar_create", {
      input: expect.objectContaining({
        host_id: 1,
        kind: "cpu",
        params: { threshold: 85, consecutive: 3 },
        channels: [3],
      }),
    }));
    expect(engine.reload).toHaveBeenCalled();
  });

  it("主机必选：不选保存报错", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    showRulesSection();
    fireEvent.click(await screen.findByTestId("alert-add-rule"));
    fireEvent.click(screen.getByTestId("alert-rule-save"));
    expect(await screen.findByTestId("alert-form-error")).toBeDefined();
    expect(mockedInvoke).not.toHaveBeenCalledWith("ar_create", expect.anything());
  });

  it("静音窗与 rate_limit 透传（空静音窗 → null）", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    showRulesSection();
    fireEvent.click(await screen.findByTestId("alert-add-rule"));
    fireEvent.change(screen.getByTestId("alert-rule-host"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("alert-rule-ratelimit"), { target: { value: "300" } });
    fireEvent.change(screen.getByTestId("alert-rule-mutewindow"), { target: { value: "22:00-08:00" } });
    fireEvent.click(screen.getByTestId("alert-rule-save"));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("ar_create", {
      input: expect.objectContaining({ rate_limit: 300, mute_window: "22:00-08:00" }),
    }));
  });

  it("删除规则：ar_delete + 引擎 reload", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    showRulesSection();
    fireEvent.click(await screen.findByTestId("alert-rule-delete-9"));
    await waitFor(() => expect(engine.reload).toHaveBeenCalled());
    expect(mockedInvoke).toHaveBeenCalledWith("ar_delete", { id: 9 });
  });

  it("log 规则（Phase 4 T2 解禁）：类型可选 + 路径/关键字/间隔表单 → ar_create 载荷", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    showRulesSection();
    fireEvent.click(await screen.findByTestId("alert-add-rule"));
    fireEvent.change(screen.getByTestId("alert-rule-host"), { target: { value: "1" } });
    const kindSelect = screen.getByTestId("alert-rule-kind") as HTMLSelectElement;
    const logOption = Array.from(kindSelect.options).find((o) => o.value === "log");
    expect(logOption?.disabled).toBe(false); // 解禁：log 不再置灰
    fireEvent.change(kindSelect, { target: { value: "log" } });
    fireEvent.change(screen.getByTestId("alert-rule-log-path"), { target: { value: "/var/log/app.log" } });
    fireEvent.change(screen.getByTestId("alert-rule-log-pattern"), { target: { value: "FATAL|OOM" } });
    fireEvent.change(screen.getByTestId("alert-rule-log-interval"), { target: { value: "15" } });
    fireEvent.click(screen.getByTestId("alert-rule-channel-3"));
    fireEvent.click(screen.getByTestId("alert-rule-save"));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("ar_create", {
      input: expect.objectContaining({
        host_id: 1,
        kind: "log",
        params: { path: "/var/log/app.log", pattern: "FATAL|OOM", interval_secs: 15 },
        channels: [3],
      }),
    }));
  });

  it("log 规则校验：非法正则/越白名单路径报错不落库；间隔下限收敛 5", async () => {
    render(<AlertSettings open={true} onClose={() => {}} />);
    showRulesSection();
    fireEvent.click(await screen.findByTestId("alert-add-rule"));
    fireEvent.change(screen.getByTestId("alert-rule-host"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("alert-rule-kind"), { target: { value: "log" } });
    fireEvent.change(screen.getByTestId("alert-rule-log-path"), { target: { value: "/var/log/a b.log" } });
    fireEvent.change(screen.getByTestId("alert-rule-log-pattern"), { target: { value: "FATAL" } });
    fireEvent.click(screen.getByTestId("alert-rule-save"));
    expect(await screen.findByTestId("alert-form-error")).toBeDefined();
    expect(mockedInvoke).not.toHaveBeenCalledWith("ar_create", expect.anything());

    fireEvent.change(screen.getByTestId("alert-rule-log-path"), { target: { value: "/var/log/app.log" } });
    fireEvent.change(screen.getByTestId("alert-rule-log-pattern"), { target: { value: "(bad" } });
    fireEvent.click(screen.getByTestId("alert-rule-save"));
    expect(await screen.findByTestId("alert-form-error")).toBeDefined();
    expect(mockedInvoke).not.toHaveBeenCalledWith("ar_create", expect.anything());

    fireEvent.change(screen.getByTestId("alert-rule-log-pattern"), { target: { value: "FATAL" } });
    fireEvent.change(screen.getByTestId("alert-rule-log-interval"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("alert-rule-save"));
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("ar_create", {
      input: expect.objectContaining({
        kind: "log",
        params: { path: "/var/log/app.log", pattern: "FATAL", interval_secs: 5 },
      }),
    }));
  });
});

describe("AlertSettings 收尾", () => {
  it("关闭回调", async () => {
    const onClose = vi.fn();
    render(<AlertSettings open={true} onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("alert-settings-close"));
    expect(onClose).toHaveBeenCalled();
    cleanup();
  });
});
