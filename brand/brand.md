# Ottr 品牌手册（v6，2026-10-16 定稿：C2-F5 呆毛歪头，v4 插画保留）

## 命名

**Ottr** — 发音同 *Otter* /ˈɒtər/。海獭是少数会使用工具的哺乳动物（仰面躺在水面上，用石块砸开贝壳）——「会用工具的动物」正是这款工具的精神图腾：灵巧、聪明、亲水（数据如水，Ottr 在其中穿行）。
去元音拼写（flickr/tumblr 传统）便于获得 ottr.app 等域名与各平台同名账号。

## Slogan

| 语言 | 主口号（推荐） | 备注 |
|---|---|---|
| EN | **Swim through your servers.** | 动词有画面感：水獭游泳 = 在多台服务器间灵巧穿行 |
| zh | **如獭穿行于服务器之间。** | 与 EN 同构 |

备选（营销场景轮换使用）：
- EN: *Every server, one clever paw away.*（可爱向，App Store 副标）
- EN: *The AI-native SSH client.*（功能向，官网 hero）
- zh: *灵巧如獭，连接无界。*
- zh: *AI 原生 SSH 客户端——灵巧、聪明、免费。*（功能向副标）

## Logo（v4，2026-10-08 仰漂獭——用户逐步确认定稿）

**风格语法**：全曲线萌系 × Ottr 河水身份。**River Teal 渐变圆角方底**（`#2DD4BF→#0B7C6E`，
「Swim through your servers」的水）+ **仰漂的水獭**（头后仰吻朝天、豆豆眼、奶油吻部与肚皮、
琥珀鼻、侧位小圆耳、胡须、粗短圆尾）+ **两爪举一台圆角小终端**（`>_` 提示符 + 琥珀圆点——
「会用工具的獭」精神图腾的画面化）+ 水线横穿身体、水线下沉色（漂感）+ 白色粗字标。
深色场景反白变体：无底盘透明背景，獭体 slate-100、终端反转为亮框深屏。

| 文件 | 用途 |
|---|---|
| `logo.svg` | 通用锁牌 = 河水底盘装版，任意明暗背景直接用（README/官网/文档） |
| `logo-dark.svg` | 深色背景无底盘反白变体（深色海报/ 片头） |
| `icon.svg` | App 图标源文件（= logo.svg 同构图），导出 icns/ico/png 的唯一源（`npx tauri icon brand/icon.svg`） |
| `tray-template.svg` | 菜单栏/托盘单色模板图标（macOS Template Image 自动适配明暗）——剪影 = 耳 + 多边形头，眼/吻部镂空；胡须在 16px 下省略 |

**使用规范**
- 安全边距 ≥ 獭体宽度的 12%；最小尺寸：彩色 24px、托盘 16px
- 不拉伸、不描边、不加阴影；仰漂姿态与举终端是识别关键，禁止删减
- 单色场景只用 `tray-template.svg` 的剪影结构（横躺体 + 头圆 + 尾弯，肚皮终端镂空）
- 字标用系统无衬线 900 字重渲染（SF Pro Display / Helvetica Neue / Arial 回退链）

## Logo v5（2026-10-16，双轨制几何标——**已被 v6 取代**，本节降为历史档）

v4 仰漂獭是一幅好插画，但在 Dock/托盘/⌘K 的 16–64px 真实使用域里，胡须、豆豆眼、
`>_` 提示符全部糊成深色团块。v5 做**纯减法**，DNA 全部继承 v4：侧游獭 = 头一颗圆 +
身一条胶囊 + 尾一根弯钩；teal 渐变底盘（`#2DD4BF→#0B7C6E`）、奶油脸盘豆豆眼
（teal-300 瞳）、琥珀鼻、白水线横穿 + 水下沉色（漂浮感）一样不少；胡须/爪/w 嘴/
字标全部移出（字标只出现在锁牌）。16px 投影后剪影仍可辨（五档走查备案 2026-10-16）。

**双轨制使用域**

| 资产 | 尺寸域 | 场景 |
|---|---|---|
| v4 仰漂獭（保留为插画资产） | ≥128px | 官网 hero、欢迎页品牌位、空状态插画、锁屏 Otty、发布物封面 |
| **v5 几何标** | 16–64px | App 图标（icns/ico 重导出）、托盘、favicon、社交头像 |

