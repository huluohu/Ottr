// HostTree（Task 5 Step 1）：分组树 + 标签过滤 + 搜索。
// 数据纪律：常规列表走 zustand store（loading/error 收口）；搜索是低频读取，
// 直取 vaultApi.hosts.search（Task 4 裁定：search 结果不进全局状态），
// 防抖 200ms + 序号守卫丢弃过期响应。
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { vaultApi, type Host } from "../vault/api";
import { useVaultStore } from "../vault/store";
import { useDebouncedValue } from "./useDebouncedValue";

export interface HostTreeProps {
  selectedId: number | null;
  onSelect: (host: Host) => void;
  onEdit: (host: Host) => void;
  onAdd: (groupId: number | null) => void;
  onImport: () => void;
}

const SEARCH_DEBOUNCE_MS = 200;

export function HostTree({ selectedId, onSelect, onEdit, onAdd, onImport }: HostTreeProps) {
  const { t } = useTranslation();
  const hosts = useVaultStore((s) => s.hosts);
  const hostGroups = useVaultStore((s) => s.hostGroups);
  const deleteHost = useVaultStore((s) => s.deleteHost);
  const createGroup = useVaultStore((s) => s.createGroup);

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, SEARCH_DEBOUNCE_MS);
  const [searchResults, setSearchResults] = useState<Host[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeTags, setActiveTags] = useState<ReadonlySet<string>>(new Set());
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [grouping, setGrouping] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  // 过期响应守卫：连输两词时只采纳最后一次发出的请求
  const searchSeq = useRef(0);

  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) {
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    const seq = ++searchSeq.current;
    vaultApi.hosts
      .search(q)
      .then((rows) => {
        if (searchSeq.current === seq) {
          setSearchResults(rows);
          setSearchError(null);
        }
      })
      .catch((e) => {
        if (searchSeq.current === seq) setSearchError(String(e));
      });
  }, [debouncedQuery]);

  const searching = searchResults !== null;

  const visibleByGroup = useMemo(() => {
    const source = searching ? searchResults ?? [] : hosts;
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
  }, [hosts, searchResults, activeTags, searching]);

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
    try {
      await createGroup(name);
      setGrouping(false);
      setNewGroupName("");
    } catch {
      // store.refresh 已把 error 收口，这里不重复展示
    }
  }

  async function runExport() {
    try {
      const path = await vaultApi.exportHostsCsv(null);
      setExportMsg(path);
    } catch (e) {
      setExportMsg(String(e));
    }
  }

  const hasVisible = [...visibleByGroup.values()].some((list) => list.length > 0);

  return (
    <div className="host-tree">
      <input
        className="tree-search"
        type="search"
        value={query}
        placeholder={t("hostTree.searchPlaceholder")}
        aria-label={t("common.search")}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />

      <div className="tree-toolbar">
        <button className="btn-accent" data-testid="add-host" onClick={() => onAdd(null)}>
          {t("hostTree.addHost")}
        </button>
        <button data-testid="add-group" onClick={() => setGrouping((v) => !v)}>
          {t("hostTree.addGroup")}
        </button>
        <button data-testid="import-ssh-config" onClick={onImport}>
          {t("hostTree.importSshConfig")}
        </button>
        <button data-testid="export-csv" onClick={() => void runExport()}>
          {t("hostTree.exportCsv")}
        </button>
      </div>

      {grouping && (
        <div className="tree-new-group">
          <input
            value={newGroupName}
            placeholder={t("hostTree.groupNamePlaceholder")}
            aria-label={t("hostTree.addGroup")}
            onChange={(e) => setNewGroupName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitNewGroup();
            }}
            autoFocus
          />
          <button onClick={() => void submitNewGroup()}>{t("common.ok")}</button>
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

      {searchError && <p className="tree-error">{searchError}</p>}

      {!hasVisible && (
        <p className="tree-empty" data-testid="tree-empty">
          {searching || activeTags.size > 0 ? t("hostTree.noMatch") : t("hostTree.empty")}
        </p>
      )}

      {hostGroups.map((group) => {
        const groupHosts = visibleByGroup.get(group.id);
        if (!groupHosts || groupHosts.length === 0) return null;
        return (
          <section key={group.id} className="tree-group" data-testid={`group-${group.name}`}>
            <h3>{group.name}</h3>
            <HostItems
              hosts={groupHosts}
              selectedId={selectedId}
              onSelect={onSelect}
              onEdit={onEdit}
              deletingId={deletingId}
              setDeletingId={setDeletingId}
              onDelete={handleDelete}
            />
          </section>
        );
      })}

      {(() => {
        const ungrouped = visibleByGroup.get(null);
        if (!ungrouped || ungrouped.length === 0) return null;
        return (
          <section className="tree-group" data-testid="group-ungrouped">
            <h3>{t("hostTree.ungrouped")}</h3>
            <HostItems
              hosts={ungrouped}
              selectedId={selectedId}
              onSelect={onSelect}
              onEdit={onEdit}
              deletingId={deletingId}
              setDeletingId={setDeletingId}
              onDelete={handleDelete}
            />
          </section>
        );
      })()}

      {exportMsg && <p className="tree-status">{exportMsg}</p>}
    </div>
  );
}

interface HostItemsProps {
  hosts: Host[];
  selectedId: number | null;
  onSelect: (host: Host) => void;
  onEdit: (host: Host) => void;
  deletingId: number | null;
  setDeletingId: (id: number | null) => void;
  onDelete: (id: number) => void;
}

function HostItems({
  hosts,
  selectedId,
  onSelect,
  onEdit,
  deletingId,
  setDeletingId,
  onDelete,
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
        return (
          <li key={host.id} className="tree-host" data-selected={selectedId === host.id}>
            <button className="host-row" onClick={() => onSelect(host)}>
              <span className="host-name">{host.name}</span>
              <span className="host-subtitle">{subtitle}</span>
            </button>
            <span className="host-tags">
              {host.tags.map((tag) => (
                <span key={tag} className="host-tag">
                  {tag}
                </span>
              ))}
            </span>
            <button
              className="icon-btn"
              aria-label={t("hostTree.editAria", { name: host.name })}
              onClick={() => onEdit(host)}
            >
              ✎
            </button>
            {deletingId === host.id ? (
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
          </li>
        );
      })}
    </ul>
  );
}
