//! FilePanel 远端文件操作收口（Task 10 Step 2/3）。
//!
//! 封装 russh-sftp 的 [`RawSftpSession`]：目录浏览（opendir/readdir）、mkdir /
//! rename / 删除 / chmod / stat / realpath。**russh-sftp 类型不出 crate 公共
//! API**（I-1 同款纪律，与 ottr-ssh Error 的类型擦除同思路）——命令面
//! （src-tauri）只见 [`SftpClient`] 与 serde 的 [`DirEntry`]。
//!
//! ## 为什么远端操作走 SFTP 而不是 exec（Task 10 裁定记录）
//!
//! - 结构化结果：readdir 直接拿 name/size/mode/mtime，不用解析 `ls -la` 文本
//!   （本地化/对齐列/边角文件名的转义地狱）；
//! - 免 shell 引号地狱：rename/mkdir 的路径不经过 shell，任何怪文件名安全；
//! - 权限口径一致：chmod 走 setstat permissions，与列目录展示的 mode 位同一
//!   SFTP 属性集；exec 路径在编码（Task 9）/本地化（LC_ALL）下输出不可控。
//! - 通道成本：复用既有 SSH 连接开一条 subsystem channel（懒开 + 随会话表项
//!   缓存，见 src-tauri SessionEntry）。
//!
//! 取消语义不适用本模块：单请求操作天然短命（无 chunk 边界可检查），失败即返回。

use std::sync::Arc;

use ottr_ssh::SshSession;
use russh_sftp::client::RawSftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, StatusCode};

use crate::{Error, Result};

/// 目录项（serde 直出 src-tauri 命令面）。`mode` 为 POSIX 权限位（含类型位，
/// 与 chmod 回写同一口径）；`mtime` 为秒级 Unix 时间。
#[derive(Debug, Clone, serde::Serialize)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mode: u32,
    pub mtime: u32,
}

fn protocol_error(e: impl std::error::Error + Send + Sync + 'static, ctx: &str) -> Error {
    Error::Protocol {
        message: format!("{ctx}: {e}"),
        source: Some(Box::new(e)),
    }
}

/// readdir 收尾的 EOF（OpenSSH：目录读尽返回 SSH_FX_EOF）。
fn is_eof(e: &SftpError) -> bool {
    matches!(e, SftpError::Status(s) if s.status_code == StatusCode::Eof)
}

fn entry_from(name: String, attrs: &FileAttributes) -> DirEntry {
    DirEntry {
        name,
        is_dir: attrs.is_dir(),
        size: attrs.size.unwrap_or(0),
        mode: attrs.permissions.unwrap_or(0),
        mtime: attrs.mtime.unwrap_or(0),
    }
}

/// 一条 SFTP 会话上的远端文件操作收口。`&self` 方法可并发调用
/// （RawSftpSession 按请求 id 配对响应，与传输路径同款前提）。
pub struct SftpClient {
    inner: Arc<RawSftpSession>,
}

impl SftpClient {
    /// 从既有 SSH 会话开 SFTP 子系统并握手——**复用连接**（在会话的 russh
    /// handle 上开新 channel，不新建 SSH 连接；Task 10 设计裁定）。
    pub async fn open(session: &SshSession) -> Result<Self> {
        let stream = session.open_sftp_stream().await?;
        let inner = Arc::new(RawSftpSession::new(stream));
        inner
            .init()
            .await
            .map_err(|e| protocol_error(e, "sftp init"))?;
        Ok(Self { inner })
    }

    /// 解析路径为绝对路径（远端 home 展开的锚点；`realpath(".")` = home）。
    pub async fn realpath(&self, path: &str) -> Result<String> {
        let name = self
            .inner
            .realpath(path)
            .await
            .map_err(|e| protocol_error(e, &format!("realpath {path}")))?;
        Ok(name.files.into_iter().next().map(|f| f.filename).unwrap_or(path.to_string()))
    }

    /// stat 单个路径（目录/文件通用；不存在返回 Err）。
    pub async fn stat(&self, path: &str) -> Result<DirEntry> {
        let attrs = self
            .inner
            .stat(path)
            .await
            .map_err(|e| protocol_error(e, &format!("stat {path}")))?;
        let name = path.rsplit('/').next().unwrap_or(path).to_string();
        Ok(entry_from(name, &attrs.attrs))
    }

    /// 列目录（不含 `.`/`..`；按 readdir EOF 收尾）。
    pub async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let handle = self
            .inner
            .opendir(path)
            .await
            .map_err(|e| protocol_error(e, &format!("opendir {path}")))?
            .handle;
        let mut out = Vec::new();
        loop {
            match self.inner.readdir(handle.as_str()).await {
                Ok(name) => {
                    for f in name.files {
                        if f.filename == "." || f.filename == ".." {
                            continue;
                        }
                        out.push(entry_from(f.filename, &f.attrs));
                    }
                }
                Err(e) if is_eof(&e) => break,
                Err(e) => {
                    let _ = self.inner.close(handle.clone()).await;
                    return Err(protocol_error(e, &format!("readdir {path}")));
                }
            }
        }
        self.inner
            .close(handle)
            .await
            .map_err(|e| protocol_error(e, &format!("closedir {path}")))?;
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    /// 新建目录（0755；远端 umask 可再收窄）。
    pub async fn mkdir(&self, path: &str) -> Result<()> {
        self.inner
            .mkdir(
                path,
                FileAttributes {
                    permissions: Some(0o755),
                    ..FileAttributes::default()
                },
            )
            .await
            .map_err(|e| protocol_error(e, &format!("mkdir {path}")))?;
        Ok(())
    }

    /// 重命名（同文件系统内；目标已存在由服务器拒绝，UI 层提示）。
    pub async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.inner
            .rename(from, to)
            .await
            .map_err(|e| protocol_error(e, &format!("rename {from} -> {to}")))?;
        Ok(())
    }

    /// 删除文件。
    pub async fn remove_file(&self, path: &str) -> Result<()> {
        self.inner
            .remove(path)
            .await
            .map_err(|e| protocol_error(e, &format!("remove {path}")))?;
        Ok(())
    }

    /// 删除空目录（非空由服务器拒绝——递归删除不进 MVP，宁可显式失败）。
    pub async fn remove_dir(&self, path: &str) -> Result<()> {
        self.inner
            .rmdir(path)
            .await
            .map_err(|e| protocol_error(e, &format!("rmdir {path}")))?;
        Ok(())
    }

    /// chmod（`mode` 为完整 POSIX 权限位，如 0o644）。
    pub async fn chmod(&self, path: &str, mode: u32) -> Result<()> {
        self.inner
            .setstat(
                path,
                FileAttributes {
                    permissions: Some(mode),
                    ..FileAttributes::default()
                },
            )
            .await
            .map_err(|e| protocol_error(e, &format!("chmod {mode:o} {path}")))?;
        Ok(())
    }

    /// 目录/文件是否存在（stat 探测；FilePanel 上传前的目标提示用）。
    pub async fn exists(&self, path: &str) -> Result<bool> {
        match self.inner.stat(path).await {
            Ok(_) => Ok(true),
            Err(e) if matches!(&e, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile) => {
                Ok(false)
            }
            Err(e) => Err(protocol_error(e, &format!("stat {path}"))),
        }
    }
}
