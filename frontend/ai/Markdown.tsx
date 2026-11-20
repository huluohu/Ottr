// Markdown 渲染（2026-11-02 批次二 C 项）。
//
// **为什么不自研**：AI 回答里的强调（`**原因**`）、列表、表格、行内码是
// 常态——此前面板把它们当纯文本原样显示，星号直接怼在用户脸上。
//
// **为什么安全**：**不引入 `rehype-raw`**——react-markdown 默认**不渲染**
// markdown 里的原始 HTML（它会被丢弃，不会变成 DOM 节点），因此不存在
// 「模型返回一段 `<script>` 就执行」的面。这是有意的取舍：安全 > 完整。
//
// **代码围栏不走这里**：``` 围栏由 `DiagnosePanel` 先切出来，交给
// `CodeBlockRow`（带 danger 分级与插终端三档确认）——本组件只处理围栏
// 之外的散文部分。
//
// **懒加载**（2026-11-20 性能审计 P2）：react-markdown + remark-gfm 是重
// 依赖（micromark/mdast 解析生态，数百 KB），而 AI 面板**只在有回答时才
// 渲染**——首屏（主机库 / 终端）完全用不上。动态 import 让它不进首屏
// bundle：WKWebView 首帧只解析真正要用的代码。
import { Suspense, lazy, memo } from "react";

/**
 * markdown 渲染器（懒加载 chunk）。
 *
 * 插件（remark-gfm）随渲染器**一起**动态载入——它只在此处使用，静态引入
 * 会把它拖回首屏 bundle，抵消懒加载的收益。
 */
const MarkdownRenderer = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
  ]);
  return {
    default: function MarkdownRendererInner({ content }: { content: string }) {
      return (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // 外链一律新窗口 + noreferrer（模型给的链接不可信）。
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      );
    },
  };
});

/**
 * Markdown 文本块。
 *
 * `memo`（2026-11-20 性能审计 P3）：流式输出时每次 flush 都会重建 parts
 * 数组并重渲全部文本块——**内容未变的前文段落**此前也要重走一遍 remark
 * 解析 + AST + React 树构建。props 只有 `content`（原始字符串），memo 的
 * 浅比较足以跳过未变段落。
 */
export const MarkdownText = memo(function MarkdownText({ content }: { content: string }) {
  return (
    <div className="ai-answer-text" data-testid="ai-md">
      {/* 懒加载兜底：占位保持同尺寸，避免内容到达时布局跳动。 */}
      <Suspense fallback={<span className="ai-md-loading" aria-hidden="true" />}>
        <MarkdownRenderer content={content} />
      </Suspense>
    </div>
  );
});
