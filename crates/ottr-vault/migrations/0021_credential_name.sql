-- 0021: 凭据名称列（2026-10-10 用户要求：凭据多了要能自定义名称/标签区分）。
-- name = 用户可见的明文标签（非敏感，不参与加密域）；NULL = 未命名（UI 按 kind 兜底显示）。
-- 明文面，无 *_enc 列，不动 scan_registry（见迁移文件头）。
ALTER TABLE credentials ADD COLUMN name TEXT;
