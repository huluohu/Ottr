#!/usr/bin/env python3
"""真机 E2E 夹具：OpenAI 兼容的 mock AI 端点（SSE 流式）。

用途：在 192.168.9.102 上给 Ottr 的 AI 诊断/多轮追问链提供一个可控端点——
不需要真实模型、不出网、答案固定且含 Markdown（验证 Markdown 渲染面）。

行为：
* POST /v1/chat/completions → SSE 分帧回一段 Markdown 答案；
* 第 1 轮与第 2 轮答案不同（便于肉眼区分多轮是否真的发了第二遍）；
* 每次请求把 model / messages 落盘到 --log，便于断言「追问轮带上了历史」。

用法：
    python3 mock-ai-server.py --port 18081 --log /tmp/mock-ai.log
"""
import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ANSWERS = [
    # 第 1 轮
    "**原因**：根分区使用率 92%，已越过 90% 阈值。\n\n"
    "排查建议：\n\n"
    "1. 找大文件：`du -sh /* 2>/dev/null | sort -h | tail`\n"
    "2. 清旧日志：`journalctl --vacuum-size=200M`\n"
    "3. 确认增长源：`df -h --output=source,target,pcent /`\n\n"
    "```bash\ndf -h /\n```\n\n"
    "> 建议先定位再删，别直接清 /var。\n",
    # 第 2 轮（追问轮）
    "**补充**：先别删日志——用 `truncate -s 0` 清空比 `rm` 安全，还能留着 inode。\n\n"
    "- 保留文件：`truncate -s 0 /var/log/app.log`\n"
    "- 归档后清：`journalctl --rotate && journalctl --vacuum-time=7d`\n\n"
    "```bash\njournalctl --disk-usage\n```\n",
]

state = {"n": 0, "tool": None}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静音 stderr 访问日志
        pass

    def do_POST(self):
        if not self.path.endswith("/chat/completions"):
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw)
        except Exception:
            body = {}

        idx = state["n"]
        state["n"] += 1
        answer = ANSWERS[min(idx, len(ANSWERS) - 1)]

        with open(self.server.log_path, "a", encoding="utf-8") as f:
            f.write(
                json.dumps(
                    {
                        "seq": idx,
                        "ts": time.time(),
                        "model": body.get("model"),
                        "messages": body.get("messages"),
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def emit(payload: str):
            data = payload.encode("utf-8")
            self.wfile.write(b"%x\r\n" % len(data) + data + b"\r\n")
            self.wfile.flush()

        # 工具调用轮（2026-11-04 真机取证用）：--tool-call 指定时，**第一轮**
        # 只发 tool_calls（不吐字），让客户端看到「模型要动手」；之后轮次照常。
        if state["tool"] and idx == 0:
            name, args = state["tool"]
            emit(
                "data: "
                + json.dumps(
                    {
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": "call_mock_1",
                                            "type": "function",
                                            "function": {
                                                "name": name,
                                                "arguments": json.dumps(args, ensure_ascii=False),
                                            },
                                        }
                                    ]
                                },
                                "finish_reason": None,
                            }
                        ]
                    }
                )
                + "\n\n"
            )
            emit(
                "data: "
                + json.dumps(
                    {"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]}
                )
                + "\n\n"
            )
            emit("data: [DONE]\n\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            return

        # 逐段吐字（模拟流式，顺便验证前端增量渲染）
        step = max(1, len(answer) // 6)
        for i in range(0, len(answer), step):
            chunk = answer[i : i + step]
            emit(
                "data: "
                + json.dumps(
                    {"choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}]}
                )
                + "\n\n"
            )
        # usage 帧（用量透明化面：batch 一 B 项依赖它）
        emit(
            "data: "
            + json.dumps(
                {
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 321, "completion_tokens": 87},
                }
            )
            + "\n\n"
        )
        emit("data: [DONE]\n\n")
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18081)
    ap.add_argument("--log", default="/tmp/mock-ai.log")
    ap.add_argument(
        "--tool-call",
        default=None,
        help="首轮发一次工具调用：'名称:参数JSON'（如 ottr_exec_command:{\"command\":\"df -h /\"}）",
    )
    args = ap.parse_args()

    if args.tool_call:
        name, _, raw_args = args.tool_call.partition(":")
        try:
            parsed = json.loads(raw_args) if raw_args.strip() else {}
        except Exception as e:
            raise SystemExit(f"--tool-call 参数不是合法 JSON: {e}")
        state["tool"] = (name.strip(), parsed)

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.log_path = args.log
    open(args.log, "w", encoding="utf-8").close()
    print(f"[mock-ai] listening on http://127.0.0.1:{args.port}/v1  log={args.log}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
