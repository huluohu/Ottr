// 文件面板列排版守卫（2026-10-18 P0 回归钉）：v0.9.32 起定宽列合计大于窄
// 面板宽，.file-name min-width:0 使名称列被挤没。修复 = 容器查询分级藏列
// （权限 → 时间）+ 名称列 88px 下限。本文件钉住三件事的**存在性**——
// 防未来调列宽时把守门规则删掉（dialogScroll.test 同款结构守卫口径）。
import { describe, expect, it } from "vitest";
import { allAppCss } from "./styles/all-css";

const css = allAppCss();

describe("文件面板列排版（P0 回归钉）", () => {
  it("file-pane 是尺寸容器（容器查询的作用域前提）", () => {
    expect(css).toContain("container-type: inline-size");
  });

  it("窄面板分级藏列：≤460px 藏权限列、≤350px 藏时间列", () => {
    expect(css).toContain("@container (max-width: 460px)");
    expect(css).toContain("@container (max-width: 350px)");
    // 藏列必须同时覆盖行与列头（口径一致，否则错位）
    expect(css).toContain(".file-head .file-mode");
    expect(css).toContain(".file-row .file-mode");
    expect(css).toContain(".file-head .file-mtime");
    expect(css).toContain(".file-row .file-mtime");
  });

  it("名称列有非零下限（任何宽度不归零）", () => {
    expect(css).toMatch(/\.file-name \{[^}]*min-width: 88px/s);
  });
});
