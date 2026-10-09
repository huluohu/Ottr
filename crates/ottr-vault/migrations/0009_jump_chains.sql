-- 0009_jump_chains（Phase 2 Task 2，B7 下半；spec §3 jump_chains 实体）。
-- 明文配置面：链名 + hop 主机 id 列表不含任何密钥材料——无 *_enc 列、不经 AAD
-- 绑定、不涉 scan_registry（重密封扫描注册表），锁定语义与 hosts 同（实体命令
-- 面统一过 ensure_unlocked 门卫，见 desktop vault.rs）。
--
-- 列（spec §3）：
--   id         INTEGER PRIMARY KEY AUTOINCREMENT（沿用实体表惯例：免未来加
--              *_enc 时改表；前端列表 key 稳定）
--   name       链名（UI 展示；非空）
--   hops       JSON 数组：host_id 的**有序**列表——顺序即连接序
--              （hops[0] 本地直连，hops[i] 经 hops[i-1] 的 direct-tcpip 隧道；
--              末位之后接 target = 引用本链的 hosts 行）。反向链与正向链是
--              不同的链（顺序显著，测试钉住）。
--   created_at / updated_at  秒级 Unix 时间（实体表同口径）
--
-- 引用语义（偏差记录）：spec 补列方向是 hosts.jump_chain_id REFERENCES
-- jump_chains(id)；SQLite 不支持对既有列追加 REFERENCES（0002 文件头预留的
-- 「表落地时补 FK」不可按字面执行），重建 hosts 表又牵连 FTS5 触发器与
-- snippets 的外键重写，风险大于收益。本迁移裁定：hosts.jump_chain_id 保持
-- 普通列，FK 语义由存储层承担——JumpChains::delete 在事务内把引用该链的
-- hosts.jump_chain_id 置 NULL（= ON DELETE SET NULL），JumpChains::create/
-- update 校验 hops 指向的主机存在（= FK 存在性），tests/jump_chains_test.rs
-- 钉住两条语义。
--
-- 删除语义：jump_chains 是可复用实体（多主机共享一条链），删除不级联删主机，
-- 只解绑（同 credentials/host_groups 的 SET NULL 裁定；jump_chains.id 主键
-- AUTOINCREMENT 免 id 复用歧义）。
CREATE TABLE jump_chains (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    hops       TEXT NOT NULL DEFAULT '[]', -- JSON 数组：host_id 有序列表
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 编辑器/下拉主查询 = 全量按创建序（id 升序，配置列表稳定性优先）。
-- 按主机的过滤查询（哪些链引用了某台主机）走全量 list 后内存过滤即可
-- （链数量级小），不单列索引。
