// McpSettings / McpApprovalDialog 组件测试（Phase 4 Task 3，C1）：
// * McpSettings：状态快照渲染（关/监听中）、总开关写 mcp_set_enabled、
//   授权行开关即存 upsert、read_paths 失焦保存、新增授权的安全缺省
//   （可见 + 可执行 + 逐次审批 + 空白名单）、删除回传；
// * McpApprovalDialog：ottr://mcp-approval 事件驱动出框（命令原文等宽展示）、
//   允许/拒绝经 mcp_approval_decision 回传、框随队列清空消失。
// 词典断言用中文：import 前钉住 navigator.language（i18n 实例按它初始化）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.hoisted(() => {
  Object.defineProperty(window.navigator, "language", {
    value: "zh-CN",
    configurable: true,
  });
});

type ApprovalHandler = (e: { payload: Record<string, unknown> }) => void;
let approvalHandler: ApprovalHandler | null = null;

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: ApprovalHandler) => {
    approvalHandler = handler;
    return Promise.resolve(() => {
      approvalHandler = null;
    });
  }),
}));

import "../i18n";
import { type Host, type McpGrant, type McpGrantInput, type McpStatus } from "../vault/api";
import { McpApprovalDialog, visualizeCommand } from "./McpApprovalDialog";
import { McpSettings } from "./McpSettings";

const mockedInvoke = invoke as unknown as Mock;

// 夹具只携带组件消费的列（Host/McpGrant 其余字段与断言无关，省略噪声）。
const STATUS_OFF: McpStatus = {
  enabled: false,
  listening: false,
  socket_path: null,
  approvals_pending: 0,
  grants_count: 0,
};

const STATUS_ON: McpStatus = {
  ...STATUS_OFF,
  enabled: true,
  listening: true,
  socket_path: "/Users/t/Library/Application Support/com.ottr.app/mcp.sock",
};

const HOSTS = [
  { id: 1, name: "web-1", tags: [], address: "10.0.0.1", port: 22 },
  { id: 2, name: "db-1", tags: [], address: "10.0.0.2", port: 22 },
] as unknown as Host[];

const GRANTS = [
  {
    id: 7,
    host_id: 1,
    can_list: true,
    can_exec: true,
    exec_approval: true,
    read_paths: ["/tmp"],
    created_at: 1,
    updated_at: 1,
  },
] as unknown as McpGrant[];

function seedInvoke({
  status = STATUS_OFF,
  grants = [] as McpGrant[],
  hosts = HOSTS,
} = {}) {
  let currentStatus = status;
  mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "mcp_status":
        return Promise.resolve(currentStatus);
      case "mcp_grants_list":
        return Promise.resolve(grants);
      case "hosts_list":
        return Promise.resolve(hosts);
      case "mcp_set_enabled":
        currentStatus = {
          ...currentStatus,
          enabled: !!args?.enabled,
          listening: !!args?.enabled,
          socket_path: args?.enabled
            ? "/Users/t/Library/Application Support/com.ottr.app/mcp.sock"
            : null,
        };
        return Promise.resolve(currentStatus);
      case "mcp_grants_upsert": {
        const input = (args?.input ?? {}) as McpGrantInput;
        return Promise.resolve({ id: 9, ...input, created_at: 1, updated_at: 1 });
      }
      case "mcp_grants_delete":
      case "mcp_approval_decision":
        return Promise.resolve(true);
      default:
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
    }
  });
}

function renderSettings() {
  return render(<McpSettings open />);
}

beforeEach(() => {
  mockedInvoke.mockReset();
  approvalHandler = null;
});

afterEach(() => {
  cleanup();
});

