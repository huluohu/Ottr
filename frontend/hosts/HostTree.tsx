// HostTree（Task 5 Step 1）：分组树 + 标签过滤。
// （2026-10-10 树内搜索框移除：查找统一走侧栏顶部「搜索」⌘K 命令面板，
// 备注/标签匹配已并入其字段权重——见 palette/CommandPalette hostMatch。）
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { type Host } from "../vault/api";
import { useVaultStore } from "../vault/store";

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
  onImport: () => void;
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
  onImport,
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

  const [activeTags, setActiveTags] = useState<ReadonlySet<string>>(new Set());
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [grouping, setGrouping] = useState(false);
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
      {/* 多选模式（批量执行选择面）：主机管理工具栏让位 */}
      {!multiSelect && (
        <div className="tree-toolbar">
          <button className="btn-accent" data-testid="add-host" onClick={() => onAdd(null)}>
            {t("hostTree.addHost")}
          </button>
          <button data-testid="add-group" onClick={() => {
            setGroupError(null);
            setGrouping((v) => !v);
          }}>
            {t("hostTree.addGroup")}
          </button>
          <button data-testid="import-ssh-config" onClick={onImport}>
            {t("hostTree.importSshConfig")}
          </button>
        </div>
      )}

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
            }}
            autoFocus
          />
          <button onClick={() => void submitNewGroup()}>{t("common.ok")}</button>
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
        return (
          <section key={group.id} className="tree-group" data-testid={`group-${group.name}`}>
            <GroupHead name={group.name} onAdd={() => onAdd(group.id)} />
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
            />
          </section>
        );
      })}

      {(() => {
        const ungrouped = visibleByGroup.get(null);
        if (!ungrouped || ungrouped.length === 0) return null;
        return (
          <section className="tree-group" data-testid="group-ungrouped">
            <GroupHead name={t("hostTree.ungrouped")} />
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
            />
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
}: HostItemsProps) {
  const { t } = useTranslation();
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
          >
            <button
              className="host-row"
              onClick={() => onSelect(host)}
              onDoubleClick={() => onOpen(host)}
            >
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

/** 分组头（区块锚点）：文件夹描边图标 + 分组名，弱化色不抢行内容的戏；
 * onAdd 给出时渲染悬停显现的「＋添加主机」（2026-10-09 用户要求：分组下
 * 直接加主机，分组自动预填）。按钮是 h3 的兄弟节点——heading 可访问名
 * 保持纯组名（getByRole("heading", { name }) 测试口径）。 */
function GroupHead({ name, onAdd }: { name: string; onAdd?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="tree-group-head">
      <h3 className="tree-group-title">
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
