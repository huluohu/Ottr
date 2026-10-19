// 本地目录树 → 远端递归上传（2026-10-19 用户需求：文件面板支持目录/多选上传）。
//
// 分层：纯编排（本文件）与 IO（FilePanel 注入）分离——
//   * list：列本地目录（对应 local_list 命令）；
//   * mkdir：远端建目录（对应 sftp_mkdir，幂等：已存在不报错由 Rust 侧保证）；
//   * uploadFile：单文件入队（对应 TransferStore.startUpload，逐文件进度/重试）。
// 顺序：先建远端目录再传该目录下的文件（BFS）；失败不中断整树（单个失败由
// 上传队列的 failed 态承载），目录建失败则跳过该子树并计入 skipped。
//
// 安全边界：不跟随符号链接目录（list 返回 is_dir 才下钻；read_dir 的 symlink
// 由 Rust 侧按 metadata 判定——若指向目录会被当目录，故设深度上限 + 文件数
// 上限兜底成环）；上限可注入（测试收紧）。
export interface LocalDirEntryLike {
  name: string;
  is_dir: boolean;
}

export interface UploadTreeDeps {
  list: (absPath: string) => Promise<LocalDirEntryLike[]>;
  mkdir: (absRemotePath: string) => Promise<void>;
  uploadFile: (absLocalFile: string, absRemoteDir: string) => Promise<void>;
  joinLocal: (parent: string, name: string) => string;
  joinRemote: (parent: string, name: string) => string;
  onDirCreated?: (remotePath: string) => void;
}

export interface UploadTreeLimits {
  maxDepth: number;
  maxFiles: number;
}

export const UPLOAD_TREE_LIMITS: UploadTreeLimits = { maxDepth: 32, maxFiles: 20000 };

export interface UploadTreeResult {
  dirs: number;
  files: number;
  /** 超限/建目录失败的条目数（用户可见提示用）。 */
  skipped: number;
}

/**
 * 递归上传本地目录 `localDir` 到远端 `remoteParent`（远端目标 = remoteParent/目录名）。
 * 返回统计。调用方负责并发控制（本函数顺序执行，避免打爆 SFTP channel）。
 */
export async function uploadLocalTree(
  localDir: string,
  remoteParent: string,
  deps: UploadTreeDeps,
  limits: UploadTreeLimits = UPLOAD_TREE_LIMITS,
): Promise<UploadTreeResult> {
  const name = localDir.replace(/\/+$/, "").split("/").pop() ?? "";
  const result: UploadTreeResult = { dirs: 0, files: 0, skipped: 0 };
  if (!name) return result; // 根目录：拒（不应发生；防御）

  const rootRemote = deps.joinRemote(remoteParent, name);
  const queue: Array<{ abs: string; remote: string; depth: number }> = [
    { abs: localDir, remote: rootRemote, depth: 0 },
  ];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node.depth > limits.maxDepth) {
      result.skipped++;
      continue;
    }
    try {
      await deps.mkdir(node.remote);
      result.dirs++;
      deps.onDirCreated?.(node.remote);
    } catch {
      result.skipped++; // 建目录失败：整棵子树跳过（不让每个文件各失败一次）
      continue;
    }
    let entries: LocalDirEntryLike[];
    try {
      entries = await deps.list(node.abs);
    } catch {
      result.skipped++;
      continue;
    }
    for (const e of entries) {
      const abs = deps.joinLocal(node.abs, e.name);
      const remote = deps.joinRemote(node.remote, e.name);
      if (e.is_dir) {
        queue.push({ abs, remote, depth: node.depth + 1 });
      } else {
        if (result.files >= limits.maxFiles) {
          result.skipped++;
          continue;
        }
        await deps.uploadFile(abs, node.remote);
        result.files++;
      }
    }
  }
  return result;
}
