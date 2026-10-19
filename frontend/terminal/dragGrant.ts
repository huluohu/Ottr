// 拖拽路径的 trzsz 授权类型判定（2026-10-19 用户需求：拖拽支持目录递归）。
//
// 背景：拖拽落点只有路径字符串（无 entry 类型）；trzsz 的 dir 授权 =
// Grant::Dir（前缀语义：目录下任意深度可读，文件路径恰好只授自身）——
// 混合拖拽（文件+目录）用 dir 是安全的。判定面 = 父目录列表里同名项是否
// is_dir。判定失败（父目录不可列）按文件处理：Rust 侧目录以 file 授权会被
// 拒，属保守侧（宁可让用户改走工具栏目录上传，也不放宽授权面）。
export type PathKindProbe = (parent: string, name: string) => Promise<boolean>;

/** 任一拖拽路径是目录 → "dir"（目录递归）；否则 "file"。 */
export async function droppedPathsGrantKind(
  paths: readonly string[],
  probe: PathKindProbe,
): Promise<"dir" | "file"> {
  for (const p of paths) {
    const parent = p.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
    const name = p.replace(/\/+$/, "").split("/").pop() ?? "";
    try {
      if (await probe(parent, name)) return "dir";
    } catch {
      // 判定不了：继续下一个（全失败 → file，保守侧）
    }
  }
  return "file";
}
