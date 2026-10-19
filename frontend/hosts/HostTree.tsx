// HostTree（Task 5 Step 1）：分组树 + 标签过滤。
// （2026-10-10 树内搜索框移除：查找统一走侧栏顶部「搜索」⌘K 命令面板，
// 备注/标签匹配已并入其字段权重——见 palette/CommandPalette hostMatch。）
// 拖拽换组（2026-10-19 用户需求，仅组间移动）：主机行 HTML5 draggable，
// 分组头/未分组桶为放下目标——放下调 updateHost 改 group_id 持久化
// （hosts_update 现成接口；同组放下是 no-op 不发请求；拖拽中目标组高亮）。
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type Host } from "../vault/api";
import { useVaultStore } from "../vault/store";
import { useSessionStore } from "../session/SessionStore";

/** 拖拽数据 MIME 类型（dragover 判定「是不是我们的主机」的唯一依据）。 */
const HOST_DRAG_MIME = "application/x-ottr-host";

/** 分组折叠记忆（2026-10-16 用户需求：分组可折叠收起/展开）：值 = 折叠键数组
 * （命名分组 = String(group.id)；未分组哨兵见下）。沿「侧栏宽度」同款
 * localStorage 暂存口径（裁定 #2：settings 表落地后迁移）。 */
export const COLLAPSED_GROUPS_KEY = "ottr.layout.hostTree.collapsedGroups";
/** 未分组桶的折叠键（group_id=null 无 id 可用，哨兵字符串占位）。 */
const UNGROUPED_KEY = "__ungrouped__";

function loadCollapsed(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...set]));
  } catch {
    // 持久化失败不阻塞折叠功能本身
  }
}

export interface HostTreeProps {
  selectedId: number | null;
  /** 新建分组信号（2026-10-08 菜单栏启用批次）：File 菜单/汉堡 hosts.new_group
   * → App 计数递增；本组件 useEffect 展开分组输入。0 = 从未触发。 */
  newGroupSignal?: number;
  onSelect: (host: Host) => void;
  /** 双击主机行：打开会话标签并连接（Task 7 A6）。 */
  onOpen: (host: Host) => void;
  onEdit: (host: Host) => void;
  onAdd: (groupId: number | null) => void;
  /** 多选模式（Phase 3 Task 4，B6 批量执行）：行点击 = 切换勾选；双击打开/
      编辑/删除/主机管理工具栏全部让位（批量选择面不混管理动作）。 */
  multiSelect?: boolean;
  selectedIds?: ReadonlySet<number>;
  onToggle?: (host: Host) => void;
}


