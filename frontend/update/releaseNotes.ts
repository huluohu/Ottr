// 发布说明解析（2026-10-26 图标轨更新面板）：latest.json 的 notes 字段自
// 1.5.9 起由清单脚本嵌入 docs/release-notes/<tag>.md 正文（markdown），面板
// 要把它排成可读的块——但面板**不渲染 HTML**（无注入面），所以只做极简
// 结构解析：标题 / 列表项 / 段落，行内标记（**粗体**、`代码`、[文本](链接)）
// 一律剥成纯文本。旧清单的 notes 只有占位行「Ottr x.y.z」，视为没有说明。
export type NoteBlock =
  | { kind: "heading"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "para"; text: string };

/** 行内 markdown 标记剥离：链接只留文本，粗体/斜体/代码去包裹符。 */
export function stripInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

/** 清单脚本的占位说明（「Ottr 1.5.8」）= 没有真正的发布说明。 */
export function isPlaceholderNotes(body: string | null | undefined, version: string): boolean {
  if (!body) return true;
  return body.trim() === `Ottr ${version}`;
}

/** 把发布说明拆成块；占位/空说明 → 空数组（面板不渲染说明区）。 */
export function parseReleaseNotes(body: string | null | undefined, version: string): NoteBlock[] {
  if (isPlaceholderNotes(body, version)) return [];
  const blocks: NoteBlock[] = [];
  for (const raw of (body as string).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", text: stripInline(heading[1]) });
      continue;
    }
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: "bullet", text: stripInline(bullet[1]) });
      continue;
    }
    blocks.push({ kind: "para", text: stripInline(line) });
  }
  return blocks;
}
