//! 定位（positioned）整段读写的跨平台封装。
//!
//! unix 走 [`std::os::unix::fs::FileExt`]（`pwrite`/`pread` 语义，短读短写由
//! std 兜齐）；Windows 走 [`std::os::windows::fs::FileExt`] 的 `seek_write`/
//! `seek_read`（OVERLAPPED 定位 I/O，逐次处理短写短读）。两条路径都**不经过
//! 共享文件游标**——多 worker 并发持有同一 `Arc<File>` 分块写盘互不串位；
//! 游标语义的 `read`/`write`/`seek` 不得与这两个 helper 混用于同一句柄
//! （sftp.rs 双侧 worker、ftp.rs RETR 落盘均遵守此约定）。

use std::fs::File;
use std::io;

/// 定位写整段：把 `buf` 完整写到文件 `offset` 处（处理短写）。
pub fn pwrite_all(file: &File, offset: u64, buf: &[u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.write_all_at(buf, offset)
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut offset = offset;
        let mut buf = buf;
        while !buf.is_empty() {
            let n = file.seek_write(buf, offset)?;
            buf = &buf[n..];
            offset += n as u64;
        }
        Ok(())
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (file, offset, buf);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "positioned I/O is unsupported on this platform",
        ))
    }
}

/// 定位读整段：从文件 `offset` 处完整读满 `buf`（处理短读，EOF 即错）。
pub fn pread_exact(file: &File, offset: u64, buf: &mut [u8]) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_exact_at(buf, offset)
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut offset = offset;
        let mut buf: &mut [u8] = buf;
        while !buf.is_empty() {
            let n = file.seek_read(buf, offset)?;
            if n == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "positioned read hit EOF before filling buffer",
                ));
            }
            buf = &mut buf[n..];
            offset += n as u64;
        }
        Ok(())
    }

    #[cfg(not(any(unix, windows)))]
    {
        let _ = (file, offset, buf);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "positioned I/O is unsupported on this platform",
        ))
    }
}