export function HostTree({
  selectedId,
  onSelect,
  onOpen,
  onEdit,
  onAdd,
  multiSelect = false,
  selectedIds,
  onToggle,
  newGroupSignal = 0,
}: HostTreeProps) {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);
  const hostGroups = useVaultStore((s) => s.hostGroups);
  const deleteHost = useVaultStore((s) => s.deleteHost);
  const createGroup = useVaultStore((s) => s.createGroup);
  const updateHost = useVaultStore((s) => s.updateHost);

  const [activeTags, setActiveTags] = useState<ReadonlySet<string>>(new Set());
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [grouping, setGrouping] = useState(false);
  // 拖拽换组（2026-10-19）：正在拖的主机 id + 悬停目标组（高亮）；同组放下
  // no-op。dropEffect=move；失败静默（store.refresh 收口全局 error 的先例）。
  const [dragHost, setDragHost] = useState<Host | null>(null);
  const [dropGroup, setDropGroup] = useState<number | null | undefined>(undefined);

  /** 放下：同组 no-op；否则 updateHost 持久化（input 全量重建——hosts_update
   * 语义是整行更新，拖拽只改 group_id 一字段，其余取现值）。 */
  function handleDropToGroup(targetGroupId: number | null) {
    setDropGroup(undefined);
    const host = dragHost;
    setDragHost(null);
    if (!host || host.group_id === targetGroupId) return;
    void updateHost(host.id, {
      protocol: host.protocol,
      name: host.name,
      group_id: targetGroupId,
      tags: host.tags,
      address: host.address,
      port: host.port,
      username: host.username,
      credential_id: host.credential_id,
      jump_chain_id: host.jump_chain_id,
      encoding_override: host.encoding_override,
      theme_override: host.theme_override,
      monitor_enabled: host.monitor_enabled,
      is_production: host.is_production,
      notes: host.notes,
    }).catch(() => {});
  }
  // 分组折叠态（2026-10-16）：默认全展开——空分组「先建组后填内容」路径
  // （BL-109 ①）不因折叠残留被吞；只记用户显式收起的组。
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(loadCollapsed);

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }

  // 菜单/汉堡「新建分组」信号：>0 即展开分组输入（外部入口复用树内同一表单）。
  useEffect(() => {
    if (newGroupSignal > 0) {
      setGroupError(null);
      setGrouping(true);
    }
  }, [newGroupSignal]);
  const [newGroupName, setNewGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  // 用户主动过滤态（标签）：空分组无意义，允许隐藏；默认浏览态必须
  // 渲染空分组——「先建组再填内容」是正常路径（BL-109 ①）。
  // （2026-10-10 移除树内搜索框：查找统一走侧栏顶部「搜索」⌘K，备注匹配
  // 已并入其字段权重——见 palette/CommandPalette hostMatch。）
  const filtering = activeTags.size > 0;

  const visibleByGroup = useMemo(() => {
    const source = hosts;
    const filtered =
      activeTags.size === 0
        ? source
        : source.filter((h) => [...activeTags].every((tag) => h.tags.includes(tag)));
    const byGroup = new Map<number | null, Host[]>();
    for (const h of filtered) {
      const bucket = byGroup.get(h.group_id) ?? [];
      bucket.push(h);
      byGroup.set(h.group_id, bucket);
    }
    return byGroup;
  }, [hosts, activeTags]);

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const h of hosts) for (const tag of h.tags) tags.add(tag);
    return [...tags].sort((a, b) => a.localeCompare(b));
  }, [hosts]);

  function toggleTag(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  /** 删除失败由 store.refresh 收口进全局 error，这里只吞 rejection。 */
  function handleDelete(id: number) {
    void deleteHost(id).catch(() => {});
  }

  function cancelGrouping() {
    setGrouping(false);
    setNewGroupName("");
    setGroupError(null);
  }

  async function submitNewGroup() {
    const name = newGroupName.trim();
    if (!name) return;
    // BL-109 ②：同名分组前端预校验（MVP 分组均为根级，与既有根级名比对）；
    // 后端拒绝（竞态兜底）同样行内可见——不再静默吞掉。
    if (hostGroups.some((g) => g.name === name)) {
      setGroupError(t("hostTree.groupDuplicate"));
      return;
    }
    try {
      await createGroup(name);
      setGrouping(false);
      setNewGroupName("");
      setGroupError(null);
    } catch (err) {
      setGroupError(t("hostTree.groupCreateFailed", { message: String(err) }));
    }
  }

  // 空态提示口径：过滤态看「有没有命中」；浏览态看「有没有内容可渲染」
  // （主机或分组任一存在即非空树——只有分组没主机也不是空库，BL-109 ①）。
  const hasVisible = filtering
    ? [...visibleByGroup.values()].some((list) => list.length > 0)
    : hosts.length > 0 || hostGroups.length > 0;

  return (
    <div className="host-tree">
      {/* 新建主机/新建分组上移侧栏快捷行（2026-10-10 用户裁定）：工具栏整体
          移除；多选模式本就让位，无其他工具项。 */}

      {grouping && (
        <div className="tree-new-group">
          <input
            value={newGroupName}
            placeholder={t("hostTree.groupNamePlaceholder")}
            aria-label={t("hostTree.addGroup")}
            onChange={(e) => {
              setNewGroupName(e.currentTarget.value);
              setGroupError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNewGroup();
              if (e.key === "Escape") cancelGrouping();
            }}
            autoFocus
          />
          <button onClick={() => void submitNewGroup()}>{t("common.ok")}</button>
          {/* 取消（2026-10-10 用户裁定：分组输入不得杵着关不掉）：Esc / ✕ 皆可 */}
          <button
            className="tree-new-group-cancel"
            data-testid="cancel-group"
            aria-label={t("common.cancel")}
            onClick={cancelGrouping}
          >
            ✕
          </button>
          {groupError && (
            <p className="tree-error" data-testid="group-name-error" role="alert">
              {groupError}
            </p>
          )}
        </div>
      )}

      {allTags.length > 0 && (
        <div className="tree-tags" role="group" aria-label={t("hostTree.tagsFilter")}>
          <button data-active={activeTags.size === 0} onClick={() => setActiveTags(new Set())}>
            {t("hostTree.allTags")}
          </button>
          {allTags.map((tag) => (
            <button key={tag} data-active={activeTags.has(tag)} onClick={() => toggleTag(tag)}>
              {tag}
            </button>
          ))}
        </div>
      )}


      {!hasVisible && (
        <p className="tree-empty" data-testid="tree-empty">
          {activeTags.size > 0 ? t("hostTree.noMatch") : t("hostTree.empty")}
        </p>
      )}

      {hostGroups.map((group) => {
        const groupHosts = visibleByGroup.get(group.id) ?? [];
        // 空分组：默认浏览态必须渲染（先建组后填内容路径，BL-109 ①）；
        // 仅用户主动过滤（搜索/标签）时空分组无命中才隐藏。
        if (filtering && groupHosts.length === 0) return null;
        const groupCollapsed = collapsed.has(String(group.id));
        return (
          <section
            key={group.id}
            className="tree-group"
            data-testid={`group-${group.name}`}
            data-collapsed={groupCollapsed ? "true" : undefined}
            data-drop-target={dropGroup === group.id ? "true" : undefined}
            onDragOver={(e) => {
              if (dragHost == null || dragHost.group_id === group.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropGroup(group.id);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDropGroup((prev) => (prev === group.id ? undefined : prev));
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDropToGroup(group.id);
            }}
          >
            <GroupHead
              name={group.name}
              onAdd={() => onAdd(group.id)}
              onToggle={() => toggleGroup(String(group.id))}
              collapsed={groupCollapsed}
              hostCount={groupHosts.length}
            />
            {!groupCollapsed && (
              <HostItems
                hosts={groupHosts}
                selectedId={selectedId}
                onSelect={onSelect}
                onOpen={onOpen}
                onEdit={onEdit}
                deletingId={deletingId}
                setDeletingId={setDeletingId}
                onDelete={handleDelete}
                multiSelect={multiSelect}
                selectedIds={selectedIds}
                onToggle={onToggle}
                onDragStart={setDragHost}
                onDragEnd={() => {
                  setDragHost(null);
                  setDropGroup(undefined);
                }}
              />
            )}
          </section>
        );
      })}

      {(() => {
        const ungrouped = visibleByGroup.get(null);
        if (!ungrouped || ungrouped.length === 0) return null;
        const ungroupedCollapsed = collapsed.has(UNGROUPED_KEY);
        return (
          <section
            className="tree-group"
            data-testid="group-ungrouped"
            data-collapsed={ungroupedCollapsed ? "true" : undefined}
            data-drop-target={dropGroup === null ? "true" : undefined}
            onDragOver={(e) => {
              if (dragHost == null || dragHost.group_id === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDropGroup(null);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDropGroup((prev) => (prev === null ? undefined : prev));
            }}
            onDrop={(e) => {
              e.preventDefault();
              handleDropToGroup(null);
            }}
          >
            <GroupHead
              name={t("hostTree.ungrouped")}
              onToggle={() => toggleGroup(UNGROUPED_KEY)}
              collapsed={ungroupedCollapsed}
              hostCount={ungrouped.length}
            />
            {!ungroupedCollapsed && (
              <HostItems
                hosts={ungrouped}
                selectedId={selectedId}
                onSelect={onSelect}
                onOpen={onOpen}
                onEdit={onEdit}
                deletingId={deletingId}
                setDeletingId={setDeletingId}
                onDelete={handleDelete}
                multiSelect={multiSelect}
                selectedIds={selectedIds}
                onToggle={onToggle}
                onDragStart={setDragHost}
                onDragEnd={() => {
                  setDragHost(null);
                  setDropGroup(undefined);
                }}
              />
            )}
          </section>
        );
      })()}

    </div>
  );
}

interface HostItemsProps {
  hosts: Host[];
  selectedId: number | null;
  onSelect: (host: Host) => void;
  onOpen: (host: Host) => void;
  onEdit: (host: Host) => void;
  deletingId: number | null;
  setDeletingId: (id: number | null) => void;
  onDelete: (id: number) => void;
  multiSelect?: boolean;
  selectedIds?: ReadonlySet<number>;
  onToggle?: (host: Host) => void;
  /** 拖拽换组（2026-10-19）：行 dragstart 上报主机；dragend 清态。 */
  onDragStart?: (host: Host) => void;
  onDragEnd?: () => void;
}

function HostItems({
  hosts,
  selectedId,
  onSelect,
  onOpen,
  onEdit,
  deletingId,
  setDeletingId,
  onDelete,
  multiSelect = false,
  selectedIds,
  onToggle,
  onDragStart,
  onDragEnd,
}: HostItemsProps) {
  const { t } = useTranslation();
  // 树内状态点（2026-10-16 视觉重设计 M3，报告 §4 P1「主机行状态」——仅页签
  // 圆点显示连接态的遗留项收口）：hostId → 档位，connected 优先、其次进行中
  // （connecting/reconnecting/waiting_host_key）；分屏 pane 不重复计。
  const sessions = useSessionStore((s) => s.sessions);
  const statusByHost = useMemo(() => {
    const map = new Map<number, "connected" | "busy">();
    for (const s of sessions) {
      if (s.paneOf !== null) continue;
      const prev = map.get(s.hostId);
      if (s.status === "connected") map.set(s.hostId, "connected");
      else if (
        prev !== "connected" &&
        (s.status === "connecting" || s.status === "reconnecting" || s.status === "waiting_host_key")
      ) {
        map.set(s.hostId, "busy");
      }
    }
    return map;
  }, [sessions]);
  return (
    <ul className="tree-hosts">
      {hosts.map((host) => {
        const subtitle = t("hostTree.hostSubtitle", {
          username: host.username ? `${host.username}@` : "",
          address: host.address,
          port: host.port,
        });
        // 多选模式（批量执行选择面）：行点击 = 切换勾选；管理动作让位
        if (multiSelect) {
          const checked = selectedIds?.has(host.id) ?? false;
          return (
            <li key={host.id} className="tree-host" data-checked={checked}>
              <button
                className="host-row"
                data-testid={`batch-host-${host.id}`}
                role="checkbox"
                aria-checked={checked}
                onClick={() => onToggle?.(host)}
              >
                {/* 自绘勾选为有意保留（Task 1 fix round 1，I-2 裁定落地）：
                    整行即勾选语义（行点击=切换），.host-check 仅是行内视觉
                    指示，且是 ui/ 基础控件 mint 家族的视觉基准来源；
                    ui/Checkbox 适用于表单内独立勾选，不适用此行级场景。 */}
                <span className="host-check" aria-hidden="true" />
                <span className="host-name">{host.name}</span>
                {host.tags.length > 0 && (
                  <span className="host-tags">
                    {host.tags.map((tag) => (
                      <span key={tag} className="host-tag">
                        {tag}
                      </span>
                    ))}
                  </span>
                )}
                <span className="host-subtitle">{subtitle}</span>
              </button>
            </li>
          );
        }
        const confirming = deletingId === host.id;
        return (
          <li
            key={host.id}
            className="tree-host"
            data-selected={selectedId === host.id}
            data-confirming={confirming || undefined}
            // 拖拽换组：多选模式让位（批量选择面不混拖拽）；draggable 与行内
            // 文本选择并存由浏览器默认裁决（拖起即拖拽，不进入选择）。
            draggable={onDragStart != null}
            onDragStart={(e) => {
              if (onDragStart == null) return;
              e.dataTransfer.setData(HOST_DRAG_MIME, String(host.id));
              e.dataTransfer.effectAllowed = "move";
              onDragStart(host);
            }}
            onDragEnd={onDragEnd}
          >
            <button
              className="host-row"
              onClick={() => onSelect(host)}
              onDoubleClick={() => onOpen(host)}
            >
              <span
                className="host-status-dot"
                data-status={statusByHost.get(host.id) ?? "offline"}
                aria-hidden
              />
              <span className="host-name">{host.name}</span>
              {host.tags.length > 0 && (
                <span className="host-tags">
                  {host.tags.map((tag) => (
                    <span key={tag} className="host-tag">
                      {tag}
                    </span>
                  ))}
                </span>
              )}
              <span className="host-subtitle">{subtitle}</span>
            </button>
            <span className="host-actions">
              <button
                className="icon-btn"
                aria-label={t("hostTree.editAria", { name: host.name })}
                onClick={() => onEdit(host)}
              >
                ✎
              </button>
              {confirming ? (
                <span className="host-confirm">
                  <span className="confirm-hint">{t("hostTree.confirmDelete")}</span>
                  <button className="icon-btn danger" onClick={() => onDelete(host.id)}>
                    {t("common.confirm")}
                  </button>
                  <button className="icon-btn" onClick={() => setDeletingId(null)}>
                    {t("common.cancel")}
                  </button>
                </span>
              ) : (
                <button
                  className="icon-btn danger"
                  aria-label={t("hostTree.deleteAria", { name: host.name })}
                  onClick={() => setDeletingId(host.id)}
                >
                  ✕
                </button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** 分组头（区块锚点）：折叠开关（chevron + 文件夹描边图标 + 组名）+ 悬停显现
 * 的「＋添加主机」（2026-10-09 用户要求：分组下直接加主机，分组自动预填）。
 * 开关是 h3 内的 button——heading 可访问名仍取自按钮文本 = 纯组名
 * （getByRole("heading", { name }) 测试口径），折叠计数徽标 aria-hidden 不吃
 * 可达名；「＋」按钮是 h3 的兄弟节点同前。折叠时组内主机行不渲染，计数徽标
 * 显隐台数（2026-10-16 折叠需求）。 */
function GroupHead({
  name,
  onAdd,
  onToggle,
  collapsed,
  hostCount,
}: {
  name: string;
  onAdd?: () => void;
  onToggle?: () => void;
  collapsed?: boolean;
  hostCount?: number;
}) {
  const { t } = useTranslation();
  return (
    <div className="tree-group-head">
      <h3 className="tree-group-title">
        <button
          type="button"
          className="tree-group-toggle"
          data-testid={`group-toggle-${name}`}
          aria-expanded={onToggle ? !collapsed : undefined}
          onClick={() => onToggle?.()}
        >
          <svg
            className="tree-group-chevron"
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
          <svg
            className="tree-group-icon"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M1.75 4.4c0-.63.5-1.15 1.13-1.15h3.05c.32 0 .63.14.85.38l1 1.1h5.34c.63 0 1.13.51 1.13 1.14v5.73c0 .63-.5 1.15-1.13 1.15H2.88c-.63 0-1.13-.52-1.13-1.15V4.4Z" />
          </svg>
          <span>{name}</span>
          {collapsed && (hostCount ?? 0) > 0 && (
            <span className="tree-group-count" aria-hidden="true">
              {hostCount}
            </span>
          )}
        </button>
      </h3>
      {onAdd && (
        <button
          type="button"
          className="tree-group-add icon-btn"
          data-testid={`group-add-${name}`}
          title={t("hostTree.addToGroup")}
          aria-label={t("hostTree.addToGroup")}
          onClick={(e) => {
            e.stopPropagation();
            onAdd();
          }}
        >
          ＋
        </button>
      )}
    </div>
  );
}
