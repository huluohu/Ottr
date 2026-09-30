// 历史命令展示/复用工具（Task 15，⌘R 面板）。
//
// CommandWatch 提取的命令文本**含提示符原文**（文本层已知限制：无法从流内
// 得知提示符宽度，见 src/terminal/CommandWatch.ts 模块文档）。历史表存原样
// 提取（保真、与 T13 同口径），消费侧需要两件事：
//   1. 列表展示：多行命令取首行（完整文本 title 提示）；
//   2. 回车插入终端：剥掉提示符前缀——**保守启发式**，宁可漏剥（用户看到
//      原样文本自行编辑）不可错剥（把命令本体撕掉）。
//
// stripPromptPrefix 的安全边界：提示符前缀必须是**行首单个无空白 token**，
// 以 `$`/`#`/`%`/`>` 之一结尾、后随空白。含空格的行首（如 `echo hello`）永不
// 命中；`a b$ c`（token 内含空格）永不命中。误伤面 = 单 token 且以提示符字符
// 结尾再跟空格的命令（如 `alias x='…' $ y` 的畸形形态），实际不可见。

/** ⌘R 面板列表展示文本：多行命令取首行（完整文本经 title 悬浮提示）。 */
export function historyPreview(command: string): string {
  const firstLine = command.split("\n", 1)[0] ?? "";
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/**
 * 保守剥离行首提示符前缀：`^token[prompt-char]\s+` 形态才剥（token 无空白，
 * prompt-char ∈ $ # % >）。
 * 命中：`root@debian:~# docker ps` → `docker ps`；`bash-5.1$ ls -la` → `ls -la`；
 *      `user@h:~$ echo $HOME` → `echo $HOME`（惰性匹配停在首个「提示符字符+
 *      空白」，命令体内的 $ 不受影响）。
 * 不命中：`echo hello`（行首含空格）、`cat > f`（`>` 前是命令动词，无 token+
 *      提示符字符+空白的形态……注意 `cat > f` 的 `>` 前是空白，正则要求
 *      token 直连提示符字符，故不命中）、无前缀的纯命令。
 * 多行命令只剥首行（续行是用户输入的延续，不在提示符内）。
 */
export function stripPromptPrefix(command: string): string {
  const lines = command.split("\n");
  lines[0] = lines[0].replace(/^\S{0,128}?[$#%>]\s+/, "");
  return lines.join("\n");
}

/** ⌘R 面板时间列：秒级 Unix → 本地短格式（HH:MM 或带日期；渲染层消费）。 */
export function historyTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
