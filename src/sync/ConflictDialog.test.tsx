// ConflictDialog 组件测试（Phase 5 Task 4）：逐分类冲突裁定。
// 红线（计划宪法，专测钉死）：**任何「保留云端」裁定在应用前必须明示将被
// 覆盖的本机值**——选中「保留云端」即出现该分类的本机数据清单（覆盖预告），
// 应用按钮与之独立；未选中时不出现。另有：全选快捷、未裁定完禁用应用、
// 裁定映射精确、条目摘要（自然键投影的人类可读面）。
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(window.navigator, "language", {
    value: "zh-CN",
    configurable: true,
  });
});

import "../i18n";
import { SYNC_CATEGORIES, canonicalEntries, type CategoryConflict, type SyncData } from "./engine";
import { ConflictDialog, entrySummaries } from "./ConflictDialog";

function dataWith(cat: string, rows: unknown[]): SyncData {
  const categories = {} as SyncData["categories"];
  for (const c of SYNC_CATEGORIES) categories[c] = c === cat ? rows : [];
  return { version: 1, categories };
}

const CONFLICTS: CategoryConflict[] = [
  { category: "hosts", local_count: 2, remote_count: 1, local_fp: "a", remote_fp: "b" },
  { category: "settings", local_count: 3, remote_count: 3, local_fp: "c", remote_fp: "d" },
];

const LOCAL = dataWith("hosts", [
  { id: 1, name: "prod-db", address: "10.0.0.1", port: 22 },
  { id: 2, name: "prod-web", address: "10.0.0.2", port: 2222 },
]);
const REMOTE = dataWith("hosts", [{ id: 77, name: "prod-db", address: "10.0.0.1", port: 22 }]);

function renderDialog(overrides: Partial<Parameters<typeof ConflictDialog>[0]> = {}) {
  const onApply = vi.fn();
  render(
    <ConflictDialog
      conflicts={CONFLICTS}
      localData={LOCAL}
      remoteData={REMOTE}
      busy={false}
      onApply={onApply}
      {...overrides}
    />,
  );
  return { onApply };
}

afterEach(() => {
  cleanup();
});

