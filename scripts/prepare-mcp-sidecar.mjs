// MCP relay sidecar 准备脚本（2026-10-31）：tauri externalBin 要求
// `binaries/ottr-mcp-<rust-target-triple>(.exe)` 形态的文件在 tauri build/dev
// 启动前就位。本脚本编译 ottr-mcp 并按当前平台 triple 摆放到 binaries/。
//
// 用法：
//   node scripts/prepare-mcp-sidecar.mjs            # dev：debug 构建（快）
//   node scripts/prepare-mcp-sidecar.mjs --release  # 发布：release 构建
//
// 消费方：desktop/tauri.conf.json 的 beforeDevCommand / beforeBuildCommand
//（bundle.externalBin = ["binaries/ottr-mcp"]）。
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = process.argv.includes("--release");

function hostTriple() {
  const out = execSync("rustc -vV", { encoding: "utf8", cwd: root });
  const m = out.match(/^host:\s*(\S+)$/m);
  if (!m) throw new Error("cannot determine rust host triple");
  return m[1];
}

// 目标 triple：CI 交叉编译（release.yml 的 macOS Intel job）经 RUST_TARGET
// 指定——beforeBuildCommand 继承 job 环境；本地 dev/host 场景 = rustc host。
const triple = process.env.RUST_TARGET || hostTriple();
const crossArgs = process.env.RUST_TARGET ? ["--target", process.env.RUST_TARGET] : [];
const profileDir = release ? "release" : "debug";
// 工作区 target 在仓库根（crates + desktop 同 workspace，无 target-dir 覆盖）；
// 交叉编译时产物落 target/<triple>/<profile>/。
const built = join(root, "target", ...crossArgs.slice(1), profileDir, "ottr-mcp");
const builtExe = process.platform === "win32" ? `${built}.exe` : built;

// 增量：已就位（同 profile）则跳过编译（tauri dev 重启频繁，debug 重复编译
// 浪费数十秒；文件由 cargo 增量管理，我们只认「存在即用」）。
const dest = join(root, "desktop", "binaries", `ottr-mcp-${triple}${process.platform === "win32" ? ".exe" : ""}`);
if (!existsSync(dest)) {
  execSync(`cargo build -p ottr-mcp ${release ? "--release" : ""} ${crossArgs.join(" ")}`.trim(), {
    cwd: root,
    stdio: "inherit",
  });
  if (!existsSync(builtExe)) {
    throw new Error(`ottr-mcp binary not found at ${builtExe}`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  copyFileSync(builtExe, dest);
}
console.log(`[mcp-sidecar] ${dest}`);
