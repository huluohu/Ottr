//! 真机 E2E 夹具（开发用工具，不进产品）：在 vault 里建一条 **TOTP 凭据**。
//!
//! 为什么不用裸 sqlite3：`credentials.totp_secret_enc` 是 AES-256-GCM 密文
//! （主密钥派生，AAD 绑定 `credentials:{id}:totp_secret`），裸 SQL 写进去解不开
//! ——必须走 `Credentials::create` 的真加密路径。
//!
//! 用途：`scripts/device-verify-batch5.sh` 的真机验收需要一条 TOTP 凭据去触发
//! keyboard-interactive 交互式认证（该路径要求主机绑 TOTP 凭据）。
//!
//! 用法：
//! ```text
//! XDG_DATA_HOME=/tmp/ottr-verify/data \
//!   ./target/debug/examples/seed_totp_credential [base32 种子]
//! ```
//! 输出：`credential_id=<id>`（供夹具脚本写主机行用）。

use ottr_vault::{CredentialInput, CredentialKind, Credentials, Vault};

fn main() -> Result<(), String> {
    let data_dir =
        std::env::var("XDG_DATA_HOME").map_err(|_| "XDG_DATA_HOME not set".to_string())?;
    let vault_dir = format!("{data_dir}/com.ottr.app");
    // RFC 6238 测试向量同款种子（16 字节 base32）
    let seed = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into());

    let vault =
        Vault::open_auto(std::path::Path::new(&vault_dir)).map_err(|e| format!("open: {e}"))?;

    let cred = Credentials::create(
        &vault,
        &CredentialInput {
            kind: CredentialKind::Totp,
            name: Some("E2E TOTP 凭据".into()),
            secret: None,
            key_pub: None,
            passphrase: None,
            totp_secret: Some(seed.clone()),
            totp_digits: None,
            totp_period: None,
        },
    )
    .map_err(|e| format!("create credential: {e}"))?;

    println!("credential_id={}", cred.id);
    println!("seed={seed}");
    Ok(())
}
