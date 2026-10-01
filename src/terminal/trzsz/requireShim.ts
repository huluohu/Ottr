// trzsz require 垫片（Phase 2 Task 4，B10 下半）：在 trzsz 模块求值**之前**安装
// `globalThis.require`，把 trzsz.js 的运行时探测（comm.ts `require.resolve("fs")`）
// 钉在 node 模式——浏览器模式依赖 File System Access API，Tauri webview（WKWebView）
// 无此 API，上传/下载均不可用；node 模式（Electron 同款）+ 本目录 fs 垫片 =
// 唯一可行形态（选型论证见 task-4 报告）。
//
// 时序契约：ESM 依赖按 import 声明序深度优先求值——TrzszController.ts 里
// `import "./requireShim"` 先于 `import { TrzszFilter } from "trzsz"`，故
// nodefs.ts 顶层 `requireSafely("fs")` 与 comm.ts 的 isRunningInBrowser IIFE
// 都看到本垫片（idempotent：已有 require 不覆盖，真实 node 运行时用原生 fs）。
import { createFsShim, createPathShim } from "./fsShim";

/** 安装 require 垫片（模块加载副作用；导出仅供测试断言）。 */
export function installRequireShim(): void {
  const g = globalThis as unknown as { require?: unknown };
  if (typeof g.require === "function") return; // 真运行时（CJS/已装）不覆盖
  const fs = createFsShim();
  const path = createPathShim();
  const shim = Object.assign(
    (id: string): unknown => {
      if (id === "fs") return fs;
      if (id === "path") return path;
      throw new Error(`otr trzsz shim: module not supported: ${id}`);
    },
    { resolve: (id: string) => id },
  );
  g.require = shim;
}

installRequireShim();
