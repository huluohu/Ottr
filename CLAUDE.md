# CLAUDE.md

本文件为 AI 编码代理提供本仓库的工作指引。改动前先读一遍「约定与红线」。

## 项目概览

**Ottr（喔獭）**：开源 AI SSH 客户端，三端（macOS / Windows / Linux）桌面应用。
技术栈：Tauri 2 + Rust（russh / russh-sftp）后端；React + TypeScript + zustand + i18next + xterm.js 前端。
前后端命令契约由自动生成的 TS 绑定与契约测试双面钉住，改命令必须两边同步。

## 常用命令

```bash
npm install                            # 前端依赖
npm run tauri dev                      # 起 vite + Tauri 开发窗
npm test                               # 前端 vitest 全量（含端到端）
cargo test                             # Rust 工作区全部单测/集成测试
cargo fmt --all --check                # fmt 门（CI 同款）
cargo clippy --workspace --all-targets # clippy 门（CI 为 -D warnings，零告警基线）
npx tauri build                        # 发布构建（当前平台安装包）
```

本地联调服务器（Docker）：`scripts/spike-sshd.sh`（127.0.0.1:2222）、
`scripts/spike-dufs.sh`（127.0.0.1:15773，WebDAV）、`scripts/spike-ftpd.sh`。

## 工程结构

- `frontend/` — React 前端，按功能域分目录（terminal / hosts / credentials / ai / sync / monitor / …）
  - `frontend/vault/bindings.generated.ts` — Rust 命令的 TS 绑定，**自动生成，禁止手改**。
    漂移时删除该文件重跑 `cargo test --test ts_bindings` 即可重新生成，随改动一起提交。
- `desktop/` — Tauri 2 宿主 + 命令层（`src/commands/` 等按域拆分）；
  `tests/` 起真实 SSH/FTP 容器跑集成测试 + 前后端契约守护（命令名集合比对 / 绑定一致性）
- `crates/` — Rust 工作区子 crate：
  `ottr-ssh`（SSH/SFTP 传输核）/ `ottr-term`（终端文本层，ANSI/OSC 解析、编码、asciinema）/
  `ottr-transfer`（SFTP 并行传输、FTP）/ `ottr-vault`（加密库：AES-256-GCM + Argon2id + 钥匙链）/
  `ottr-monitor`（免 Agent 监控采样）/ `ottr-cron`（定时任务引擎）/ `ottr-bench`（性能基准）
- `scripts/` — 发布自动化（`release.sh`）与本地测试服务器
- `brand/` — 品牌资产与手册（规范见 `brand/brand.md`）；改 `brand/icon.svg` 后用
  `npx tauri icon brand/icon.svg` 重新生成全套图标
- `docs/screenshots/` — README 截图（docs 其余内容不入库）

## 约定与红线

- **Rust**：全仓 edition 2024；rustfmt 保持默认配置（`rustfmt.toml` 只钉 edition）；
  clippy 必须零告警（CI `-D warnings`）。
- **依赖版本**：统一钉在根 `Cargo.toml` 的 `[workspace.dependencies]`，各 crate 只追加自己的
  features（`dep = { workspace = true, features = [...] }`），不单独定版本。
- **前后端契约**：新增/修改 Rust 命令时同步重新生成 TS 绑定；命令名集合比对与绑定一致性
  由守护测试钉住，漂移即测试红。
- **i18n**：所有用户可见文案走 i18next 中英双语，新增文案必须中英两个语言文件都补。
- **主题**：七套水域主题，令牌在 `frontend/theme/`；有守护测试实算对比度，改配色先跑测试。
- **安全边界**（不可破坏）：
  - 秘密字段（密码/私钥/口令/AI Key）为字段级 AES-256-GCM 加密，不是全库加密；
    钥匙链免密模式为默认，主密码模式（Argon2id）可选
  - BYOK：AI 请求直连用户配置的模型端点，不存在 Ottr 中转服务器
  - 主机导入/导出只含元数据，凭据机密永不出库
  - AI 命令插入只接受不含换行和控制字符的单行文本，不自动拼接、不自动执行
- **golden 夹具**：`crates/ottr-term/tests/golden/` 下 `.bin`/`.expected` 是字节断言文件，
  勿手动编辑（`.gitattributes` 已防 CDN 归一化）。

## CI

- `spike.yml`：push main / PR → `cargo fmt --check` + `cargo clippy -D warnings` + 三平台编译冒烟
- `release.yml`：推送 `v*` 标签 → 校验版本一致性 → 三平台构建 + 签名更新件 + 自动发布 Release

提交前至少跑：`cargo fmt --all --check`、`cargo clippy --workspace --all-targets`，
以及本次改动涉及的 `npm test` / `cargo test`。
