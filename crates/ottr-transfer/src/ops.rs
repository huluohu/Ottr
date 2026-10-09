//! FilePanel 远端文件操作收口（Task 10 Step 2/3）。
//!
//! 封装 russh-sftp 的 [`RawSftpSession`]：目录浏览（opendir/readdir）、mkdir /
//! rename / 删除 / chmod / stat / realpath。**russh-sftp 类型不出 crate 公共
//! API**（I-1 同款纪律，与 ottr-ssh Error 的类型擦除同思路）——命令面
//! （desktop）只见 [`SftpClient`] 与 serde 的 [`DirEntry`]。
//!
//! ## 为什么远端操作走 SFTP 而不是 exec（Task 10 裁定记录）
//!
//! - 结构化结果：readdir 直接拿 name/size/mode/mtime，不用解析 `ls -la` 文本
//!   （本地化/对齐列/边角文件名的转义地狱）；
//! - 免 shell 引号地狱：rename/mkdir 的路径不经过 shell，任何怪文件名安全；
//! - 权限口径一致：chmod 走 setstat permissions，与列目录展示的 mode 位同一
//!   SFTP 属性集；exec 路径在编码（Task 9）/本地化（LC_ALL）下输出不可控。
//! - 通道成本：复用既有 SSH 连接开一条 subsystem channel（懒开 + 随会话表项
//!   缓存，见 desktop SessionEntry）。
//!
//! 取消语义不适用本模块：单请求操作天然短命（无 chunk 边界可检查），失败即返回。

use std::sync::Arc;

use ottr_ssh::SshSession;
use russh_sftp::client::RawSftpSession;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};

use crate::{Error, Result};

