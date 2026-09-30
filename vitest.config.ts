import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// vitest 独立配置（Phase 1，Task 1 起步）：jsdom + react 插件；
// 与 vite.config.ts 分离，避免 Tauri dev 专属选项（固定端口等）影响测试。
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
  },
});
