// 拖拽授权类型判定（2026-10-19 用户需求：拖拽目录 → trzsz 目录递归）。
import { describe, expect, it, vi } from "vitest";
import { droppedPathsGrantKind } from "./dragGrant";

describe("droppedPathsGrantKind", () => {
  it("单目录 → dir（递归上传）", async () => {
    const probe = vi.fn(async () => true);
    expect(await droppedPathsGrantKind(["/tmp/photos"], probe)).toBe("dir");
    expect(probe).toHaveBeenCalledWith("/tmp", "photos");
  });

  it("单文件 → file", async () => {
    const probe = vi.fn(async () => false);
    expect(await droppedPathsGrantKind(["/tmp/a.txt"], probe)).toBe("file");
  });

  it("混合拖拽含目录 → dir（Grant::Dir 前缀语义对文件只授自身，安全）", async () => {
    const probe = vi.fn(async (_parent: string, name: string) => name === "dir1");
    expect(await droppedPathsGrantKind(["/tmp/a.txt", "/tmp/dir1"], probe)).toBe("dir");
  });

  it("判定抛错 → 继续下一条；全失败 → file（保守侧，不越权）", async () => {
    const probe = vi.fn(async () => {
      throw new Error("EACCES");
    });
    expect(await droppedPathsGrantKind(["/a/x", "/b/y"], probe)).toBe("file");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("尾部斜杠 / 根路径不炸", async () => {
    const probe = vi.fn(async (_p: string, name: string) => name === "x");
    expect(await droppedPathsGrantKind(["/tmp/x/"], probe)).toBe("dir");
    expect(probe).toHaveBeenCalledWith("/tmp", "x");
    probe.mockResolvedValue(false);
    expect(await droppedPathsGrantKind(["/"], probe)).toBe("file");
  });
});
