// Ask Ottr 悬浮球状态（Ask Ottr Task 4）：功能开关 + 边缘锚定位置。
//
// 铁律：
//   * 开关真源 = vault settings `ui.askOttrOrb`（Rust 侧已注册，boolean 校验）；
//     本 store 持镜像。`enabled: null` = **尚未从 vault 加载**——消费面（组件）
//     对 null 一律隐藏，防「默认开先闪一帧再被真源改掉」的闪烁；读档失败收敛
//     为默认开（ottyStore 同口径：读不出配置不该把功能变哑）。
//   * 位置 = **本机 localStorage**（ottr.askOrb.pos），永不进 vault——窗口布局
//     是本机偏好，不该跨设备同步（与侧栏宽度同口径）；读档校验形状 + 钳制
//     fraction（手改 localStorage 塞垃圾只回默认位，不崩）。
//   * setEnabled 乐观镜像 + 异步落库：落库走**串行链**且每步执行时重读当前
//     期望值——快速连点后磁盘终值恒等于最后一次 toggle（旧保存结果永不覆盖
//     新选择，plan 变更序号条款）；代数计数只管镜像/报错面（迟到的旧保存
//     失败静默，当前代失败弹 error toast「已生效但保存失败」）。保存失败
//     **不回滚镜像**（会话内体验优先，重启后以 vault 为准）。
//
// 【为何静态 import vaultApi】ottyStore 用动态 import 是 ui/otty 层的启动惰性
// 惯例；本 store 在 ai 域，aiStore 同域先例就是静态 import（aiStore.ts 顶部
// vaultApi）——静态面下 vitest 的 vi.mock 拦截才是确定性的（动态 import 在
// vitest 5 模块运行器下偶发解析到真模块，测试面变成竞态）。非 Tauri 环境
// （纯浏览器 dev）下 invoke 同步抛错，try/catch + Promise.resolve 归一化后
// 仍走同一失败面（静默 or toast，按调用路径）。
import { create } from "zustand";
import i18n from "../i18n";
import { showToast } from "../ui/toastStore";
import { vaultApi } from "../vault/api";

export type OrbEdge = "left" | "right" | "top" | "bottom";

/** 边缘锚定位置：edge = 吸附边；fraction = 沿该边 0..1（相对可拖拽域）。
 * 只存边+分数，不存绝对坐标（窗口一变就废）。 */
export interface OrbPosition {
  edge: OrbEdge;
  fraction: number;
}

/** vault settings 键（Rust ottr-vault settings.rs 已注册 boolean 校验）。 */
export const ORB_SETTING_KEY = "ui.askOttrOrb";
/** 位置 localStorage 键（本机 only，永不入 vault/同步）。 */
export const ORB_POSITION_KEY = "ottr.askOrb.pos";

/** 无存档时的默认落点：右缘居中（离快捷操作区近、不压左轨）。 */
export const ORB_DEFAULT_POSITION: OrbPosition = { edge: "right", fraction: 0.5 };

const EDGES: readonly OrbEdge[] = ["left", "right", "top", "bottom"];

function isOrbEdge(e: unknown): e is OrbEdge {
  return typeof e === "string" && (EDGES as readonly string[]).includes(e);
}

/** 位置校验 + 钳制（读档/写入唯一口径）：edge 限四边、fraction 限 0..1，
 * 非法整体弃用（null = 用默认位）。 */
export function normalizePosition(p: unknown): OrbPosition | null {
  if (typeof p !== "object" || p === null) return null;
  const { edge, fraction } = p as { edge?: unknown; fraction?: unknown };
  if (!isOrbEdge(edge)) return null;
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  return { edge, fraction: Math.min(1, Math.max(0, fraction)) };
}

/** localStorage 读档（store 初始化 + 组件测试共用）。 */
export function readStoredPosition(): OrbPosition | null {
  try {
    const raw = localStorage.getItem(ORB_POSITION_KEY);
    if (raw === null) return null;
    return normalizePosition(JSON.parse(raw));
  } catch {
    return null;
  }
}

