// JumpChainEditor 组件测试（Phase 2 Task 2 Step 3b）：列表渲染（链名/主机名
// 链摘要）、添加/编辑/删除（jc_create/jc_update/jc_delete + 刷新）、hop 排序
// （↑/↓ 按钮通道——拖拽的 DOM 事件在 jsdom 无布局不可靠，按钮是同一条
// moveHop 代码路径）、校验（空名/空链拒绝）、测试连接（jc_test 成功与
// 「第 N 跳失败」文案）。invoke 全量 mock（有状态后端：list 反映
// create/update/delete 效果，同 ForwardPanel.test 的 seedBackend 纪律）。
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import "../i18n";
import i18n from "../i18n";
import { JumpChainEditor } from "./JumpChainEditor";
import { useVaultStore } from "../vault/store";
import type { Host, JumpChain } from "../vault/api";

const mockedInvoke = invoke as unknown as Mock;

function host(over: Partial<Host> = {}): Host {
  return {
    id: 1,
    name: "bastion-a",
    group_id: null,
    tags: [],
    address: "10.0.0.1",
    port: 22,
    username: "spike",
    protocol: "ssh",
    credential_id: null,
    jump_chain_id: null,
    encoding_override: null,
    theme_override: null,
    monitor_enabled: false,
    notes: null,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function chain(over: Partial<JumpChain> = {}): JumpChain {
  return {
    id: 11,
    name: "office-bastions",
    hops: [1, 2],
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

/** 有状态 mock 后端：jc_list 真源随 create/update/delete 记账（编辑器每个
 * 动作后 refresh，空 mock 会被刷掉）；jc_test 可编程胜负。 */
function seedBackend(rows: JumpChain[], testImpl?: (hops: number[]) => unknown) {
  const data = rows.map((r) => ({ ...r, hops: [...r.hops] }));
  let nextId = 100;
  mockedInvoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "jc_list":
        return data.map((r) => ({ ...r, hops: [...r.hops] }));
      case "jc_create": {
        const input = args?.input as { name: string; hops: number[] };
        const created: JumpChain = {
          id: nextId++,
          name: input.name,
          hops: [...input.hops],
          created_at: 1,
          updated_at: 1,
        };
        data.push(created);
        return created;
      }
      case "jc_update": {
        const id = args?.id as number;
        const input = args?.input as { name: string; hops: number[] };
        const row = data.find((r) => r.id === id);
        if (!row) throw new Error(`jump_chain id=${id} not found`);
        row.name = input.name;
        row.hops = [...input.hops];
        return { ...row };
      }
      case "jc_delete": {
        const id = args?.id as number;
        const idx = data.findIndex((r) => r.id === id);
        if (idx === -1) throw new Error(`jump_chain id=${id} not found`);
        data.splice(idx, 1);
        return undefined;
      }
      case "jc_test":
        return testImpl?.(args?.hops as number[]) ?? { ok: true, hop: null, error: null, elapsed_ms: 42 };
      // store.refresh() 并发拉全量（Phase 2 Task 2 起含 jumpChains）——
      // 实体两表在链编辑场景返回空；hosts 返回种子（列表摘要要用主机名）。
      case "hosts_list":
        return [host(), host({ id: 2, name: "bastion-b" }), host({ id: 3, name: "prod-app" })];
      case "credentials_list":
      case "host_groups_list":
        return [];
      default:
        throw new Error(`unexpected command: ${cmd}`);
    }
  });
}

// 词典固定 zh-CN（ForwardPanel.test 同款纪律；afterEach 拧回 en-US 免跨文件污染）。
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useVaultStore.setState({
    hosts: [host(), host({ id: 2, name: "bastion-b" }), host({ id: 3, name: "prod-app" })],
  });
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  useVaultStore.setState({ hosts: [], jumpChains: [] });
  await i18n.changeLanguage("en-US");
});

