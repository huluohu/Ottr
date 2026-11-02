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
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MarkdownText({ content }: { content: string }) {
  return (
    <div className="ai-answer-text" data-testid="ai-md">
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
    </div>
  );
}