/// 目录项（serde 直出 desktop 命令面）。`mode` 为 POSIX 权限位（含类型位，
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
        Ok(name
            .files
            .into_iter()
            .next()
            .map(|f| f.filename)
            .unwrap_or(path.to_string()))
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

    // --- 远端文件本地编辑原语（Phase 2 Task 3，B10 上半） -------------------
    //
    // 选型裁定（task-3-report §选型）：编辑场景是几 KB～几 MB 的小文件，走
    // **单通道顺序读写**，不启用 download/upload_parallel 的并行分块 + journal
    // 机制——journal 的价值在「GB 级传输中断后续传」，对小文件编辑是纯开销
    // （journal 文件比内容还大），且并行分块对几 KB 文件毫无吞吐收益。

    /// 读取整个远端文件（单通道顺序读，读尽 EOF 收尾；字节原样返回，
    /// "text" 是场景名不是编码承诺——编辑链路全程不做编码转换）。
    pub async fn open_remote_text(&self, path: &str) -> Result<Vec<u8>> {
        let handle = self
            .inner
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await
            .map_err(|e| protocol_error(e, &format!("open remote {path}")))?
            .handle;
        let (read_block, _) = crate::sftp::probe_block_sizes(&self.inner, handle.as_str()).await;
        let mut out = Vec::new();
        let mut offset: u64 = 0;
        loop {
            match self.inner.read(handle.as_str(), offset, read_block).await {
                Ok(data) => {
                    if data.data.is_empty() {
                        break; // 服务器 EOF（OpenSSH 读尽返回空数据）
                    }
                    offset += data.data.len() as u64;
                    out.extend_from_slice(&data.data);
                }
                Err(e) if is_eof(&e) => break, // 部分 SFTP 服务器以 SSH_FX_EOF 收尾
                Err(e) => {
                    let _ = self.inner.close(handle.clone()).await;
                    return Err(protocol_error(e, &format!("read remote {path}")));
                }
            }
        }
        self.inner
            .close(handle)
            .await
            .map_err(|e| protocol_error(e, &format!("close remote {path}")))?;
        Ok(out)
    }

    /// 全量覆盖回传，返回**写后 stat**——回传方以此更新冲突快照，绝不沿用
    /// 下载时旧快照（否则下次回传必自冲突）。
    ///
    /// ## BL-204④ 原子性（换装语义）
    ///
    /// 旧实现 `CREATE|TRUNCATE|WRITE` 原地逐块写：open 即截断，中段块失败
    /// （网络断/远端盘满）= 远端停留**截断态**；自愈依赖调用方下轮全量重传，
    /// 会话一旦消亡（本地副本被清）远端永久残缺。现实现改**同目录换装**：
    /// 1. 先写同目录临时件（[`tmp_swap_path_for`]）——**原文件全程不被触碰**，
    ///    临时件写失败（含逐块中断）即清理退出，远端只见原文件；
    /// 2. setstat 临时件 = 原 mode（换装产生新 inode，不吃这一步会拿服务器
    ///    默认 umask，0600 敏感文件被静默放宽——显式失败优于静默漂移）；
    /// 3. remove 旧件 + rename 临时件上位（SFTP v3 rename 目标已存在即失败，
    ///    posix-rename 扩展非普适；remove→rename 间是毫秒级「缺失」窗口且
    ///    内容无损——临时件持有全量，下轮保存自愈）。NoSuchFile 容忍 = 对
    ///    已被第三方删除的文件 force 覆盖照常可用。
    ///
    /// 已知边界（与主流编辑器原子保存同款取舍，刻意成文）：
    /// * 符号链接目标走 [`Self::write_remote_text_inplace`] 原地写——换装会
    ///   用常规文件顶掉链接本身，写穿透语义优先；
    /// * 换装需要目标目录写权限（不可写目录上的可写文件将保存失败——vim 等
    ///   原子保存编辑器同款约束）；
    /// * 硬链接换装后分叉（rename 换 inode）。
    pub async fn write_remote_text(&self, path: &str, data: &[u8]) -> Result<DirEntry> {
        // lstat 只做「符号链接分流」与权限快照：任何错误（含 NoSuchFile =
        // force 覆盖已消失文件）不阻断保存——旧实现不做 lstat，不新增拒绝面。
        let lstat = self.inner.lstat(path).await.ok();
        if lstat
            .as_ref()
            .and_then(|a| a.attrs.permissions)
            .is_some_and(mode_is_symlink)
        {
            return self.write_remote_text_inplace(path, data).await;
        }
        let keep_mode = lstat.and_then(|a| a.attrs.permissions).map(|m| m & 0o7777);

        let tmp_path = tmp_swap_path_for(path);
        if let Err(e) = self.write_single_channel(&tmp_path, data).await {
            // 临时件写失败：原文件未被触碰，best-effort 清理临时件
            // （连接已死则清理静默失败，残留语义见 tmp_swap_path_for）
            let _ = self.inner.remove(&tmp_path).await;
            return Err(e);
        }
        if let Some(mode) = keep_mode
            && let Err(e) = self
                .inner
                .setstat(
                    &tmp_path,
                    FileAttributes {
                        permissions: Some(mode),
                        ..FileAttributes::default()
                    },
                )
                .await
        {
            let _ = self.inner.remove(&tmp_path).await;
            return Err(protocol_error(e, &format!("setstat {tmp_path}")));
        }
        if let Err(e) = self.inner.remove(path).await
            && !matches!(&e, SftpError::Status(s) if s.status_code == StatusCode::NoSuchFile)
        {
            // 原文件在位且不可换（如 sticky 目录他人文件）：保存失败，
            // 原文完好——临时件留作下轮重传的证据与材料
            return Err(protocol_error(e, &format!("remove for swap {path}")));
        }
        self.inner
            .rename(&tmp_path, path)
            .await
            .map_err(|e| protocol_error(e, &format!("rename swap {tmp_path} -> {path}")))?;
        self.stat(path).await
    }

    /// 单通道顺序全量写（CREATE|TRUNCATE|WRITE + 逐块写 + close；写失败先
    /// 收回 handle——旧实现错误路径泄漏 handle 直到会话销毁）。换装路径写
    /// 临时件、原地路径写目标本体共用。
    async fn write_single_channel(&self, path: &str, data: &[u8]) -> Result<()> {
        let handle = self
            .inner
            .open(
                path,
                OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                FileAttributes::empty(),
            )
            .await
            .map_err(|e| protocol_error(e, &format!("open remote {path}")))?
            .handle;
        let (_, write_block) = crate::sftp::probe_block_sizes(&self.inner, handle.as_str()).await;
        let mut offset: u64 = 0;
        while offset < data.len() as u64 {
            let end = (offset as usize + write_block as usize).min(data.len());
            match self
                .inner
                .write(handle.as_str(), offset, data[offset as usize..end].to_vec())
                .await
            {
                Ok(_) => offset = end as u64,
                Err(e) => {
                    let _ = self.inner.close(handle.clone()).await;
                    return Err(protocol_error(e, &format!("write remote {path} @{offset}")));
                }
            }
        }
        self.inner
            .close(handle)
            .await
            .map_err(|e| protocol_error(e, &format!("close remote {path}")))?;
        Ok(())
    }

    /// 原地全量覆盖写（BL-204④ 前的既有语义）：符号链接目标走这里保写穿透。
    /// 截断窗口仅此分支按符号链接形态保留（罕见路径，用户显式选择了链接形态）。
    async fn write_remote_text_inplace(&self, path: &str, data: &[u8]) -> Result<DirEntry> {
        self.write_single_channel(path, data).await?;
        self.stat(path).await
    }
}

