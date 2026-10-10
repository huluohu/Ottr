<div align="center">

<img src="brand/logo.svg" alt="Ottr" width="180" />

# Ottr · 喔獭

### AI 原生的个人服务器管理工具

*Swim through your servers.* ／ *如獭穿行于服务器之间。*

**开源 · 免费 · 三端（macOS / Windows / Linux）· 数据主权 100% 归你**

[![GitHub](https://img.shields.io/badge/GitHub-huluohu%2FOttr-0F172A)](https://github.com/huluohu/Ottr)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-14B8A6)](#-下载与安装)
[![Built with](https://img.shields.io/badge/Tauri%202%20%2B%20Rust%20%2B%20React-0F172A)](#-技术栈与工程结构)
[![Tests](https://img.shields.io/badge/tests-1790%2B%20green-5EEAD4)](#-测试)
[![License](https://img.shields.io/badge/license-MIT-5EEAD4)](#-许可与作者)

</div>

---

**Ottr** 是一款轻量级的开源 AI SSH 客户端——安装包约 8 MB（AppImage 约 84 MB）、常驻内存约 100 MB，不安装任何后台服务或 Agent。它把「连上服务器敲命令」升级为「AI 懂你的终端」：命令失败自动诊断、自然语言生成命令、全局历史检索，同时守住一条硬底线——**自带 AI Key（BYOK），请求直连你选的模型端点，没有 Ottr 中转服务器**。凭据等秘密字段在本机加密保存；主机元数据和命令历史等以明文存入本机 SQLite。AI 请求和可选同步的数据边界见下方说明。

技术栈 **Tauri 2 + Rust**（russh / russh-sftp）+ **React / TypeScript + xterm.js**，前后端命令契约由自动生成的 TS 绑定与契约测试双面钉住，三端一套代码。

![欢迎首页：时段问候 + 快捷卡 + 应用级侧栏（青野主题）](docs/screenshots/home-welcome.png)

## ✨ 功能总览

### 终端与会话

- **标签页 + 分屏**（向右/向下），GPU 加速渲染，搜索、URL 识别、完整转义序列
- **编码自适应**：UTF-8 / GBK / GB18030 自动检测与一键切换（中文 Windows 服务器刚需）
- **断线自愈**：自动重连（退避）、keepalive 死链检测、连接健康状态灯、重启后还原标签
- **会话录制**：[asciinema v2](https://docs.asciinema.org/manual/asciinema-v2/) 格式，内置时间轴回放（拖动 / 倍速），可导出**脱敏文本**分享

### 主机与凭据

- 分组 / 标签 / 搜索 / **⌘K 模糊快速连接**；`~/.ssh/config` 导入、主机清单 CSV 导出，Tabby（JSON/YAML）、Xshell 第三方导入
- 凭据库：密码、SSH 密钥（ed25519/ecdsa/rsa，生成/导入/部署公钥）、TOTP 两步验证，按主机绑定、**可命名**（多凭据一眼可辨），一套凭据多主机共享
- **跳板链**：多级跳板可视化编排；**端口转发**：本地 / 动态 SOCKS / 远程，断线自动重挂
- known_hosts **TOFU 首次信任 + 指纹巡检**，防中间人

![暗色主题 · 应用级侧栏主机树（分组 / 标签 / 行内编辑）+ 欢迎首页](docs/screenshots/main-dark.png)

### AI 能力（核心卖点，隐私优先）

- **报错即诊**：命令非零退出自动浮出「原因 + 修复命令」，需确认才执行，危险命令红色标注
- **⌘J 自然语言 → 命令**：中文/英文意图直接生成单行命令（附当前目录锚点）
- **选中即释**：选中文本右键「解释 / 翻译 / 修复」；会话结束自动生成纪要，⌘R 全局检索
- **BYOK 多服务商**：OpenAI 兼容（**OpenAI / DeepSeek / 智谱 GLM / 任意自建端点**）、Anthropic Claude、本地 Ollama——预设一键填端点，Key 加密存本机
- **按规则脱敏**：诊断/解释及纪要中的匹配项替换为占位符，不能保证覆盖所有秘密；自然语言命令输入和当前目录上下文不做脱敏。另内置 MCP 服务器，可接入 Claude Desktop 等宿主（主机级授权）

### 监控 · 告警 · 运维

- **免 Agent 监控**：CPU / 内存 / 磁盘 / 负载 / 网络实时曲线 + 进程浏览器，多主机总览
- **告警规则**（磁盘 / CPU / 进程 / 日志关键字）→ **12 种通知渠道**：企业微信、钉钉、飞书、Telegram、Slack、Discord、SMTP 邮件等国内外主流，限频 + 失败重试 + 投递记录持久化
- **定时任务**中心（Rust 侧调度，错过即知）、**批量执行**（多选主机 + 片段库 + 并发/超时控制）

### 文件与同步

- **SFTP 双栏文件管理器**：拖拽传输、并行分块、断点续传；trzsz（trz/tsz）支持；FTP / FTPS
- **远程编辑**：本机编辑器直接改远端文件，原子保存（失败不损坏远端）、二进制嗅探防误编辑
- **多设备同步**：端到端加密信封（AES-256-GCM + PBKDF2），通道三选一（**WebDAV / Git / 本地目录**——WebDAV 走 Rust 代理直连你的网盘，无跨域限制），分类粒度推送/拉取，冲突逐类人工裁定

### 安全底座

- 本地凭据及秘密字段使用 **AES-256-GCM**（不是全库加密）：**钥匙链免密模式**为默认（主密钥存系统钥匙链，打开即用），
  **主密码模式**可选（Argon2id 派生，无密码不可解密秘密字段），一键互转、秘密字段跨模式重加密
- 敏感复制自动清除（剪贴板中的凭据按配置定时清空）、锁定屏「忘记密码」重置引导
  （二次确认，云端备份不受影响）
- 无 Ottr 遥测；AI、同步等功能仍会按配置发送相关数据，不能理解为“任何主机数据都不离开本机”。

### 隐私与 AI 插入边界

- **本地存储**：SSH 密码、私钥、私钥口令、AI API Key 等秘密字段做字段级 AES-256-GCM 加密。主机地址、用户名、备注、命令历史及普通设置等仍是 SQLite 明文；锁库或设置主密码不等于这些内容已加密。同步使用独立加密信封，不改变本地数据库的存储方式。
- **诊断与解释**：诊断发送失败命令和终端输出尾部（最多 8 KB），解释发送选中文本；发送前按规则替换 IP、密码赋值、邮箱以及配置启用的主机名和自定义匹配项。纪要对命令序列应用同类规则。规则可能漏掉不符合样式的秘密、内部名称或业务数据；“已脱敏 N 处”仅表示匹配次数，不是完整性保证。面板仍可能显示本地原文。
- **自然语言生成命令**：输入原文及可用的当前目录（OSC7）直接作为上下文发往所选模型端点，不经过上述脱敏。不要输入密码、令牌或不希望外发的信息。请求直连不代表服务商不接收或留存内容，其处理取决于所选服务商。
- **Ollama**：预设端点是 `http://localhost:11434/v1`。只有端点及模型推理都在本机时才是本地处理；改用远程地址、代理或云端模型后，不能再承诺内容不出本机。
- **AI 命令插入**：只接受不含换行和控制字符的单行文本，不附加回车；多行内容保留原文并禁用插入，需审阅后手动准备命令，不会自动拼接或只取第一行。危险等级是提示，不能证明命令安全。插入前仍需确认终端处于预期的 shell 输入状态并检查已有输入；自定义按键绑定或交互程序的行为不由此保证。

![锁定屏](docs/screenshots/lockscreen.png)

### 体验细节

- **应用级侧栏**：快捷连接（⌘K）/ 主机树（分组、标签、悬停即加主机）/ 功能导航
  （定时任务、告警、MCP、通知中心带未读徽标）/ 设置，一段式布局宽度可拖拽
- **欢迎首页**：时段问候 + 快捷卡（新建主机 / ⌘K 命令面板 / 导入配置）+ 最近连接，零会话也有归宿
- **七套主题**：亮色 / 暗色 / 跟随系统 / 曜黑（OLED 纯黑）/ 幻紫 / 青野 / 雾镜（真透明毛玻璃），
  侧栏「主题」子菜单一键切换，终端配色逐主题跟随；支持 iTerm2 主题导入（含二进制 plist）与自定义配色
- **中文 / English 双语**：侧栏「语言」子菜单即点即切，原生菜单栏文案同步重建；
  macOS 原生菜单栏承载全部功能入口，Windows/Linux 自绘标题栏，三端托盘（彩色水獭徽章）
- **终端个性化**：字体族（Menlo / SF Mono / JetBrains Mono 等）与字号（10–20pt）设置页即选即生效
- **应用内检查更新**：设置 → 通用 → 一键检查，发现新版侧栏提示并下载安装（更新经签名校验）
- 凭据、告警、转发、跳板链、定时任务、MCP 均有专属面板；另有等宽字体连字、命令面板、插件系统（网络摘要 / 快捷命令）

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/palette.png" alt="⌘K 命令面板"></td>
    <td width="50%"><img src="docs/screenshots/cron.png" alt="定时任务中心"></td>
  </tr>
  <tr>
    <td width="50%">⌘K 命令面板（模糊搜索）</td>
    <td width="50%">定时任务中心</td>
  </tr>
</table>

<details>
<summary>更多截图</summary>

![多主机总览](docs/screenshots/overview.png)
![凭据管理](docs/screenshots/credentials.png)
![亮色主题](docs/screenshots/light-theme.png)

</details>

## 📦 下载与安装

前往 [**Releases**](https://github.com/huluohu/Ottr/releases) 下载对应平台安装包（推送版本标签后由 CI 自动构建发布）：

| 平台 | 格式 |
|---|---|
| macOS（Apple Silicon） | `.dmg` |
| macOS（Intel） | `.dmg` |
| Windows | `.msi` / `.exe`（安装向导） |
| Linux | `.deb` / `.rpm` / `.AppImage` |

首次启动会引导你配置本机秘密字段的加密方式（不加密整个数据库）：**钥匙链模式**（免记密码，主密钥存系统钥匙链）或**主密码模式**（无密码不可解密秘密字段）。

已内置**应用内检查更新**（设置 → 通用，经签名校验下载安装）——也可以随时回到本页下载新版本。

<details>
<summary><strong>🍎 macOS 提示「已损坏，无法打开」或连不上局域网主机？点开看解决方法</strong></summary>

Ottr 目前尚未购买 Apple 开发者签名，macOS 的安全机制会对这类应用额外把关——<strong>安装包并没有损坏</strong>，按下面两步处理即可。

**1️⃣ 打开时提示「已损坏，无法打开。你应该将它移到废纸篓」**

打开「终端」，执行以下命令后，再正常打开 Ottr（每次更新版本后重复一次）：

```bash
xattr -cr /Applications/Ottr.app
```

**2️⃣ 连接局域网主机时提示「No route to host」**

macOS 15 起要求应用获得「本地网络」授权后才能访问局域网内的设备。首次连接如果弹出「"Ottr"想要访问本地网络」，点击「允许」即可正常使用。若没有弹窗且连接失败，任选下面一种方法：

- **每次从终端启动 Ottr**（通过终端启动的应用不受此限制）：

  ```bash
  /Applications/Ottr.app/Contents/MacOS/ottr &
  ```

- **一次性放行你的局域网网段**（需要输入管理员密码，执行后重启电脑生效；把 `192.168.9.0/24` 换成你的实际网段）：

  ```bash
  sudo defaults write com.apple.network.local-network AllowedWiFiLocalNetworkAddresses -array "192.168.9.0/24"
  sudo defaults write com.apple.network.local-network AllowedEthernetLocalNetworkAddresses -array "192.168.9.0/24"
  ```

  想恢复系统默认行为时，执行以下命令并再次重启：

  ```bash
  sudo defaults delete com.apple.network.local-network AllowedWiFiLocalNetworkAddresses
  sudo defaults delete com.apple.network.local-network AllowedEthernetLocalNetworkAddresses
  ```

等 Ottr 加入正式的 Apple 开发者签名后，以上步骤将不再需要。

</details>

## 🚀 快速上手

1. **加主机**：侧栏「新建主机」（分组头悬停「＋」可直接往该分组加主机）、「导入 ssh config」→
   双击主机行连接（首次连接展示指纹，信任后免问询）
2. **用 AI**：设置 → AI 助手 → 新增服务商（选「智谱 GLM」「DeepSeek」「Ollama」等预设，填 Key）→
   之后命令失败会自动诊断；`⌘J` 直接用中文要命令
3. **配告警**：侧栏「告警」→ 添加通知渠道（发测试消息验证）→ 建规则（如「根分区 > 90%」）
4. **多设备同步**：第二台设备装好后，设置 → 同步 → 选通道（如 WebDAV 填你的网盘地址）→
   设置同步口令 → 「立即同步」
5. **进阶**：`⌘R` 搜历史、`⌘D`/`⌘⇧D` 分屏；侧栏与「工具」菜单还有端口转发 / 跳板链 /
   定时任务 / 同步 / 导出主机 CSV / 通知中心（未读数直接标在菜单与侧栏上）

## 🛠 技术栈与工程结构

```
├─ frontend/               # 前端（React + TypeScript + zustand + i18next + xterm.js）
│  ├─ app/ dock/ home/ titlebar/                       # 壳层侧栏 / 工具面板停靠 / 欢迎首页 / 自绘标题栏
│  ├─ terminal/ workspace/ hosts/ credentials/ files/  # 终端 / 工作区 / 主机 / 凭据 / 文件
│  ├─ ai/ notify/ sync/ monitor/ history/ cron/ update/  # AI / 通知 / 同步 / 监控 / 历史 / 定时任务 / 检查更新
│  ├─ session/ security/ vault/ batch/ forward/ plugins/  # 会话状态机 / 安全 / 库 API / 批量 / 转发 / 插件
│  ├─ theme/ styles/ ui/ i18n/ shortcuts/ palette/     # 主题令牌 / 分节样式 / 基础组件 / 双语 / 键位 / ⌘K
│  └─ vault/bindings.generated.ts                      # Rust 命令 TS 绑定（tauri-specta 自动生成，漂移即测试红）
├─ desktop/              # Tauri 2 宿主 + 命令层（按域拆分：session/vault/mcp/…）
│  ├─ tests/               # 起真实 SSH/FTP 容器跑集成测试 + 前后端命令契约守护（命令名集合比对 / 绑定一致性）
│  └─ crates/
│     ├─ ottr-vault        # 加密库（AES-256-GCM + Argon2id + 钥匙链 + 同步快照）
│     ├─ ottr-ssh          # SSH/SFTP 传输核（russh，trait 隔离 + PTY 收口层）
│     ├─ ottr-term         # 终端文本层（ANSI/OSC133 解析、编码、asciinema）
│     ├─ ottr-transfer     # SFTP 并行传输 / FTP
│     ├─ ottr-monitor      # 免 Agent 监控采样
│     ├─ ottr-cron         # 定时任务引擎（五段式解析 + 调度 + 抖动原语）
│     └─ ottr-bench        # 性能基准（传输 / PTY 吞吐）
├─ scripts/                # 发布自动化（release.sh）+ 本地测试服务器（sshd/dufs）+ 更新清单生成
├─ brand/                  # 品牌（logo 源文件 + 手册）
├─ docs/screenshots/       # README 截图（docs 其余为内部开发文档，不入库）
└─ .github/workflows/      # CI：push → fmt + clippy + 三平台全量构建；tag → 双架构 macOS / Windows / Linux 构建 + 签名更新件 + latest.json 自动发布
```

### 开发环境

**前置要求**：Node.js 22（仓库带 `.nvmrc`）、Rust stable（[rustup](https://rustup.rs/)），以及平台依赖——
macOS：Xcode CLT；Windows：MSVC Build Tools + [NASM](https://www.nasm.us/)（`aws-lc-sys` 需要）；Linux：`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev`（Debian/Ubuntu 包名）。

```bash
npm install            # 前端依赖
npm run tauri dev      # 起 vite + Tauri 开发窗
```

### 测试

```bash
npm test               # 前端 vitest（1199 用例，含端到端）
cargo test             # Rust 工作区全部单测/集成测试（约 590）
cargo fmt --all --check
cargo clippy --workspace --all-targets   # CI 同款 -D warnings 门，零告警基线
```

本地 SSH/WebDAV 联调可起 Docker 测试服务器：`scripts/spike-sshd.sh`（127.0.0.1:2222）、`scripts/spike-dufs.sh`（127.0.0.1:15773）。仓库另有守护测试钉住设计约束（主题对比度实算、前后端命令名契约比对、TS 绑定与 Rust 签名一致性、控件一致性等）。

### 发布构建

```bash
npx tauri build        # 产出 dmg / msi / nsis / deb / rpm / AppImage（当前平台）
```

推送 `v*` 标签即触发 CI 自动构建四平台（macOS 双架构 / Windows / Linux）安装包 + 签名更新件并发布 Release。

产物位于仓库根 `target/release/bundle/`。改了 `brand/icon.svg` 后用 `npx tauri icon brand/icon.svg` 重新生成全套图标。

### CI

- **`release.yml`**：推送 `v*` 标签 → 校验版本一致性 → 三平台矩阵构建（Linux 上起真实测试服务器跑全量前端测试）→ 自动发布 GitHub Release
- **`spike.yml`**：推送 main → `cargo fmt --check` + `cargo clippy -D warnings` + 三平台编译冒烟

## 📄 许可与作者

**Ottr** 由 [@huluohu](https://github.com/huluohu) 开发，以 [MIT](LICENSE-MIT) 协议开源——
欢迎 Issue 反馈与 PR；主仓库：[github.com/huluohu/Ottr](https://github.com/huluohu/Ottr)。

<div align="center">

*Swim through your servers.* 🦦

</div>
