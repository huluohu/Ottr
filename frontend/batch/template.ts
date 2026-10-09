// snippet {{var}} 模板（Phase 3 Task 4，B6）：变量抽取 + per-host 渲染。
// 简报裁定：snippets 表（T4 Phase 1）只有 CRUD，无渲染先例（webhook 的
// renderTemplate 是 notify 域的事件变量集，语义不同源）——本任务在 batch 域
// 自带最小实现。形状与 webhook 模板一致（`{{ name }}`、\w 变量名），未知变量
// 原样保留（模板写错不吞内容，webhook 同纪律）。
//
// 渲染语义：变量表中**存在**的键一律替换（空串也替换——显式留空是用户意图）；
// 未出现在变量表的键原样保留并经 extractVars 面向表单暴露。

const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

/** 抽取模板变量名（按首现顺序去重）。 */
export function extractVars(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(VAR_RE)) {
    if (!seen.includes(m[1])) seen.push(m[1]);
  }
  return seen;
}

/** 渲染：vars 里有的键替换（含空串），没有的键原样保留。 */
export function renderSnippet(body: string, vars: Record<string, string>): string {
  return body.replace(VAR_RE, (raw, name: string) => (name in vars ? vars[name] : raw));
}
