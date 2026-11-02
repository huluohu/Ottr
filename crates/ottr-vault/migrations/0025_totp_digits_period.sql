-- 0025_totp_digits_period（2026-11-02 批次三）：TOTP 凭据的位数与步长可配。
--
-- 背景：交互式认证的自动填码此前**写死** 6 位 / 30 秒步长——那是 RFC 6238 的
-- 典型值，但不是唯一值：Steam 用 5 位、Azure/Okta 等可用 8 位，不少自建服务
-- 用 60 秒步长。写死的话，这些服务的自动填码**恒错**，用户只能手输，而界面
-- 仍提示「已自动填」（审计 2026-11-02 实测）。
--
-- 列：totp_digits / totp_period，均为**非敏感**配置（不参与加密域），明文存。
--   * totp_digits  NULL = 缺省 6 位（存量库语义不变）；
--   * totp_period  NULL = 缺省 30 秒（存量库语义不变）。
-- 不动 scan_registry（无新 *_enc 列，见迁移文件头惯例）。
ALTER TABLE credentials ADD COLUMN totp_digits INTEGER;
ALTER TABLE credentials ADD COLUMN totp_period INTEGER;
