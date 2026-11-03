//! 系统 ssh-agent 桥接（2026-11-02 批次五 P2）。
//!
//! **为什么**：把私钥放进 Ottr 的 vault 意味着私钥被 Ottr 持有；很多用户更希望
//! 私钥留在系统 agent（ssh-agent / 1Password agent / macOS Keychain 的
//! ssh-agent 桥）里，Ottr 只**借用**签名能力——Ottr 里不存私钥、也看不到私钥。
//!
//! **协议面**：直接用 russh 自带的 agent 客户端（`russh::keys::agent::client`），
//! 不自造协议实现：
//! * `connect_env()` —— 取 `$SSH_AUTH_SOCK`（unix）；
//! * `connect_uds(path)` —— 显式 socket 路径（unix）；
//! * `connect_named_pipe(path)` —— Windows 命名管道（OpenSSH 兼容 agent）；
//! * `connect_pageant()` —— Windows Pageant。
//!
//! **认证面**：russh 的 `authenticate_publickey_with` 接受**外部签名器**
//! （`russh::auth::Signer`）——服务端发来待签数据，签名器转给 agent，agent
//! 私钥不出进程。这正是 agent 认证的形态：Ottr 永远拿不到私钥。
//!
//! **平台口径（批次五裁定：macOS/Linux 先做）**：unix 走 `$SSH_AUTH_SOCK`
//! （socket），Windows 走命名管道/Pageant——两端都实现，但**页面与文案**先按
//! unix 口径落地（Windows 的命名管道 agent 需用户自行启动 OpenSSH agent）。
//!
//! **多身份**：agent 里通常有多把钥匙——逐个尝试，服务端拒掉某把就换下一把
//! （与 `ssh` 的行为一致）。

use std::path::Path;

use russh::keys::HashAlg;
use russh::keys::agent::AgentIdentity;
use russh::keys::agent::client::{AgentClient, AgentStream};

/// 类型擦除后的 agent 客户端：unix（UDS）与 windows（命名管道）的流类型不同，
/// 擦除后上层逻辑一份。
pub type DynAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

/// agent 侧错误（连接/协议/签名）。
#[derive(Debug)]
pub enum AgentError {
    /// russh agent 客户端错误（连接失败、协议错、agent 拒绝签名…）。
    ///
    /// russh 0.63 把 agent 客户端的 Error 列为**私有**（无法在类型上引用），
    /// 故此处存其 Display 文本——面向用户的错误面只需要这句话。
    Client(String),
    /// 事件循环不可达（russh 内部发送失败）。
    Send(russh::SendError),
    /// agent 里**没有可用身份**（没加密钥 / agent 未运行）。
    NoIdentities,
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Client(m) => write!(f, "ssh-agent: {m}"),
            Self::Send(e) => write!(f, "ssh-agent: {e}"),
            Self::NoIdentities => write!(f, "ssh-agent holds no identities"),
        }
    }
}

impl std::error::Error for AgentError {}

impl From<russh::SendError> for AgentError {
    fn from(e: russh::SendError) -> Self {
        Self::Send(e)
    }
}

/// 已连接的 agent 会话（客户端 + 身份清单）。
pub struct AgentSession {
    client: DynAgentClient,
    identities: Vec<AgentIdentity>,
}

impl AgentSession {
    /// 连接系统 agent 并列出身份。
    ///
    /// * `socket` = `Some(path)` → 连该路径（unix：UDS；windows：命名管道）；
    /// * `socket` = `None` → 取环境（unix：`$SSH_AUTH_SOCK`；windows：Pageant）。
    ///
    /// 连接成功但**没有身份**不算失败（返回 `Ok` 且身份清单为空）——调用面
    /// 自行决定是「无凭据可用」还是「用户还没往 agent 里加密钥」。
    pub async fn connect(socket: Option<&Path>) -> Result<Self, AgentError> {
        let mut client = connect_client(socket).await?;
        let identities = client
            .request_identities()
            .await
            .map_err(|e| AgentError::Client(e.to_string()))?;
        Ok(Self { client, identities })
    }

    /// agent 持有的身份（公钥 + 注释）。
    pub fn identities(&self) -> &[AgentIdentity] {
        &self.identities
    }

    /// 供 [`russh::auth::Signer`] 用的签名器（借用本会话的连接）。
    pub fn signer(&mut self) -> AgentSigner<'_> {
        AgentSigner {
            client: &mut self.client,
        }
    }
}

/// 借用 agent 连接实现的签名器。
pub struct AgentSigner<'a> {
    client: &'a mut DynAgentClient,
}

impl russh::Signer for AgentSigner<'_> {
    type Error = AgentError;

    async fn auth_sign(
        &mut self,
        key: &AgentIdentity,
        hash_alg: Option<HashAlg>,
        to_sign: Vec<u8>,
    ) -> Result<Vec<u8>, Self::Error> {
        self.client
            .sign_request(key, hash_alg, to_sign)
            .await
            .map_err(|e| AgentError::Client(e.to_string()))
    }
}

/// 按平台连接 agent 客户端。
#[cfg(unix)]
async fn connect_client(socket: Option<&Path>) -> Result<DynAgentClient, AgentError> {
    let client = match socket {
        Some(p) => AgentClient::connect_uds(p).await,
        None => AgentClient::connect_env().await,
    }
    .map_err(|e| AgentError::Client(e.to_string()))?;
    Ok(client.dynamic())
}

/// 按平台连接 agent 客户端（Windows：命名管道 / Pageant）。
///
/// **两个 connect 返回不同的流类型**（命名管道 `NamedPipeClient` vs
/// `PageantStream`）——不能塞进同一个 `match`（合成一个类型）：Windows
/// 交叉编译才会报 `expected NamedPipeClient, found PageantStream`（v1.6.1
/// 流水线在 Windows 平台构建阶段暴露）。这里各自 `dynamic()` 擦除后汇合。
#[cfg(windows)]
async fn connect_client(socket: Option<&Path>) -> Result<DynAgentClient, AgentError> {
    match socket {
        Some(p) => {
            // Windows 上 OpenSSH agent 暴露的是命名管道（\\.\pipe\openssh-ssh-agent）。
            let client = AgentClient::connect_named_pipe(p.as_os_str())
                .await
                .map_err(|e| AgentError::Client(e.to_string()))?;
            Ok(client.dynamic())
        }
        None => {
            let client = AgentClient::connect_pageant()
                .await
                .map_err(|e| AgentError::Client(e.to_string()))?;
            Ok(client.dynamic())
        }
    }
}

/// 非 unix 非 windows（wasm 等）——agent 不可用。
#[cfg(not(any(unix, windows)))]
async fn connect_client(_socket: Option<&Path>) -> Result<DynAgentClient, AgentError> {
    Err(AgentError::NoIdentities)
}