describe("JumpChainEditor", () => {
  it("列表渲染：链名 + 按跳序的主机名链摘要", async () => {
    seedBackend([chain({ hops: [1, 2] }), chain({ id: 12, name: "reverse", hops: [2, 1] })]);
    render(<JumpChainEditor open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("jump-row-11")).toBeTruthy());
    expect(screen.getByText("office-bastions")).toBeTruthy();
    // 顺序显著：正向与反向链的摘要是不同文本
    expect(screen.getByTestId("jump-hops-11").textContent).toBe("bastion-a → bastion-b");
    expect(screen.getByTestId("jump-hops-12").textContent).toBe("bastion-b → bastion-a");
  });

  it("空态文案 + 添加按钮", async () => {
    seedBackend([]);
    render(<JumpChainEditor open onClose={() => {}} />);
    expect(await screen.findByTestId("jump-empty")).toBeTruthy();
    expect(screen.getByTestId("jump-add")).toBeTruthy();
  });

  it("创建：默认带一跳，改选主机与链名后保存（jc_create 载荷正确）", async () => {
    seedBackend([]);
    render(<JumpChainEditor open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("jump-add"));
    fireEvent.change(screen.getByTestId("jump-form-name"), {
      target: { value: "new-chain" },
    });
    // 表单默认一跳指向首台主机；再加一跳选 bastion-b
    fireEvent.click(screen.getByTestId("jump-add-hop"));
    const selects = screen.getAllByTestId("jump-hop-select");
    fireEvent.change(selects[1], { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("jump-form-save"));
    await waitFor(() => expect(screen.getByTestId("jump-row-100")).toBeTruthy());
    const createCall = mockedInvoke.mock.calls.find(([c]) => c === "jc_create");
    expect(createCall?.[1]).toEqual({ input: { name: "new-chain", hops: [1, 2] } });
  });

  it("校验：空名拒绝提交（不发 jc_create）；删光 hop 拒绝提交", async () => {
    seedBackend([]);
    render(<JumpChainEditor open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("jump-add"));
    fireEvent.click(screen.getByTestId("jump-form-save"));
    expect(await screen.findByTestId("jump-form-error").catch(() => null) ?? screen.getByTestId("jump-form-error")).toBeTruthy();
    expect(screen.getByTestId("jump-form-error").textContent).toContain("请填写链名");
    expect(mockedInvoke.mock.calls.some(([c]) => c === "jc_create")).toBe(false);

    // 补上名字、删光 hop → 空链校验
    fireEvent.change(screen.getByTestId("jump-form-name"), { target: { value: "x" } });
    fireEvent.click(screen.getAllByTestId("jump-hop-remove")[0]);
    fireEvent.click(screen.getByTestId("jump-form-save"));
    expect(screen.getByTestId("jump-form-error").textContent).toContain("至少需要一跳");
    expect(mockedInvoke.mock.calls.some(([c]) => c === "jc_create")).toBe(false);
  });

  it("hop 排序：↓ 交换两跳，保存经 jc_update 落新顺序（与拖拽同一 moveHop 路径）", async () => {
    seedBackend([chain()]);
    render(<JumpChainEditor open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("jump-edit-11"));
    const downs = screen.getAllByTestId("jump-hop-down");
    fireEvent.click(downs[0]); // 第 1 跳下移 → [2, 1]
    const ups = screen.getAllByTestId("jump-hop-up");
    expect(ups[1].hasAttribute("disabled")).toBe(false);
    expect(downs[1].hasAttribute("disabled")).toBe(true); // 末位 ↓ 必须禁用
    fireEvent.click(screen.getByTestId("jump-form-save"));
    await waitFor(() =>
      expect(screen.getByTestId("jump-hops-11").textContent).toBe("bastion-b → bastion-a"),
    );
    const updateCall = mockedInvoke.mock.calls.find(([c]) => c === "jc_update");
    expect(updateCall?.[1]).toEqual({ id: 11, input: { name: "office-bastions", hops: [2, 1] } });
  });

  it("删除：jc_delete + 列表刷新", async () => {
    seedBackend([chain()]);
    render(<JumpChainEditor open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("jump-delete-11"));
    await waitFor(() => expect(screen.getByTestId("jump-empty")).toBeTruthy());
    expect(mockedInvoke.mock.calls.some(([c]) => c === "jc_delete" && (c && true))).toBe(true);
  });

  it("测试连接：成功显示耗时文案；失败显示「第 N 跳失败」+ 原因（断点定位消费面）", async () => {
    seedBackend([chain()], (hops) => {
      if (hops.length === 2) {
        return { ok: false, hop: 1, error: "jump chain failed at hop 1: boom", elapsed_ms: 120 };
      }
      return { ok: true, hop: null, error: null, elapsed_ms: 800 };
    });
    render(<JumpChainEditor open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("jump-edit-11"));
    fireEvent.click(screen.getByTestId("jump-test"));
    const result = await screen.findByTestId("jump-test-result");
    expect(result.getAttribute("data-ok")).toBe("false");
    expect(result.textContent).toContain("第 2 跳失败");
    expect(result.textContent).toContain("boom");

    // 删到一跳（= 直连该主机语义）→ 成功路径
    fireEvent.click(screen.getAllByTestId("jump-hop-remove")[0]);
    fireEvent.click(screen.getByTestId("jump-test"));
    await waitFor(() => expect(screen.getByTestId("jump-test-result").getAttribute("data-ok")).toBe("true"));
    expect(screen.getByTestId("jump-test-result").textContent).toContain("连接成功");
  });
});