describe("McpSettings", () => {
  it("renders master switch off and stopped by default", async () => {
    seedInvoke();
    renderSettings();
    const toggle = (await screen.findByTestId("mcp-enabled-toggle")) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByTestId("mcp-listening").textContent).toContain("已停止");
    expect(screen.getByTestId("mcp-no-grants")).toBeTruthy();
  });

  it("enabling the server persists via mcp_set_enabled and shows socket path", async () => {
    seedInvoke();
    renderSettings();
    fireEvent.click(await screen.findByTestId("mcp-enabled-toggle"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_set_enabled", { enabled: true }),
    );
    // setEnabled 回传新状态 + refresh 现读 → 状态行更新为监听中 + socket 路径可见。
    await waitFor(() => expect(screen.getByTestId("mcp-listening").textContent).toContain("监听中"));
    expect(screen.getByTestId("mcp-socket-path").textContent).toContain("mcp.sock");
  });

  it("flips a grant switch into a full-shape upsert", async () => {
    seedInvoke({ status: STATUS_ON, grants: GRANTS });
    renderSettings();
    const exec = (await screen.findByTestId("mcp-can-exec-1")) as HTMLInputElement;
    expect(exec.checked).toBe(true);
    fireEvent.click(exec); // can_exec → false
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("mcp_grants_upsert", {
      input: {
        host_id: 1,
        can_list: true,
        can_exec: false,
        exec_approval: true,
        read_paths: ["/tmp"],
      },
    }));
  });

  it("saves read_paths whitelist on blur as a comma-split array", async () => {
    seedInvoke({ status: STATUS_ON, grants: GRANTS });
    renderSettings();
    const input = await screen.findByTestId("mcp-read-paths-1");
    fireEvent.change(input, { target: { value: "/var/log, /home/spike" } });
    fireEvent.blur(input);
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("mcp_grants_upsert", {
      input: {
        host_id: 1,
        can_list: true,
        can_exec: true,
        exec_approval: true,
        read_paths: ["/var/log", "/home/spike"],
      },
    }));
  });

  it("adds a grant with the secure default shape (visible + exec + approval + empty whitelist)", async () => {
    seedInvoke({ status: STATUS_ON });
    renderSettings();
    const select = await screen.findByTestId("mcp-add-select");
    fireEvent.change(select, { target: { value: "2" } });
    await waitFor(() => expect(mockedInvoke).toHaveBeenCalledWith("mcp_grants_upsert", {
      input: {
        host_id: 2,
        can_list: true,
        can_exec: true,
        exec_approval: true,
        read_paths: [],
      },
    }));
  });

  it("deletes a grant back to default-deny", async () => {
    seedInvoke({ status: STATUS_ON, grants: GRANTS });
    renderSettings();
    fireEvent.click(await screen.findByTestId("mcp-grant-delete-1"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_grants_delete", { id: 7 }),
    );
  });
});

describe("McpApprovalDialog", () => {
  function fireApproval(payload: Record<string, unknown>) {
    expect(approvalHandler).toBeTruthy();
    approvalHandler!({ payload });
  }

  it("renders on the approval event and resolves allow via the decision command", async () => {
    seedInvoke();
    render(<McpApprovalDialog />);
    await waitFor(() => expect(approvalHandler).toBeTruthy());
    fireApproval({ request_id: 42, host_id: 1, host_name: "web-1", command: "reboot -h now" });
    expect(await screen.findByTestId("mcp-approval-dialog")).toBeTruthy();
    expect(screen.getByTestId("mcp-approval-command").textContent).toBe("reboot -h now");
    fireEvent.click(screen.getByTestId("mcp-approval-allow"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_approval_decision", {
        requestId: 42,
        allow: true,
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("mcp-approval-dialog")).toBeNull());
  });

  it("resolves deny and keeps the queue for further asks", async () => {
    seedInvoke();
    render(<McpApprovalDialog />);
    await waitFor(() => expect(approvalHandler).toBeTruthy());
    fireApproval({ request_id: 1, host_id: 1, host_name: "web-1", command: "ls" });
    fireApproval({ request_id: 2, host_id: 2, host_name: "db-1", command: "id" });
    fireEvent.click(await screen.findByTestId("mcp-approval-deny"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_approval_decision", {
        requestId: 1,
        allow: false,
      }),
    );
    // 第二条审批接着呈现（队列逐条）。
    expect(screen.getByTestId("mcp-approval-command").textContent).toBe("id");
  });

  it("renders multi-line commands with visible breaks (fix 1/5 I-2)", async () => {
    seedInvoke();
    render(<McpApprovalDialog />);
    await waitFor(() => expect(approvalHandler).toBeTruthy());
    // SSH exec 内嵌换行 = 远端执行多条命令；HTML 默认折叠会把
    // "df -h\nrm -rf /" 呈现成一行——审批补偿控制失明。
    fireApproval({
      request_id: 3,
      host_id: 1,
      host_name: "web-1",
      command: "df -h\nrm -rf /",
    });
    const code = (await screen.findByTestId("mcp-approval-command")) as HTMLElement;
    // ① 控制字符显形：换行可数（⏎ 标记在原文里，不依赖 CSS 生效）。
    expect(code.textContent).toContain("⏎");
    expect(code.textContent).toContain("rm -rf /");
    expect(code.textContent).not.toBe("df -h\nrm -rf /");
    // ② pre-wrap 双保险：按真实行折显（内联样式 jsdom computedStyle 可读）。
    expect(getComputedStyle(code).whiteSpace).toBe("pre-wrap");
  });

  it("visualizeCommand marks breaks/tabs once and leaves plain text intact", () => {
    expect(visualizeCommand("a\nb")).toBe("a⏎\nb");
    expect(visualizeCommand("a\r\nb")).toBe("a␍⏎\nb");
    expect(visualizeCommand("a\rb")).toBe("a␍\nb");
    expect(visualizeCommand("a\tb")).toBe("a⇥b");
    expect(visualizeCommand("plain cmd")).toBe("plain cmd");
  });
});