/// BL-204④：换装临时件名（**同目录**——SFTP rename 不保证跨目录/跨文件系统；
/// 固定后缀便于失败后下一轮重传复用清空）。残留语义：进程崩溃/连接死亡时
/// 可能留下 `{path}.ottr-tmp`（与编辑器 swap 文件同类残留；同路径下次成功
/// 保存即被 CREATE|TRUNCATE 覆盖回收）。
pub(crate) fn tmp_swap_path_for(path: &str) -> String {
    format!("{path}.ottr-tmp")
}

/// BL-204④：lstat 权限位的文件类型判定（POSIX 类型位）——符号链接走原地
/// 写（保留既有写穿透语义），其余形态走换装。
fn mode_is_symlink(mode: u32) -> bool {
    mode & 0o170_000 == 0o120_000
}

/// 回传冲突检测的远端状态快照（Phase 2 Task 3）：下载时捕获，回传前与
/// 远端实时 stat 比对——不一致即「远端已被第三方改动」，由 UI 提示覆盖。
///
/// 判定依据 = size + mtime 双字段（SFTP v3 属性集的全部时间/大小信息）；
/// 已知粒度边界：mtime 秒级，第三方在**同一秒内**做同 size 改写时无法侦出
/// （SFTP 协议无内容哈希属性，属固有边界而非实现缺陷，task-3-report 有记）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct RemoteSnapshot {
    pub size: u64,
    /// 秒级 Unix 时间（与 [`DirEntry::mtime`] 同口径）。
    pub mtime: u32,
}

impl RemoteSnapshot {
    /// 下载/打开编辑会话时捕获。
    pub fn capture(entry: &DirEntry) -> Self {
        Self {
            size: entry.size,
            mtime: entry.mtime,
        }
    }

    /// 远端当前状态与快照是否不一致（= 冲突，回传需用户裁定）。
    pub fn conflicts_with(&self, current: &DirEntry) -> bool {
        self.size != current.size || self.mtime != current.mtime
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// BL-204④：换装临时件名推导——同目录、固定后缀（rename 不跨目录）。
    #[test]
    fn tmp_swap_path_keeps_directory() {
        assert_eq!(
            tmp_swap_path_for("/var/www/a.txt"),
            "/var/www/a.txt.ottr-tmp"
        );
        assert_eq!(tmp_swap_path_for("/x"), "/x.ottr-tmp");
    }

    /// BL-204④：lstat 类型位判定符号链接（写穿透分流的依据）。
    #[test]
    fn mode_is_symlink_classification() {
        assert!(mode_is_symlink(0o120_777));
        assert!(mode_is_symlink(0o120_600));
        assert!(!mode_is_symlink(0o100_644), "regular file is not a symlink");
        assert!(!mode_is_symlink(0o040_755), "directory is not a symlink");
        assert!(!mode_is_symlink(0), "no type bits is not a symlink");
    }

    fn entry(size: u64, mtime: u32) -> DirEntry {
        DirEntry {
            name: "f.txt".into(),
            is_dir: false,
            size,
            mode: 0o100644,
            mtime,
        }
    }

    /// Phase 2 Task 3 冲突判定语义（纯单测，无夹具）：
    /// 快照捕获 → 任意字段漂移即冲突；双字段一致才放行。
    #[test]
    fn snapshot_conflict_semantics() {
        let snap = RemoteSnapshot::capture(&entry(100, 1700000000));
        assert!(
            !snap.conflicts_with(&entry(100, 1700000000)),
            "identical stat: no conflict"
        );
        assert!(
            snap.conflicts_with(&entry(101, 1700000000)),
            "size drift: conflict"
        );
        assert!(
            snap.conflicts_with(&entry(100, 1700000001)),
            "mtime drift: conflict"
        );
        assert!(snap.conflicts_with(&entry(0, 0)), "both drift: conflict");
        // 第三方截短到 0 也必须被侦出（空文件不是「没变」）
        assert!(snap.conflicts_with(&entry(0, 1700000000)));
        // Copy 语义：快照是值，捕获后不受原 DirEntry 变化影响
        let mut later = entry(100, 1700000000);
        let s2 = RemoteSnapshot::capture(&later);
        later.mtime = 1;
        assert!(!s2.conflicts_with(&entry(100, 1700000000)));
        assert_eq!(snap, s2);
    }
}
