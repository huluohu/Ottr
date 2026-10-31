<div align="center">

<img src="docs/screenshots/mark.svg" alt="Ottr" width="140" />

# Ottr · 喔獭

### AI 原生的个人服务器管理工具

*Swim through your servers.* ／ *如獭穿行于服务器之间。*

**开源 · 免费 · macOS / Windows / Linux · 数据主权 100% 归你**

[![GitHub](https://img.shields.io/badge/GitHub-huluohu%2FOttr-0F172A)](https://github.com/huluohu/Ottr)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-14B8A6)](#-下载与安装)
[![License](https://img.shields.io/badge/license-MIT-5EEAD4)](#-许可与作者)

**语言：** [English](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Español](README.es.md) · [Italiano](README.it.md)

</div>

---

**Ottr** 是一款轻量级的开源 AI SSH 客户端——安装包约 8 MB（AppImage 约 84 MB）、常驻内存约 100 MB，不安装任何后台服务或 Agent。它把「连上服务器敲命令」升级为「AI 懂你的终端」：命令失败自动诊断、自然语言生成命令、全局历史检索，同时守住一条硬底线——**自带 AI Key（BYOK），请求直连你选的模型端点，没有 Ottr 中转服务器**。凭据等秘密字段在本机加密保存；主机元数据和命令历史等以明文存入本机 SQLite。AI 请求和可选同步的数据边界见[隐私与 AI 数据边界](#-隐私与-ai-数据边界)。

![欢迎首页：时段问候 + 快捷卡 + 图标轨](docs/screenshots/home-welcome.png)

## ✨ 功能总览

### 终端与会话

- **标签页 + 分屏**（向右 / 向下），GPU 加速渲染，搜索、URL 识别、完整转义序列
- **编码自适应**：UTF-8 / GBK / GB18030 自动检测与一键切换（中文 Windows 服务器刚需）
- **断线自愈**：自动重连（退避）、keepalive 死链检测、连接健康状态灯、重启后还原标签
- **会话录制**：[asciinema v2](https://docs.asciinema.org/manual/asciinema-v2/) 格式，内置时间轴回放（拖动 / 倍速），可导出**脱敏文本**分享

### 主机与凭据

- 分组 / 标签 / 搜索 / **⌘K 模糊快速连接**；主机清单导入 / 导出支持 `~/.ssh/config`、Tabby（JSON/YAML）、Xshell 会话、CSV——导出只含主机元数据，凭据机密永不出库
- 凭据库：密码、SSH 密钥（ed25519/ecdsa/rsa，可生成、导入、部署公钥）、TOTP 两步验证，按主机绑定且**可命名**，一套凭据可多主机共享
- **跳板链**：多级跳板可视化编排；**端口转发**：本地 / 动态 SOCKS / 远程，断线自动重挂
- known_hosts **TOFU 首次信任 + 指纹巡检**，防中间人

![深色主题：图标轨 + 主机面板 + 悬浮岛页签与连接状态点](docs/screenshots/main-dark.png)

### AI 能力（隐私优先）

- **报错即诊**：命令非零退出自动浮出「原因 + 修复命令」，需确认才执行，危险命令红色标注
- **⌘J 生成命令**：用中文或英文说出意图，直接得到可执行的一行命令（附当前目录锚点）
- **选中即释**：选中文本右键「解释 / 翻译 / 修复」；会话结束可自动生成纪要，⌘R 全局检索
- **BYOK 多服务商**：OpenAI 兼容端点（**OpenAI / DeepSeek / 智谱 GLM / 任意自建端点**）、Anthropic Claude、本地 Ollama——预设一键填端点，Key 加密存本机
- **按规则脱敏**：诊断、解释与纪要中的匹配项替换为占位符。这不能保证覆盖所有秘密；自然语言命令输入和当前目录上下文**不做脱敏**。另内置 MCP 服务器（三平台），可接入 Claude Desktop、Cursor 等任何支持 stdio MCP 的客户端（主机级授权 + 逐次审批，等待时长可配）

### 监控 · 告警 · 运维

- **免 Agent 监控**：CPU / 内存 / 磁盘 / 负载 / 网络实时曲线 + 进程浏览器，多主机总览
- **告警规则**（磁盘 / CPU / 进程 / 日志关键字）→ **12 种通知渠道**：企业微信、钉钉、飞书、Telegram、Slack、Discord、SMTP 邮件等，限频 + 失败重试 + 投递记录持久化
- **定时任务**中心（原生调度器执行，错过即知）、**批量执行**（多选主机 + 片段库 + 并发 / 超时控制）

### 文件与同步

- **SFTP 双栏文件管理器**：拖拽传输、并行分块、断点续传；支持 trzsz（trz/tsz）；FTP / FTPS 同样可用
- **远程编辑**：本机编辑器直接改远端文件，原子保存（失败不损坏远端）、二进制嗅探防误编辑
- **多设备同步**：端到端加密信封（AES-256-GCM + PBKDF2），通道三选一——**WebDAV / Git / 本地目录**（WebDAV 走原生代理直连你的网盘，无跨域限制），分类粒度推送 / 拉取，冲突逐类人工裁定

### 安全底座

- 本地凭据及秘密字段使用 **AES-256-GCM**（不是全库加密）。两种模式：**钥匙链模式**为默认（主密钥存系统钥匙链，打开即用）；**主密码模式**可选（Argon2id 派生，无密码不可解密秘密字段）。两者可一键互转，秘密字段跨模式重加密
- 敏感复制按配置定时清空；锁定屏提供「忘记密码」重置引导（二次确认，云端备份不受影响）
- Ottr **不发送任何遥测**。AI 与同步功能仍会按配置发送相关数据——这不等于「任何主机数据都不离开本机」

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

</details>

## 📦 下载与安装

前往 [**Releases**](https://github.com/huluohu/Ottr/releases) 下载对应平台安装包：

| 平台 | 格式 |
|---|---|
| macOS（Apple Silicon） | `.dmg` |
| macOS（Intel） | `.dmg` |
| Windows | `.msi` / `.exe`（安装向导），或 **`_x64_portable.zip`（便携版，免安装）** |
| Linux | `.deb` / `.rpm` / `.AppImage` |

首次启动会引导你配置本机秘密字段的加密方式（不加密整个数据库）：**钥匙链模式**（免记密码，主密钥存系统钥匙链）或**主密码模式**（无密码不可解密秘密字段）。

**Windows 便携版**：解压到任意目录，双击 `Ottr.exe` 即用——无需安装，配置和数据随包存放在 `Ottr/data/` 目录（整个文件夹拷走即迁移，删掉即卸载；需系统已有 WebView2 运行时，Win10/11 一般自带）。便携版不提供应用内自动更新，升级时下载新版 zip 解压覆盖（保留 `data/` 目录即保留全部配置）。

安装版已内置**应用内检查更新**（设置 → 关于，经签名校验下载安装），也可以随时回到本页手动下载。

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

等 Ottr 拿到正式的 Apple 开发者签名后，以上步骤将不再需要。

</details>

## 🚀 快速上手

1. **加主机**：侧栏「新建主机」（分组头悬停「＋」可直接往该分组加主机）或「导入 ssh config」→ 双击主机行连接（首次连接展示指纹，信任后不再询问）
2. **用 AI**：设置 → AI → 新增服务商（选「智谱 GLM」「DeepSeek」「Ollama」等预设，填 Key）→ 之后命令失败会自动诊断；**⌘J** 直接用中文要命令
3. **配告警**：设置 → 告警 → 添加通知渠道（发测试消息验证）→ 建规则（如「根分区 > 90%」）；哪些事件产生通知，也在这一页的「通知类型」里勾选
4. **多设备同步**：第二台设备装好后，设置 → 同步 → 选通道（如 WebDAV 填你的网盘地址）→ 设置同步口令 → 「立即同步」
5. **进阶**：**⌘R** 搜历史、**⌘D**（Win/Linux `Ctrl+⇧D`）分屏；「文件」菜单（macOS）导入 / 导出主机，「工具」菜单（macOS）或 **⌘K** 面板还有端口转发、跳板链、定时任务、批量执行与通知中心（未读数直接标在图标轨与菜单上）

## 🔐 隐私与 AI 数据边界

- **本地存储**：SSH 密码、私钥、私钥口令、AI API Key 等秘密字段做字段级 AES-256-GCM 加密。主机地址、用户名、备注、命令历史及普通设置等仍是本机 SQLite 明文；锁库或设置主密码不等于这些内容已加密。同步使用独立加密信封，不改变本地数据库的存储方式。
- **诊断与解释**：诊断发送失败命令和终端输出尾部（最多 8 KB），解释发送选中文本；发送前按规则替换 IP、密码赋值、邮箱以及配置启用的主机名和自定义匹配项。纪要对命令序列应用同类规则。规则可能漏掉不符合样式的秘密、内部名称或业务数据；「已脱敏 N 处」只表示匹配次数，不是完整性保证。面板仍可能显示本地原文。
- **自然语言生成命令**：输入原文及可用的当前目录（OSC 7）直接作为上下文发往所选模型端点，不经过上述脱敏。不要输入密码、令牌或不希望外发的信息。请求直连不代表服务商不接收或留存内容，其处理取决于所选服务商。
- **Ollama**：预设端点是 `http://localhost:11434/v1`。只有端点及模型推理都在本机时才是本地处理；改用远程地址、代理或云端模型后，就不能再承诺内容不出本机。
- **AI 命令插入**：只接受不含换行和控制字符的单行文本，且不附加回车；多行内容保留原文并禁用插入，需审阅后手动准备命令，不会自动拼接或只取第一行。危险等级是提示，不能证明命令安全。插入前仍需确认终端处于预期的 shell 输入状态并检查已有输入；自定义按键绑定或交互程序的行为不由此保证。

## 📄 许可与作者

**Ottr** 由 [@huluohu](https://github.com/huluohu) 开发，以 [MIT](LICENSE-MIT) 协议开源——欢迎 Issue 反馈与 PR。主仓库：[github.com/huluohu/Ottr](https://github.com/huluohu/Ottr)。

<div align="center">

*Swim through your servers.* 🦦

</div>