interface OrbStore {
  /** 功能开关镜像；null = 尚未从 vault 加载（消费面对 null 隐藏，防闪烁）。 */
  enabled: boolean | null;
  /** 边缘锚定位置；null = 未定制（用 ORB_DEFAULT_POSITION）。 */
  position: OrbPosition | null;
  /** 设置页开关写入：乐观镜像 + vault 落库（代数计数防迟到旧保存搅局）。 */
  setEnabled: (v: boolean) => void;
  /** 拖拽落点：钳制 + localStorage 持久化（仅本机）。 */
  setPosition: (p: OrbPosition) => void;
  /** 重置位置（设置页「重置悬浮球位置」）：清存档即回默认位。 */
  resetPosition: () => void;
}

/** 保存代数：每次 setEnabled 递增；异步保存完成后仅当代数仍最新才可发言
 * （toast）。迟到的旧保存——无论成败——一律静默。 */
let saveGeneration = 0;

/** 落库串行链（plan：变更序号防旧保存结果覆盖新选择）：每次 setEnabled 追加
 * 一步，严格按本地操作序落盘；每一步执行时**重读当前期望值**再写——即便某
 * 笔旧保存先落了盘，排在后面的步骤也会用最新值覆盖，链尾必胜（快速连点后
 * 磁盘值 = 最后一次 toggle，与各笔 invoke 的完成顺序无关）。步骤自身吞错 →
 * 链永不断裂、无 unhandled rejection。 */
let saveChain: Promise<void> = Promise.resolve();

function enqueueSave(gen: number): void {
  const step = async (): Promise<void> => {
    const desired = useOrbStore.getState().enabled;
    if (typeof desired !== "boolean") return; // 未加载态无值可写（防御）
    try {
      await Promise.resolve(vaultApi.settings.set(ORB_SETTING_KEY, desired));
    } catch {
      // 镜像不回滚（已生效；重启后以 vault 为准），但失败必须可见——
      // 仅当前代报错：中间步骤的失败会被后续步骤重写，报出来就是谎报。
      if (gen === saveGeneration) {
        showToast(i18n.t("settings.askOttrOrbSaveFailed"), "error");
      }
    }
  };
  saveChain = saveChain.then(step);
}

export const useOrbStore = create<OrbStore>()((set) => ({
  enabled: null,
  position: readStoredPosition(),
  setEnabled: (v) => {
    set({ enabled: v });
    const gen = ++saveGeneration;
    enqueueSave(gen);
  },
  setPosition: (p) => {
    const pos = normalizePosition(p) ?? ORB_DEFAULT_POSITION;
    try {
      localStorage.setItem(ORB_POSITION_KEY, JSON.stringify(pos));
    } catch {
      // 持久化失败不阻塞（本次会话内位置仍在镜像里）
    }
    set({ position: pos });
  },
  resetPosition: () => {
    try {
      localStorage.removeItem(ORB_POSITION_KEY);
    } catch {
      // 清不掉存档也不阻塞镜像归位
    }
    set({ position: null });
  },
}));

/** vault 真源 → store 镜像（App 就绪链 + 同步导入后各调一次；失败保持默认开）。
 * 直写镜像不走 setEnabled——对齐不是用户写入，不该触发回写/报错面。 */
export async function syncOrbFromVault(): Promise<void> {
  try {
    const v = await vaultApi.settings.get<boolean>(ORB_SETTING_KEY);
    // 键不存在（undefined/null）= 从未配置 → 默认开（并脱离「未加载」态）
    useOrbStore.setState({ enabled: typeof v === "boolean" ? v : true });
  } catch {
    // 非 Tauri 环境（纯浏览器 dev / vitest）或读档失败：保持默认开
    useOrbStore.setState({ enabled: true });
  }
}
