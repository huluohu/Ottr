<div align="center">

<img src="brand/icon.svg" alt="Ottr icon" width="128" />

# Ottr

*Swim through your servers.* ／ *如獭穿行于服务器之间。*

**免费、三端、AI 原生的个人服务器管理工具**

<!-- TODO(screenshot): 首个公开版本前补主界面截图（终端 + 分屏 + AI 诊断），放 docs/screenshots/ -->

</div>

---

Ottr 是一款跨平台（macOS / Windows / Linux）SSH 客户端，把「连接终端」升级为
「AI 懂你的终端 + 效率闭环 + 数据主权」：数据全部留在本地或用户自己的云，
闭源、免费，承诺不联网上传任何主机数据（行为可抓包自行验证）。

技术栈：**Tauri 2 + Rust**（russh / russh-sftp）+ **xterm.js** + React / TypeScript。
包体约 10MB、内存约 100MB，三端一套代码。

## 特性

基础必备（Table Stakes）：

| # | 特性 | 说明 |
|---|---|---|
| A1 | SSH 终端 | 标签页 + 分屏（水平/垂直）、GPU 加速渲染、主题、字体连字 |
| A2 | 主机管理 | 分组/标签/搜索、`~/.ssh/config` 与 CSV 导入导出、⌘K 模糊快速连接 |
| A3 | 凭据管理 | 密码、SSH 密钥（ed25519/ecdsa/rsa）、TOTP 2FA、按主机绑定凭据 |
| A4 | 密钥基础 | 生成、导入导出、指纹展示、known_hosts 校验 |
| A5 | SFTP | 双栏文件管理器、拖拽传输、进度与队列、断点续传 |
| A6 | 会话管理 | 断线自动重连、keepalive、连接健康状态灯、重启后还原标签 |
| A7 | 安全底座 | 本地库 AES-256-GCM + 可选主密码 + 系统钥匙链、自动锁定 |
| A8 | 终端基础体验 | 搜索、复制粘贴规范、URL 识别、转义序列完整支持 |
| A9 | 编码自适应 | UTF-8/GBK 自动检测与切换（中文 Windows 服务器刚需） |
| A10 | 主题系统 | 亮/暗/跟随系统一键切换；全部走设计令牌（CSS 变量） |
| A11 | 多语言（i18n） | zh-CN / en-US 首发双语，语言跟随系统、可手动切换 |
| A12 | 三端原生交互 | macOS 原生菜单栏、Windows/Linux 自绘标题栏、三端托盘、⌘K 命令面板 |

AI 能力（核心卖点，隐私优先）：

- **报错即诊**：命令非零退出自动浮出「原因 + 建议命令」，需确认才执行，危险命令红色标注
- **选中即释**：选中文本右键「解释 / 翻译 / 修复」
- **统一历史**：⌘R 全局搜「我在哪台机器跑过 docker logs」
- **BYOK**：OpenAI / Claude / DeepSeek / 本地 Ollama，自带 Key，发送前脱敏，**绝不经过我方服务器**

> 当前处于 Phase 1（MVP）开发中：A1–A12 与 AI 最小版逐步落地，
> 完整路线图见 [`docs/features-and-roadmap.md`](docs/features-and-roadmap.md)
> （自有云 E2E 加密同步、会话录制回放、免 Agent 监控、告警与通知矩阵、批量执行等在后续阶段）。

## 录制分享指引（会话回放与导出）

终端会话可录制为 [asciinema v2](https://docs.asciinema.org/manual/asciinema-v2/) 格式
（连接后点「录制」页签；录制内容仅落本机，文件 0600）。分享/存档路径：

- **回放**：录制页内置时间轴回放（拖动 seek、倍速），无需任何外部工具；
- **导出**：导出为脱敏文本（敏感串自动替换为占位符，可二次确认后导出原文）；
- **转 GIF/嵌入网页**（Ottr 内不内置，用官方工具链处理导出的 `.cast` 文件）：
  - `asciinema upload Recording.cast` → 获得可在 Markdown/网页直接嵌入的播放页链接；
  - 或 `agg Recording.cast Recording.gif`（[asciinema/agg](https://github.com/asciinema/agg)，
    单二进制，可将录制转 GIF/SVG）；
- 敏感场景建议只分发脱敏导出文本；`.cast` 原文与终端原文等同，分享前自行确认内容。

## 构建与开发

### 前置要求

- **Node.js ≥ 20** 与 npm
- **Rust stable**（[rustup](https://rustup.rs/)）
- 平台依赖：
  - **macOS**：Xcode Command Line Tools
  - **Windows**：Visual Studio C++ Build Tools（MSVC）；`aws-lc-sys` 需要 **NASM** 汇编器
  - **Linux**：`libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`（Debian/Ubuntu 包名）

### 开发

```bash
npm install          # 前端依赖（含 @tauri-apps/cli）
npm run tauri dev    # 起 vite + Tauri 开发窗
```

本地 SSH 联调可起测试夹具：`scripts/spike-sshd.sh`（127.0.0.1:2222）。同步通道 WebDAV 端到端需 dufs 夹具：`scripts/spike-dufs.sh`（127.0.0.1:15773，需 Docker）。

### 测试

```bash
npm test             # 前端 vitest
cargo test           # Rust 工作区全部单测/集成测试（src-tauri + crates/*）
```

### 发布构建

```bash
npm run tauri build  # 产出 dmg / msi / nsis / deb / AppImage（按当前平台）
```

构建产物位于 `target/release/bundle/`（workspace 根 `target/`，非 `src-tauri/target/`）。

## Troubleshooting（开发环境实录）

- **Apple Silicon 上 `npm run tauri dev` 链接期报 `unable to load libxcrun ... need 'x86_64'`**：
  根因是 Node.js 本身跑在 Rosetta 下（`node -p process.arch` 显示 `x64`，如
  `/usr/local/bin/node` 的 x86_64 版本）——npm 按自身架构装了 x86_64 的
  `@tauri-apps/cli` 原生二进制，其拉起的 `cc` 加载不了 arm64-only 的 libxcrun。
  修法：换用 arm64 的 Node（nvm 在 Apple Silicon 上装的版本即 arm64）并重装依赖
  （npm 对 optionalDependencies 按安装时平台取包，换架构后必须干净重装，见
  npm/cli#4828）：

  ```bash
  nvm install 22 && nvm use 22   # arm64 node
  node -p process.arch            # 应输出 arm64
  npm ci                          # 或 rm -rf node_modules && npm install
  ```

  应急绕过（不动 node）：两个终端分开跑——终端 A `npm run dev`（vite），
  终端 B `cargo build -p ottr --bin ottr && ./target/debug/ottr`
  （devUrl `http://localhost:1420` 编译期内置，行为等价）。

## License

免费闭源（freeware）。版权所有，详见 [LICENSE](LICENSE)（最终 EULA 待定，当前为占位文本）。
