// McpClientSettings 组件测试（Ottr 作为 MCP 客户端——外部 MCP server 设置面）：
// * 清单渲染（名字 / 命令 / env 变量名）+ 空态；
// * 启用开关翻转 → mcp_server_upsert（env 空 = 保留旧值）；
// * 新增表单：命令/参数/env（留空 = 保留原值 → null）→ mcp_server_upsert；
// * 删除走确认框 → mcp_server_remove；
// * 「查看工具」→ mcp_server_tools → 工具名/描述可见；
// * 「调用」→ 参数 JSON → mcp_server_call → 结果文本 + isError 标记。
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

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import { type McpServerInfo, type McpToolInfo } from "../vault/api";
import { McpClientSettings } from "./McpClientSettings";

const mockedInvoke = invoke as unknown as Mock;

const SERVERS: McpServerInfo[] = [
  {
    id: "srv-1",
    name: "文件系统",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    enabled: true,
    envNames: ["API_TOKEN"],
  },
];

const TOOLS: McpToolInfo[] = [
  {
    name: "read_file",
    description: "读取一个文件",
    inputSchema: '{"type":"object"}',
  },
  {
    name: "boom",
    description: "总是失败",
    inputSchema: '{"type":"object"}',
  },
];

function seedInvoke({
  servers = SERVERS as McpServerInfo[],
  tools = TOOLS as McpToolInfo[],
} = {}) {
  let current = servers;
  mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "mcp_servers_list":
        return Promise.resolve(current);
      case "mcp_server_upsert": {
        const input = (args?.input ?? {}) as Record<string, unknown>;
        const row: McpServerInfo = {
          id: (input.id as string) ?? "srv-new",
          name: input.name as string,
          command: input.command as string,
          args: (input.args as string[]) ?? [],
          enabled: input.enabled as boolean,
          envNames: Object.keys((input.env as Record<string, string | null>) ?? {}),
        };
        current = current.some((s) => s.id === row.id)
          ? current.map((s) => (s.id === row.id ? row : s))
          : [...current, row];
        return Promise.resolve(row);
      }
      case "mcp_server_remove": {
        const id = args?.id as string;
        current = current.filter((s) => s.id !== id);
        return Promise.resolve(undefined);
      }
      case "mcp_server_env_delete":
        return Promise.resolve(undefined);
      case "mcp_server_tools":
        return Promise.resolve(tools);
      case "mcp_server_call":
        return Promise.resolve({
          text: "hello from tool",
          isError: args?.tool === "boom",
        });
      default:
        return Promise.reject(new Error(`unexpected command: ${cmd}`));
    }
  });
}

