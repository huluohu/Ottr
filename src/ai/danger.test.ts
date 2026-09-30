// danger.ts 单元测试（Task 8）：多行判定、危险规则命中、分级结论。
// Task 13 接手分级后，本文件补分级回归；骨架期保证误报/漏报的基本面。
import { describe, expect, it } from "vitest";
import { assessPaste, isMultiline, scanDanger } from "./danger";

describe("isMultiline", () => {
  it("LF / CRLF / CR 均算多行", () => {
    expect(isMultiline("ls\npwd")).toBe(true);
    expect(isMultiline("ls\r\npwd")).toBe(true);
    expect(isMultiline("ls\rpwd")).toBe(true);
  });
  it("单行/空串不是多行", () => {
    expect(isMultiline("ls -la")).toBe(false);
    expect(isMultiline("")).toBe(false);
  });
});

describe("scanDanger（骨架规则面）", () => {
  it("递归强删命中 recursive-delete", () => {
    const f = scanDanger("rm -rf /tmp/x");
    expect(f.map((x) => x.kind)).toContain("recursive-delete");
  });
  it("磁盘直写命中 disk-write（dd of=/dev/…）", () => {
    const f = scanDanger("dd if=iso.img of=/dev/sda");
    expect(f.map((x) => x.kind)).toContain("disk-write");
  });
  it("fork 炸弹命中 fork-bomb", () => {
    const f = scanDanger(":(){ :|:& };:");
    expect(f.map((x) => x.kind)).toContain("fork-bomb");
  });
  it("git push --force 命中 force-push", () => {
    const f = scanDanger("git push --force origin main");
    expect(f.map((x) => x.kind)).toContain("force-push");
  });
  it("普通命令不误报", () => {
    expect(scanDanger("ls -la && tail -f app.log")).toEqual([]);
    expect(scanDanger("rm build/one-file.o")).toEqual([]);
  });
});

describe("assessPaste 分级", () => {
  it("danger > warn：多行 + 危险规则 → danger 且带 findings", () => {
    const v = assessPaste("cd /tmp\nrm -rf build");
    expect(v.level).toBe("danger");
    expect(v.multiline).toBe(true);
    expect(v.findings.length).toBeGreaterThan(0);
  });
  it("纯多行无规则 → warn", () => {
    const v = assessPaste("export A=1\nexport B=2");
    expect(v.level).toBe("warn");
    expect(v.findings).toEqual([]);
    expect(v.multiline).toBe(true);
  });
  it("单行普通命令 → none（直接放行）", () => {
    expect(assessPaste("ls -la").level).toBe("none");
  });
  it("单行危险命令也要确认（danger 不依赖多行）", () => {
    expect(assessPaste("sudo rm -rf /var/data").level).toBe("danger");
  });
});
