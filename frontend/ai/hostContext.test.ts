// AI 备忘注入（2026-11-02 批次一 A 项）：主机「备注」作为上下文注入 AI 链。
//
// 三条钉死的语义：
// 1. **脱敏**：备忘是持久化在 vault 的数据，不是用户当前输入——必须过脱敏
//    引擎（与命令/输出尾同规则集）。内网地址、主机名、密码片段极易手写其中。
// 2. **长度上限**：备忘进 prompt 直接抬高 token 成本（BYOK 用户自掏腰包），
//    无上限等于让用户用备注页烧额度。
// 3. **失败不阻断**：取备注失败（主机已删 / IPC 错 / 无备注）一律回落「无备忘
//    段」，备忘是增强项而非前置条件。
import { describe, it, expect } from "vitest";
import { buildHostContextBlock, HOST_CONTEXT_MAX_CHARS } from "./hostContext";

describe("buildHostContextBlock", () => {
  it("空备注 → 无注入块（不产出空段噪声）", () => {
    expect(buildHostContextBlock(null, { hostname: true, custom: [] }).text).toBe("");
    expect(buildHostContextBlock(undefined, { hostname: true, custom: [] }).text).toBe("");
    expect(buildHostContextBlock("   \n\t ", { hostname: true, custom: [] }).text).toBe("");
  });

  it("有备注 → 产出注入块文本并携带脱敏命中", () => {
    const res = buildHostContextBlock(
      "Ubuntu 22.04，systemd 管理，nginx 日志在 /var/log/nginx/error.log，内网地址 10.0.0.5",
      { hostname: true, custom: [] },
    );
    expect(res.text).toContain("Ubuntu 22.04");
    expect(res.text).toContain("/var/log/nginx/error.log");
    // 内网 IP 命中默认脱敏规则 → 出现占位符而非原值
    expect(res.text).not.toContain("10.0.0.5");
    expect(res.text).toContain("[REDACTED_");
    expect(res.findings.length).toBeGreaterThan(0);
  });

  it("超长备注被截断到上限", () => {
    const long = "x".repeat(HOST_CONTEXT_MAX_CHARS * 3);
    const res = buildHostContextBlock(long, { hostname: true, custom: [] });
    expect(res.text.length).toBeLessThanOrEqual(HOST_CONTEXT_MAX_CHARS + 64);
  });

  it("截断在字符边界且标注被截断", () => {
    const long = "y".repeat(HOST_CONTEXT_MAX_CHARS + 500);
    const res = buildHostContextBlock(long, { hostname: true, custom: [] });
    expect(res.text).toContain("…");
  });

  it("脱敏关闭时原样输出（尊重用户设置）", () => {
    const res = buildHostContextBlock("密码 hunter2 在 /etc/secret", {
      hostname: true,
      custom: [],
      enabled: false,
    });
    expect(res.text).toContain("hunter2");
    expect(res.findings).toEqual([]);
  });
});