beforeEach(() => {
  mockedInvoke.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("McpClientSettings", () => {
  it("列出已配置的 server（名字 / 命令 / env 变量名）", async () => {
    seedInvoke();
    render(<McpClientSettings />);
    const row = await screen.findByTestId("mcp-client-row-srv-1");
    expect(row.textContent).toContain("文件系统");
    expect(row.textContent).toContain("npx");
    expect(screen.getByTestId("mcp-client-env-srv-1").textContent).toContain("API_TOKEN");
    // env 值永不出库：密码框不预填任何值。
    expect(screen.queryByTestId("mcp-client-env-value-API_TOKEN")).toBeNull();
  });

  it("空态提示", async () => {
    seedInvoke({ servers: [] });
    render(<McpClientSettings />);
    expect(await screen.findByTestId("mcp-client-empty")).toBeTruthy();
  });

  it("启用开关翻转 → mcp_server_upsert（env 空 = 保留旧值）", async () => {
    seedInvoke();
    render(<McpClientSettings />);
    const toggle = (await screen.findByTestId("mcp-client-enabled-srv-1")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_server_upsert", {
        input: {
          id: "srv-1",
          name: "文件系统",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          enabled: false,
          env: {},
        },
      }),
    );
  });

  it("新增：命令/参数/env 提交（留空的 env = null = 保留原值）", async () => {
    seedInvoke({ servers: [] });
    render(<McpClientSettings />);
    fireEvent.click(await screen.findByTestId("mcp-client-add"));
    fireEvent.change(screen.getByTestId("mcp-client-form-name"), {
      target: { value: "新服务" },
    });
    fireEvent.change(screen.getByTestId("mcp-client-form-command"), {
      target: { value: "uvx" },
    });
    fireEvent.change(screen.getByTestId("mcp-client-form-args"), {
      target: { value: "mcp-server-git\n--verbose" },
    });
    // 新增一个环境变量（名 + 值）。
    fireEvent.click(screen.getByTestId("mcp-client-env-add"));
    fireEvent.change(screen.getByTestId("mcp-client-env-name-0"), {
      target: { value: "API_TOKEN" },
    });
    fireEvent.change(screen.getByTestId("mcp-client-env-value-0"), {
      target: { value: "tok" },
    });
    fireEvent.click(screen.getByTestId("mcp-client-form-save"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_server_upsert", {
        input: {
          id: null,
          name: "新服务",
          command: "uvx",
          args: ["mcp-server-git", "--verbose"],
          enabled: true,
          env: { API_TOKEN: "tok" },
        },
      }),
    );
  });

  it("编辑：env 留空提交为 null（保留旧值），填写则覆盖", async () => {
    seedInvoke();
    render(<McpClientSettings />);
    fireEvent.click(await screen.findByTestId("mcp-client-edit-srv-1"));
    // 已配置的变量名进表单，值为空（密文不回显）。
    const value = screen.getByTestId("mcp-client-env-value-0") as HTMLInputElement;
    expect(value.type).toBe("password");
    expect(value.value).toBe("");
    // 已存在的变量名只读（改名 = 删旧建新，语义由删除按钮承担）。
    const name = screen.getByTestId("mcp-client-env-name-0") as HTMLInputElement;
    expect(name.value).toBe("API_TOKEN");
    expect(name.readOnly).toBe(true);
    fireEvent.change(value, { target: { value: "new-token" } });
    fireEvent.click(screen.getByTestId("mcp-client-form-save"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_server_upsert", {
        input: {
          id: "srv-1",
          name: "文件系统",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          enabled: true,
          env: { API_TOKEN: "new-token" },
        },
      }),
    );
  });

  it("删除走确认框 → mcp_server_remove", async () => {
    seedInvoke();
    render(<McpClientSettings />);
    fireEvent.click(await screen.findByTestId("mcp-client-delete-srv-1"));
    expect(await screen.findByTestId("mcp-client-delete-dialog")).toBeTruthy();
    // 确认前不删。
    expect(mockedInvoke).not.toHaveBeenCalledWith("mcp_server_remove", { id: "srv-1" });
    fireEvent.click(screen.getByTestId("mcp-client-delete-confirm"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_server_remove", { id: "srv-1" }),
    );
  });

  it("查看工具 → mcp_server_tools → 工具名与描述可见", async () => {
    seedInvoke();
    render(<McpClientSettings />);
    fireEvent.click(await screen.findByTestId("mcp-client-tools-srv-1"));
    const tool = await screen.findByTestId("mcp-client-tool-read_file");
    expect(tool.textContent).toContain("read_file");
    expect(tool.textContent).toContain("读取一个文件");
  });

  it("调用 → 参数 JSON → mcp_server_call → 结果文本与 isError 标记", async () => {
    seedInvoke();
    render(<McpClientSettings />);
    fireEvent.click(await screen.findByTestId("mcp-client-tools-srv-1"));
    fireEvent.click(await screen.findByTestId("mcp-client-tool-call-read_file"));
    const args = screen.getByTestId("mcp-client-call-args") as HTMLTextAreaElement;
    fireEvent.change(args, { target: { value: '{"path":"/tmp"}' } });
    fireEvent.click(screen.getByTestId("mcp-client-call-run"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_server_call", {
        id: "srv-1",
        tool: "read_file",
        argsJson: '{"path":"/tmp"}',
      }),
    );
    const result = await screen.findByTestId("mcp-client-call-result");
    expect(result.textContent).toContain("hello from tool");
    expect(screen.queryByTestId("mcp-client-call-iserror")).toBeNull();
  });

  it("从清单直调：工具名留空 → 提示补全，不打后端", async () => {
    seedInvoke();
    render(<McpClientSettings />);
    fireEvent.click(await screen.findByTestId("mcp-client-call-srv-1"));
    fireEvent.click(screen.getByTestId("mcp-client-call-run"));
    expect(await screen.findByTestId("mcp-client-call-error")).toBeTruthy();
    expect(mockedInvoke).not.toHaveBeenCalledWith(
      "mcp_server_call",
      expect.anything(),
    );
    // 补上工具名后可调用。
    fireEvent.change(screen.getByTestId("mcp-client-call-tool"), {
      target: { value: "read_file" },
    });
    fireEvent.click(screen.getByTestId("mcp-client-call-run"));
    await waitFor(() =>
      expect(mockedInvoke).toHaveBeenCalledWith("mcp_server_call", {
        id: "srv-1",
        tool: "read_file",
        argsJson: "{}",
      }),
    );
  });

  it("调用失败（isError）显示失败标记", async () => {
    seedInvoke();
    render(<McpClientSettings />);
    fireEvent.click(await screen.findByTestId("mcp-client-tools-srv-1"));
    fireEvent.click(await screen.findByTestId("mcp-client-tool-call-boom"));
    fireEvent.click(screen.getByTestId("mcp-client-call-run"));
    await waitFor(() => expect(screen.getByTestId("mcp-client-call-result")).toBeTruthy());
    expect(screen.getByTestId("mcp-client-call-iserror")).toBeTruthy();
    expect(screen.getByTestId("mcp-client-call-text").textContent).toContain(
      "hello from tool",
    );
  });
});
