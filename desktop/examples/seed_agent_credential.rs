//! 真机 E2E 夹具（开发用工具，不进产品）：建一条 **系统 ssh-agent 凭据**。
//!
//! 与 `seed_totp_credential` 同款定位：走 vault 的真存储路径建凭据（裸 SQL 不行），
//! 供真机验收脚本触发「ssh-agent 桥接」这条认证路径。
//!
//! agent 凭据**不存任何密钥材料**（`kind='agent'`，无 `secret`）——私钥留在
//! agent 进程里，Ottr 只借用签名能力。
//!
//! 用法：
//! ```text
//! XDG_DATA_HOME=/tmp/ottr-verify/data ./target/debug/examples/seed_agent_credential
//! ```

use ottr_vault::{CredentialInput, CredentialKind, Credentials, Vault};

fn main() -> Result<(), String> {
    let data_dir =
        std::env::var("XDG_DATA_HOME").map_err(|_| "XDG_DATA_HOME not set".to_string())?;
    let vault_dir = format!("{data_dir}/com.ottr.app");

    let vault =
        Vault::open_auto(std::path::Path::new(&vault_dir)).map_err(|e| format!("open: {e}"))?;

    let cred = Credentials::create(
        &vault,
        &CredentialInput {
            kind: CredentialKind::Agent,
            name: Some("E2E ssh-agent 凭据".into()),
            secret: None,
            key_pub: None,
            passphrase: None,
            totp_secret: None,
            totp_digits: None,
            totp_period: None,
        },
    )
    .map_err(|e| format!("create credential: {e}"))?;

    println!("credential_id={}", cred.id);
    Ok(())
}