| 文件 | 用途 |
|---|---|
| `v5/mark.svg` | v5 几何标源文件；**`icon.svg` 已由 v5 接管**（导出 icns/ico/png 唯一源，命令不变） |
| `v5/lockup.svg` | 横排锁牌 = v5 图标 + 深色字标 + slogan（README 头图、浅底文档）；字标只在此出现 |
| `tray-template-v5.svg` | v5 同构单色剪影（头圆 + 胶囊 + 弯钩尾，水线镂空缝）；macOS Template 机制不变 |

**v5 使用规范**（历史档，不再投产）
- 最小尺寸 16px（安全边距 ≥ 獭体宽度 12%）；不拉伸、不描边、不加阴影
- 弯钩尾朝上、水线横穿是识别关键；禁止把字标塞回 mark（16px 即糊）
- v4/v5 不得同屏混用同一场景（一个界面里出现两只不同的獭）

## Logo v6（2026-10-16 定稿：C2-F5「呆毛歪头」，三层制）

v5 上线同日，logo 专项评审继续推进（round2/round3/round4 三轮，见
`~/workspace/ottr-logo-redesign/`，最终交付 `round4/final-delivery-f5.html`），
用户裁定 **C2-F5「呆毛歪头」为最终标识**：C2 托腮基座（宽圆深色头 + 双爪从
水里扒沿 + 浅色宽扁吻 + 白水线横条）叠 F5 表情（头顶呆毛 + 整头微倾 3° +
无辜下弯眉 + w 小嘴 + 双腮红）。16px 走查实测：呆毛缺口与歪头不对称眼双
信号存活。`icon.svg` 已由 v6 接管，v5 资产降为历史档。

**三层职责（v6 核心纪律）**

| 层 | 尺寸域 | 内容 |
|---|---|---|
| `mark.svg` | 48px 以上 | 全表情：呆毛 + 歪头不对称眼 + 无辜眉 + w 嘴 + 双腮红 + 涟漪 |
| `mark-micro.svg` | 16–32px | 缩略层：撤眉/w 嘴/腮红/涟漪，保呆毛缺口 + 歪头不对称眼 + 头 + 水线 |
| `tray-template.svg` | 单色托盘 | 头 + 双爪剪影 + 水面横条（表情层无剪影贡献） |

**使用规范**
- 选层即纪律：≤32px 一律 micro（favicon、小列表位、icns/ico 的小切片），
  48px 起才用 mark；表情细节不许下探到缩略层
- 托盘剪影三档（44/22/16）单块连通、水线缺口可读；macOS Template 机制不变
- 不拉伸、不描边、不加阴影；呆毛与歪头不对称眼是识别关键，禁止删改
- 字标只出现在锁牌（`f5-tilt/lockup.svg`）

| 文件 | 用途 |
|---|---|
| `f5-tilt/mark.svg` | v6 主标源文件；**`icon.svg` 已由 v6 接管**（导出 icns/ico/png 唯一源） |
| `f5-tilt/mark-micro.svg` | 16–32px 缩略层（favicon = `public/icon.svg` 取此层） |
| `f5-tilt/tray-template.svg` | v6 单色托盘模板（currentColor） |
| `f5-tilt/lockup.svg` | 横排锁牌 = v6 图标 + 深色字标 + slogan（**仅限浅色底**文档/海报；GitHub 等 dark-mode 场景头图用纯 mark——深色字标在暗底不可见，2026-10-16 实测） |

## 配色（同时是主题令牌的种子值）

| 令牌 | 值 | 语义 |
|---|---|---|
| `--ottr-teal-500` | `#14B8A6` | 主色 River Teal（连接、主按钮、非文字 accent：按钮底/边框/选中底；logo 耳/瞳） |
| `--ottr-teal-700` | `#0F766E` | 主色深（hover、标题强调） |
| `--ottr-teal-800` | `#115E59` | 主色深·文字对比专用（亮色主题 accent 文字色；fix 2 备案，见下） |
| `--ottr-teal-300` | `#5EEAD4` | 主色浅（暗色主题主色；logo 虹膜） |
| `--ottr-amber-500` | `#F59E0B` | 点缀 Otter Amber（收藏星标、AI 提示、logo 鼻） |
| `--ottr-fur-600` | `#A9714B` | 毛色 Riverbank Brown（品牌插画保留色；v2 logo 不再用） |
| `--ottr-fur-800` | `#8A5A3B` | 毛色深（品牌插画暗部） |
| `--ottr-cream-100` | `#F6E7D4` | 吻部 Cream（品牌插画浅色） |
| `--ottr-ink-900` | `#0F172A` | 墨色（五官、正文标题、v2 logo 头部） |
| `--ottr-water-900` | `#0B2B33` | Deep Water（暗色主题背景基调） |