describe("ConflictDialog", () => {
  it("逐分类渲染冲突行：双侧条数 + 本机/云端对照摘要", () => {
    renderDialog();
    const row = screen.getByTestId("conflict-row-hosts");
    expect(row.textContent).toContain("主机");
    expect(row.textContent).toContain("2");
    expect(row.textContent).toContain("1");
    // 对照面：本机两条（含地址摘要）与云端一条
    expect(screen.getByTestId("local-entries-hosts").textContent).toContain("prod-db (10.0.0.1:22)");
    expect(screen.getByTestId("local-entries-hosts").textContent).toContain("prod-web (10.0.0.2:2222)");
    expect(screen.getByTestId("cloud-entries-hosts").textContent).toContain("prod-db (10.0.0.1:22)");
    expect(screen.getByTestId("cloud-entries-hosts").textContent).not.toContain("prod-web");
  });

  it("红线钉死：应用前未裁定 → 应用禁用；全选本机 → 无覆盖预告；全选云端 → 每个分类先亮出本机将被覆盖清单", () => {
    const { onApply } = renderDialog();
    // 未裁定：禁用
    const apply = screen.getByTestId("conflict-apply") as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(screen.queryByTestId("overwrite-disclosure-hosts")).toBeNull();

    // 全选本机：可应用，无任何覆盖预告
    fireEvent.click(screen.getByTestId("conflict-all-local"));
    expect(apply.disabled).toBe(false);
    expect(screen.queryByTestId("overwrite-disclosure-hosts")).toBeNull();
    expect(screen.queryByTestId("overwrite-disclosure-settings")).toBeNull();

    // 全选云端：覆盖预告先于应用出现（红线），列出本机条目
    fireEvent.click(screen.getByTestId("conflict-all-cloud"));
    const d1 = screen.getByTestId("overwrite-disclosure-hosts");
    expect(d1.textContent).toContain("prod-web (10.0.0.2:2222)"); // 云端没有的本机条目
    expect(screen.getByTestId("overwrite-disclosure-settings")).toBeTruthy();
    expect(apply.disabled).toBe(false);

    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith({ hosts: "cloud", settings: "cloud" });
  });

  it("单分类裁定：保留云端仅该分类出预告；混合裁定映射精确", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByTestId("keep-cloud-hosts"));
    expect(screen.getByTestId("overwrite-disclosure-hosts")).toBeTruthy();
    expect(screen.queryByTestId("overwrite-disclosure-settings")).toBeNull();

    fireEvent.click(screen.getByTestId("keep-local-settings"));
    fireEvent.click(screen.getByTestId("conflict-apply"));
    expect(onApply).toHaveBeenCalledWith({ hosts: "cloud", settings: "local" });
  });

  it("裁定可改：cloud→local 预告随之消失；busy 时全控件禁用", () => {
    const { onApply } = renderDialog();
    fireEvent.click(screen.getByTestId("keep-cloud-hosts"));
    expect(screen.getByTestId("overwrite-disclosure-hosts")).toBeTruthy();
    fireEvent.click(screen.getByTestId("keep-local-hosts"));
    expect(screen.queryByTestId("overwrite-disclosure-hosts")).toBeNull();
    void onApply;

    cleanup();
    renderDialog({ busy: true });
    expect((screen.getByTestId("conflict-all-cloud") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("conflict-apply") as HTMLButtonElement).disabled).toBe(true);
  });

  it("条目超 8 条截断计数；entrySummaries 投影形状", () => {
    const many = dataWith("settings", Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, value: i })));
    const { onApply } = renderDialog({
      conflicts: [{ category: "settings", local_count: 11, remote_count: 1, local_fp: "a", remote_fp: "b" }],
      localData: many,
      remoteData: dataWith("settings", [{ key: "k0", value: 0 }]),
    });
    expect(screen.getByTestId("local-entries-settings").textContent).toContain("…等 3 条");
    void onApply;

    // 投影形状抽查：alert_rules 摘要 = kind → host 自然键
    const rules = dataWith("alert_rules", [
      { id: 5, host_id: 9, kind: "cpu", params: {}, channels: [], rate_limit: null, mute_window: null },
    ]);
    const hosts = dataWith("hosts", [{ id: 9, name: "h1", address: "1.1.1.1", port: 22 }]);
    const merged = {
      version: 1,
      categories: { ...many.categories, alert_rules: rules.categories.alert_rules, hosts: hosts.categories.hosts },
    };
    expect(entrySummaries("alert_rules", merged)).toEqual(["cpu → h1 (1.1.1.1:22)"]);
    expect(entrySummaries("settings", many)).toContain("k0");
    // canonicalEntries 面兜底：解析失败的投影不炸
    expect(entrySummaries("hosts", LOCAL).length).toBe(2);
    void canonicalEntries;
  });

  it("credentials 摘要（fix round 1 Minor-1）：kind + key_pub 前缀指纹（无 key_pub → updated_at 日期）；secret 永不入摘要", () => {
    const creds = dataWith("credentials", [
      {
        id: 3,
        kind: "key",
        key_pub: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI… me@host",
        secret: "TOPSECRET-VALUE",
        passphrase: null,
        totp_secret: null,
        created_at: 1_700_000_000,
        updated_at: 1_700_000_001,
      },
      {
        id: 4,
        kind: "password",
        key_pub: null,
        secret: "hunter2",
        passphrase: null,
        totp_secret: null,
        created_at: 1_700_000_000,
        updated_at: 1_700_864_100,
      },
    ]);
    const summaries = entrySummaries("credentials", creds);
    expect(summaries[0]).toBe("key · ssh-ed25519 ");
    expect(summaries[1]).toBe("password · 2023-11-24");
    const printed = summaries.join("\n");
    expect(printed).not.toContain("TOPSECRET");
    expect(printed).not.toContain("hunter2");
  });
});
