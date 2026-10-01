import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/**
 * trzsz node 模式钉死（Phase 2 Task 4，B10 下半）：
 * trzsz.mjs 用裸 `require` / `require.resolve` 探测运行时（comm.ts 的
 * isRunningInBrowser IIFE + nodefs.ts 的 requireSafely）。打包时 rolldown 会把
 * 这些裸 require 改写成 browser-external 代理——生产 webview 里探测恒判「浏览器
 * 模式」，而浏览器模式依赖 File System Access API（WKWebView 无此 API，上传/
 * 下载皆不可用），且 fs 落成空壳。本插件在打包前把两处探测改写为显式
 * `globalThis.require(...)`（src/terminal/trzsz/requireShim.ts 安装的 fs/path
 * 垫片，IO 走 commands/trzsz_fs.rs invoke 桥），强制 node 模式（Electron 同款
 * 路径，选型论证见 task-4 报告）。改写未命中即构建失败（库升级形态变化时人工
 * 复核，不静默漂移）。optimizeDeps.exclude 让 dev 预打包也不碰它，dev/build
 * 行为一致；vitest 不经本配置（runner 自带 require，天然 node 模式）。
 */
function otrTrzszNodeCompat(): Plugin {
  return {
    name: "otr-trzsz-node-compat",
    transform(code, id) {
      if (!id.replace(/\\/g, "/").includes("trzsz/lib/trzsz.mjs")) return null;
      let out = code;
      let touched = 0;
      // isRunningInBrowser IIFE → !1（node 模式）
      out = out.replace(
        /=function\(\)\{try\{if\("fs"===require\.resolve\("fs"\)\)return require\("fs"\),!1\}catch\([a-zA-Z_$][\w$]*\)\{\}return!0\}\(\)/g,
        () => {
          touched++;
          return "=!1";
        },
      );
      // requireSafely → 直呼 globalThis.require（fs/path 垫片）
      out = out.replace(
        /function ([A-Za-z_$][\w$]*)\(([a-zA-Z_$][\w$]*)\)\{try\{return require\(\2\)\}catch\(\2\)\{return\{\}\}\}/g,
        (_m: string, fn: string, arg: string) => {
          touched++;
          return `function ${fn}(${arg}){return globalThis.require(${arg})}`;
        },
      );
      if (touched < 2) {
        this.error(
          `otr-trzsz-node-compat: trzsz.mjs 形态变化，仅命中 ${touched}/2 处——需人工核对运行时探测代码`,
        );
      }
      return { code: out, map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), otrTrzszNodeCompat()],

  // trzsz 的 node 模式改写必须过 transform 管线（见 otrTrzszNodeCompat）；
  // 预打包（esbuild）会把裸 require 折叠成 browser-external，dev/build 不一致。
  optimizeDeps: {
    exclude: ["trzsz"],
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
