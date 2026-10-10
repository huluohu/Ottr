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
    protocol: "ssh",
    credential_id: null,
    jump_chain_id: null,
    encoding_override: null,
    theme_override: null,
    monitor_enabled: false,
    is_production: false,
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

  // UI 重构（task-7）：分组头 = 文件夹图标 + 组名；行 = 单行布局（主机名/
  // 标签/连接目标同排，连接目标右对齐灰暗）；无标签行不渲染标签容器。
  it("行制式重构：组头带描边图标，名/标签/元数据同在 .host-row 内，无标签不渲染标签容器", () => {
    renderTree();
    const groupHead = screen.getByRole("heading", { name: "prod-group" });
    // 分组头：内联 SVG 文件夹图标 + 弱化组名（aria-hidden 不吃可达名）
    expect(groupHead.querySelector("svg.tree-group-icon")).toBeTruthy();
    const ungroupedHead = screen.getByRole("heading", { name: "Ungrouped" });
    expect(ungroupedHead.querySelector("svg.tree-group-icon")).toBeTruthy();
    // 单行：host-row 内依次含 name / tags / subtitle（旧结构 subtitle 与
    // tags 是行的兄弟节点，此断言防回归两行式）
    const nameEl = screen.getByText("web-01");
    const row = nameEl.closest("button.host-row");
    expect(row).toBeTruthy();
    expect(row?.querySelector(".host-tag")).toBeTruthy();
    const subtitleInRow = row?.querySelector(".host-subtitle");
    expect(subtitleInRow?.textContent).toBe("deploy@10.0.0.1:22");
    // 元数据右对齐语义：margin-left:auto 落在 subtitle 上（jsdom 无 CSS，
    // 钉类名与同排结构；视觉面由真窗截图门把关）
    expect(subtitleInRow).toBeTruthy();
    // 无标签主机：标签容器整个不渲染（不留空壳占位）
    const dbRow = screen.getByText("db-01").closest("button.host-row");
    expect(dbRow?.querySelector(".host-tags")).toBeNull();
    // 多选外的行不渲染勾选框
    expect(row?.querySelector(".host-check")).toBeNull();
  });

  // 操作按钮收纳：编辑/删除收进 .host-actions（hover/选中/键盘聚焦显现），
  // 确认态行挂 data-confirming（CSS 显影 + 键盘可达兜底的钩子）。
  it("操作按钮收进 .host-actions 容器；确认态挂 data-confirming", () => {
    renderTree();
    const editBtn = screen.getByRole("button", { name: "Edit host web-01" });
    const deleteBtn = screen.getByRole("button", { name: "Delete host web-01" });
    const actions = editBtn.closest(".host-actions");
    expect(actions).toBeTruthy();
    expect(deleteBtn.closest(".host-actions")).toBe(actions);
    const li = editBtn.closest("li.tree-host");
    expect(li?.getAttribute("data-confirming")).toBeNull();
    fireEvent.click(deleteBtn);
    expect(screen.getByText("Click again to confirm")).toBeTruthy();
    expect(li?.getAttribute("data-confirming")).toBe("true");
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

  // BL-109 ①（Phase 5 Task 0）：空分组在默认浏览态必须渲染——「先建组再
  // 填内容」是正常用户路径，组容器不可被无主机过滤整体吞掉。
  it("空分组默认浏览态渲染（先建组后填内容路径）；有组时不出空树提示", () => {
    useVaultStore.setState({ hosts: [], hostGroups: [group] });
    renderTree();
    expect(screen.getByTestId("group-prod-group")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "prod-group" })).toBeTruthy();
    expect(screen.queryByTestId("tree-empty")).toBeNull();
  });

  // 过滤态（搜索/标签）时空分组无意义：只显示有命中的分组（裁定口径）。
  it("标签过滤态隐藏无命中分组，清除过滤后恢复", () => {
    useVaultStore.setState({ hosts: [solo], hostGroups: [group] });
    renderTree();
    expect(screen.getByTestId("group-prod-group")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "dev" }));
    expect(screen.queryByTestId("group-prod-group")).toBeNull();
    expect(screen.getByTestId("group-ungrouped")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByTestId("group-prod-group")).toBeTruthy();
  });

  // BL-109 ②（Phase 5 Task 0）：同名分组前端预校验——不发 create、行内
  // 错误可见、输入区保持打开供改名重试。
  it("同名分组创建被拒：行内错误可见且不发 host_groups_create", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    renderTree();
    fireEvent.click(screen.getByTestId("add-group"));
    fireEvent.change(screen.getByLabelText("New Group"), { target: { value: "prod-group" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await act(async () => {});
    expect(mockedInvoke).not.toHaveBeenCalledWith("host_groups_create", expect.anything());
    expect(screen.getByTestId("group-name-error").textContent).toContain("already exists");
    // 输入区保持打开，用户可直接改名重试
    expect(screen.getByLabelText("New Group")).toBeTruthy();
  });

  // 后端同名拒绝（竞态兜底）也要可见，不再静默吞掉。
  it("后端拒绝同名时行内展示失败消息", async () => {
    mockedInvoke.mockImplementation((cmd: string) => {
      if (cmd === "host_groups_create") {
        return Promise.reject(new Error('a group named "x" already exists'));
      }
      if (cmd === "hosts_list" || cmd === "credentials_list" || cmd === "host_groups_list") {
        return Promise.resolve([]);
      }
      return Promise.reject(new Error(`unexpected command: ${cmd}`));
    });
    renderTree();
    fireEvent.click(screen.getByTestId("add-group"));
    fireEvent.change(screen.getByLabelText("New Group"), { target: { value: "fresh-name" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    await waitFor(() =>
      expect(screen.getByTestId("group-name-error").textContent).toContain("already exists"),
    );
  });
});
