//! PTY 通道操作面（russh 收口层）：[`crate::SshTransport::Channel`]（trait
//! 边界上唯一的 russh 类型泄漏点）的消费封装。
//!
//! 消费方（desktop 合批转发循环 / ottr-bench 排空任务）只依赖本模块的
//! 自有类型与函数，**不再直接依赖 russh**：通道类型以 [`PtyChannel`] 别名
//! 命名，消息面归一为 [`PtyEvent`]，shell / resize / writer 各有薄封装。
//! russh 仍是传输实现；未来切 libssh2 时改动收敛在本 crate（SshTransport
//! 文档的 libssh2 fallback 适配点）。

/// 会话 PTY 通道类型（= `SshTransport::Channel` 的具体形态）。
pub type PtyChannel = russh::Channel<russh::client::Msg>;

/// PTY 消息归一枚举（`russh::ChannelMsg` 的消费子集 + `Other` 兜底）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    /// 正常/扩展数据（stderr 合并进同一变体：会话场景 stderr 稀少，
    /// 合批转发对二者同语义，分帧无收益）。持有消息缓冲（`bytes::Bytes`
    /// 廉价 clone），消费方按 `&[u8]` 使用。
    Data(bytes::Bytes),
    /// 对端报告退出码（交互 shell 退出；当前消费方忽略）。
    ExitStatus(u32),
    /// 对端 EOF（半关；消费方按 flush 信号处理）。
    Eof,
    /// 通道关闭。
    Close,
    /// 其余消息（通道请求等；当前消费方忽略）。
    Other,
}

/// 读取下一条 PTY 消息；`None` = 通道已关闭（与 [`PtyEvent::Close`] 同为
/// 终态，消费方统一按「对端关闭」处理——russh 会话任务关停不逐一 close
/// 通道，两条路径都真实可达，见 ottr-bench disconnect 收尾注释）。
pub async fn next_pty_event(channel: &mut PtyChannel) -> Option<PtyEvent> {
    Some(match channel.wait().await? {
        russh::ChannelMsg::Data { data } => PtyEvent::Data(data),
        russh::ChannelMsg::ExtendedData { data, .. } => PtyEvent::Data(data),
        russh::ChannelMsg::ExitStatus { exit_status } => PtyEvent::ExitStatus(exit_status),
        russh::ChannelMsg::Eof => PtyEvent::Eof,
        russh::ChannelMsg::Close => PtyEvent::Close,
        _ => PtyEvent::Other,
    })
}

/// 请求在通道上起交互 shell（want_reply = true，与既有调用语义一致）。
pub async fn request_shell(channel: &mut PtyChannel) -> crate::Result<()> {
    channel.request_shell(true).await?;
    Ok(())
}

/// 下发 PTY 尺寸变更（对端转发 SIGWINCH：readline 重绘提示符/回显区）。
pub async fn resize(channel: &mut PtyChannel, cols: u32, rows: u32) -> crate::Result<()> {
    channel.window_change(cols, rows, 0, 0).await?;
    Ok(())
}

/// PTY 输入端 writer（`tokio::io::AsyncWrite` 面；击键直传，与会话表项的
/// `Box<dyn AsyncWrite>` 装箱面同型）。
pub fn writer(channel: &PtyChannel) -> impl tokio::io::AsyncWrite + Send + Unpin + 'static {
    channel.make_writer()
}