### 三色分工（2026-10-16 视觉重设计裁定：Amber 升格「Otty 时刻」专属色）

品牌三色各司其职，情感价值不再只活在插画里：

- **Teal = 工作**：系统/连接/主操作（按钮、选中态、连接状态、进度）
- **Ink · Cream = 介质**：内容本体（正文、表面、獭体与吻部）
- **Amber = 奖赏**：情感时刻专属——**凡有 Otty 在场必有 Amber**（星光、草叶、
  腮红、光晕），加上既有出场位（收藏星标、AI 提示、logo 鼻）。色彩心理学口径：
  暖色 = 反馈奖赏，克制使用（同一时刻至多一个 Otty 在场）。落地见 Otty 情感时刻
  四件套（连接成功/传输完成/解锁成功/更新就绪，v1.0.0 起）。

### 语义层派生键备案（T1 M-5 闭环；Fix round 2，2026-09-30）

来源：Task 8 目检（WCAG 对比度审查）裁定项——accent/danger 实底与亮底上作**文字**时
不达 AA 4.5:1，语义层拆分「面」与「字」两类键。数字为 WCAG 2.x 相对亮度法，
落面含 color-mix 派生面（raised = fg6%/bg，overlay = fg10%/bg）。

| 语义键 | 亮色值 | 暗色值 | 语义 | 对比度（改前 → 改后） |
|---|---|---|---|---|
| `--color-accent-text` | `var(--ottr-teal-800)` #115E59 | `var(--ottr-teal-300)` #5EEAD4 | accent 作**文字色**专用（链接、激活态文字、徽标文字、菜单勾选） | 亮 teal-500 on bg **2.33** → teal-800 on bg/raised/overlay **7.09/6.31/5.80**；暗 teal-300 **10.09/8.68/7.72**（原值即达标的键值等价） |
| `--color-on-accent` | `var(--ottr-ink-900)` #0F172A | `var(--ottr-water-900)` #0B2B33 | accent 实底（主按钮）上的文字 | 亮 cream-bg 字 on teal-500 **2.33** → 墨色字 **7.17**；暗 water-900 on teal-300 **10.09**（不变） |
| `--color-on-danger` | `#FFFFFF` | `var(--ottr-ink-900)` #0F172A | danger 实底（危险按钮）上的文字 | 亮 #fff on #d92d20 **4.83**（不变）；暗 #fff on #f97066 **2.79** → 墨色字 **6.41** |

裁定说明：
* 亮色 accent-text 取 teal-800 而非 teal-700（#0F766E on overlay 仅 4.18，右键菜单/
  对话框底不达标；teal-800 全落面 ≥4.5），新增品牌种子一档，色相与 500/700/300 同族。
* 暗色 danger 保持 #F97066 不动（作文字色 on bg 5.35 达标）；「加深底色到 #d92d20」
  的备选方案会把暗色 danger 文字对比拖到 3.09，弃。
* `#FFFFFF` 作为亮色 on-danger 值与 `--color-surface` 同为语义层白（cream-100 对
  #d92d20 仅 3.98，不可用）。
* 回归钉：`frontend/theme/tokens.test.ts`（解析 tokens.css 实算对比度，退回即红）。

**终端默认主题映射建议**（ANSI 16 色）：normal 色取品牌同色系低饱和值（red→#D97066 系、green→teal 系、yellow→amber 系、blue→水色系），bright 色取同色相高饱和值；前景 `--ottr-cream-100` 偏暖白，背景 `--ottr-water-900`。生产环境主机红色边框（B11）复用 ANSI red bright。

## 字体

- **UI**：Inter（拉丁）+ Noto Sans SC（中文），免授权费、三端渲染一致
- **终端**：JetBrains Mono（默认，连字可选）+ Maple Mono（中文等宽优化，内置候选）
- **品牌展示**：不设专用品牌字体，用 Inter SemiBold 的几何感即可

## 吉祥物

水獭名字 **Otty**（备用，用于空状态插画、错误页彩蛋、更新日志口吻）。
