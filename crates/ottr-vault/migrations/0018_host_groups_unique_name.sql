-- 0018_host_groups_unique_name：同级分组同名防重（BL-109 ②，Phase 5 Task 0）。
-- 口径：唯一性只在「同一 parent_id 内」生效（同组内不许同名、跨组允许同名）。
-- 为什么是两条部分唯一索引（CREATE UNIQUE INDEX … WHERE）而不是一条
-- (parent_id, name) 全索引：SQLite 唯一索引把 NULL 视为互不相等，而 MVP 分组
-- 全部是根级（parent_id = NULL）——单条全索引防不住「根级同名重复建组」这个
-- 用户实测命中的 exactly 场景。故分治：
--   * 根级：UNIQUE(name) WHERE parent_id IS NULL
--   * 非根级：UNIQUE(parent_id, name) WHERE parent_id IS NOT NULL
-- 存量去重（先于建索引执行）：历史缺陷窗口产生的同组同名行，保留最小 id 行
-- 原名不动，其余行改名「name (id)」——保行保绑定（组内主机 group_id 不动），
-- 绝不删行（删组会 FK SET NULL 解绑主机，等于销毁用户整理好的分组归属）；
-- 后缀用行 id（全局唯一）而非序号，避免与用户手建的「x (2)」式命名撞车。
-- 应用层（entities.rs HostGroups::create/update）同步做显式查重，返回可直接
-- 展示的 InvalidInput——索引是 DB 层兜底，不是用户错误的第一现场。
UPDATE host_groups
SET name = name || ' (' || host_groups.id || ')'
WHERE EXISTS (
    SELECT 1 FROM host_groups AS h2
    WHERE h2.name = host_groups.name
      AND (
            (h2.parent_id IS NULL AND host_groups.parent_id IS NULL)
            OR h2.parent_id = host_groups.parent_id
          )
      AND h2.id < host_groups.id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_host_groups_sibling_name_root
    ON host_groups (name) WHERE parent_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_host_groups_sibling_name_child
    ON host_groups (parent_id, name) WHERE parent_id IS NOT NULL;
