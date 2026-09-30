# Ottr 品牌手册（v1）

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

## Logo

原型：几何水獭头像。圆润头形 + 半露圆耳 + 浅色吻部 + 三线胡须。全部由圆/椭圆/圆头线条构成，任意尺寸缩放不糊，16px 托盘尺寸仍可辨认（耳 + 头 + 眼三点结构）。

| 文件 | 用途 |
|---|---|
| `logo.svg` | 浅色背景（官网白底、文档、浅色主题关于页） |
| `logo-dark.svg` | 深色背景（深色主题、深色海报） |
| `icon.svg` | App 图标源文件（圆角方形渐变底 + 水獭），导出 icns/ico/png 的唯一源 |
| `tray-template.svg` | 菜单栏/托盘单色模板图标（macOS Template Image 自动适配明暗） |

**使用规范**
- 安全边距 ≥ 头部宽度的 12%；最小尺寸：彩色 24px、托盘 16px
- 不拉伸、不描边、不加阴影；胡须是识别关键，禁止删减
- 单色场景只用 `tray-template.svg` 的剪影结构

## 配色（同时是主题令牌的种子值）

| 令牌 | 值 | 语义 |
|---|---|---|
| `--ottr-teal-500` | `#14B8A6` | 主色 River Teal（连接、主按钮、非文字 accent：按钮底/边框/选中底） |
| `--ottr-teal-700` | `#0F766E` | 主色深（hover、标题强调） |
| `--ottr-teal-800` | `#115E59` | 主色深·文字对比专用（亮色主题 accent 文字色；fix 2 备案，见下） |
| `--ottr-teal-300` | `#5EEAD4` | 主色浅（暗色主题主色） |
| `--ottr-amber-500` | `#F59E0B` | 点缀 Otter Amber（收藏星标、AI 提示） |
| `--ottr-fur-600` | `#A9714B` | 毛色 Riverbank Brown（品牌插画、logo 主色） |
| `--ottr-fur-800` | `#8A5A3B` | 毛色深（耳、暗部） |
| `--ottr-cream-100` | `#F6E7D4` | 吻部 Cream（品牌插画浅色） |
| `--ottr-ink-900` | `#0F172A` | 墨色（五官、正文标题） |
| `--ottr-water-900` | `#0B2B33` | Deep Water（暗色主题背景基调） |

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
* 回归钉：`src/theme/tokens.test.ts`（解析 tokens.css 实算对比度，退回即红）。

**终端默认主题映射建议**（ANSI 16 色）：normal 色取品牌同色系低饱和值（red→#D97066 系、green→teal 系、yellow→amber 系、blue→水色系），bright 色取同色相高饱和值；前景 `--ottr-cream-100` 偏暖白，背景 `--ottr-water-900`。生产环境主机红色边框（B11）复用 ANSI red bright。

## 字体

- **UI**：Inter（拉丁）+ Noto Sans SC（中文），免授权费、三端渲染一致
- **终端**：JetBrains Mono（默认，连字可选）+ Maple Mono（中文等宽优化，内置候选）
- **品牌展示**：不设专用品牌字体，用 Inter SemiBold 的几何感即可

## 吉祥物

水獭名字 **Otty**（备用，用于空状态插画、错误页彩蛋、更新日志口吻）。
