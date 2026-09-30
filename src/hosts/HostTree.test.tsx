// HostTree 组件测试（Task 5 Step 4）：树渲染 / 标签过滤 / 搜索防抖 / 两步删除。
// invoke 全量 mock（真后端命令已在 Task 5 接线，组件测试隔离 IPC）。
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// 组件文案走真实词典（jsdom navigator.language = en-US → 英文断言）
import "../i18n";
import { HostTree } from "./HostTree";
import { useVaultStore } from "../vault/store";
import type { Host, HostGroup } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

function makeHost(overrides: Partial<Host>): Host {
  return {
    id: 1,
    name: "web-01",
    group_id: null,
    tags: [],
    address: "10.0.0.1",
    port: 22,
    username: null,
    credential_id: null,
    jump_chain_id: null,
    encoding_override: null,
    theme_override: null,
    monitor_enabled: false,
    notes: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

const group: HostGroup = {
  id: 3,
  name: "prod-group",
  parent_id: null,
  color: null,
  created_at: 1,
  updated_at: 1,
};

const web = makeHost({ id: 1, name: "web-01", group_id: 3, tags: ["prod"], username: "deploy" });
const db = makeHost({ id: 2, name: "db-01", group_id: 3, address: "10.0.0.2" });
const solo = makeHost({ id: 4, name: "solo", group_id: null, tags: ["dev"], port: 2200 });

function seedStore() {
  useVaultStore.setState({ hosts: [web, db, solo], hostGroups: [group], loading: false, error: null });
}

function renderTree(onOpen: (host: Host) => void = vi.fn()) {
  return render(
    <HostTree
      selectedId={null}
      onSelect={vi.fn()}
      onOpen={onOpen}
      onEdit={vi.fn()}
      onAdd={vi.fn()}
      onImport={vi.fn()}
    />,
  );
}

beforeEach(() => {
  mockedInvoke.mockReset();
  seedStore();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HostTree", () => {
  it("渲染分组节与未分组节：组名/主机名/username@address:port 副标题", () => {
    renderTree();
    expect(screen.getByTestId("group-prod-group")).toBeTruthy();
    expect(screen.getByTestId("group-ungrouped")).toBeTruthy();
    expect(screen.getByText("web-01")).toBeTruthy();
    expect(screen.getByText("solo")).toBeTruthy();
    const subtitle = screen.getByText("deploy@10.0.0.1:22");
    expect(subtitle).toBeTruthy();
  });

  it("空库渲染空态提示", () => {
    useVaultStore.setState({ hosts: [], hostGroups: [] });
    renderTree();
    expect(screen.getByTestId("tree-empty").textContent).toContain("No hosts yet");
  });

  it("标签过滤（AND）：点 prod 只剩 web-01，点 All 恢复", () => {
    renderTree();
    fireEvent.click(screen.getByRole("button", { name: "prod" }));
    expect(screen.getByText("web-01")).toBeTruthy();
    expect(screen.queryByText("solo")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByText("solo")).toBeTruthy();
  });

  it("搜索防抖 200ms：未到时不出 invoke，到点发 hosts_search 并渲染结果", async () => {
    vi.useFakeTimers();
    renderTree();
    const box = screen.getByRole("searchbox");
    fireEvent.change(box, { target: { value: "web" } });

    // 防抖窗口内不发请求
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mockedInvoke).not.toHaveBeenCalledWith("hosts_search", { query: "web" });

    mockedInvoke.mockResolvedValue([web]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockedInvoke).toHaveBeenCalledWith("hosts_search", { query: "web" });
    // 搜索态只显示命中项（db-01 不在结果里）——结果替换整棵树
    await act(async () => {}); // flush 微任务让结果落地
    expect(screen.queryByText("db-01")).toBeNull();
  });

  it("双击主机行 → onOpen(host)（Task 7：开标签连接的入口；单击仍是选中）", () => {
    const onOpen = vi.fn();
    renderTree(onOpen);
    const row = screen.getByText("web-01");
    fireEvent.click(row);
    fireEvent.doubleClick(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(web);
  });

  it("两步删除：先点 ✕ 出确认，确认后发 hosts_delete", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_delete") return Promise.resolve(undefined);
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    renderTree();
    fireEvent.click(screen.getByRole("button", { name: "Delete host solo" }));
    // 确认出现且尚未删除
    expect(screen.getByText("Click again to confirm")).toBeTruthy();
    expect(mockedInvoke).not.toHaveBeenCalledWith("hosts_delete", { id: 4 });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("hosts_delete", { id: 4 }),
    );
  });

  it("新建分组：输入名称确认后发 host_groups_create", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "host_groups_create") {
        return Promise.resolve({ ...group, id: 9, name: "staging" });
      }
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    renderTree();
    fireEvent.click(screen.getByTestId("add-group"));
    fireEvent.change(screen.getByLabelText("New Group"), { target: { value: "staging" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("host_groups_create", {
        name: "staging",
        parentId: null,
        color: null,
      }),
    );
  });
});
