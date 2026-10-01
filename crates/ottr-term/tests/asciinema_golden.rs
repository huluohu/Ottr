//! asciinema v2 格式 golden 测试（Task 5 Step 1）：`tests/golden/cast_*.cast`
//! 与测试内常量互为锚——encode(常量) 逐字节等于文件、parse(文件) 等于期望事件。
//! 覆盖：经典 ASCII 流 / CJK + OSC 133 + SGR 流；非 "o" 事件与截断残行不进
//! golden（容错语义在 asciinema.rs 单测）。
use ottr_term::asciinema::{CastEvent, CastHeader, CastRecording, parse};

fn cast_path(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/golden")
        .join(name)
}

fn basic_recording() -> CastRecording {
    CastRecording {
        header: CastHeader::new(80, 24, 1_760_000_000),
        events: vec![
            CastEvent {
                time: 0.0,
                data: "spike@ottr:~$ ".into(),
            },
            CastEvent {
                time: 0.512,
                data: "echo hello".into(),
            },
            CastEvent {
                time: 0.8445,
                data: "\r\nhello\r\n".into(),
            },
            CastEvent {
                time: 1.25,
                data: "spike@ottr:~$ ".into(),
            },
        ],
    }
}

fn cjk_recording() -> CastRecording {
    CastRecording {
        header: CastHeader::new(120, 40, 1_760_000_100),
        events: vec![
            CastEvent {
                time: 0.0,
                data: "\x1b]133;A\x1b\\root@web:~$ ".into(),
            },
            CastEvent {
                time: 0.1,
                data: "\x1b]133;B\x1b\\".into(),
            },
            CastEvent {
                time: 0.3,
                data: "echo 中文部署".into(),
            },
            CastEvent {
                time: 0.9,
                data: "\r\n中文部署\r\n\x1b]133;D;0\x1b\\".into(),
            },
            CastEvent {
                time: 1.0,
                data: "exit\r\n".into(),
            },
            CastEvent {
                time: 1.4,
                data: "logout\r\n".into(),
            },
        ],
    }
}

/// encode(常量) 逐字节等于 golden 文件——序列化形态（6 位小数时间 / 转义 /
/// header 形态）被文件钉死，防止无声漂移。
#[test]
fn golden_cast_files_match_constants_byte_for_byte() {
    for (file, rec) in [
        ("cast_basic.cast", basic_recording()),
        ("cast_cjk.cast", cjk_recording()),
    ] {
        let committed = std::fs::read_to_string(cast_path(file))
            .unwrap_or_else(|e| panic!("read {file}: {e}（golden 随代码一起提交）"));
        assert_eq!(
            rec.encode(),
            committed,
            "{file}: encode drifted from golden"
        );
    }
}

/// parse(golden 文件) 等于期望事件——解析面读回逐事件一致（含 CJK 与 OSC 序列）。
#[test]
fn golden_cast_files_parse_back_to_expected_events() {
    for (file, rec) in [
        ("cast_basic.cast", basic_recording()),
        ("cast_cjk.cast", cjk_recording()),
    ] {
        let committed = std::fs::read_to_string(cast_path(file)).expect("read golden cast file");
        let parsed = parse(&committed).unwrap_or_else(|e| panic!("{file}: {e}"));
        assert_eq!(parsed, rec, "{file}: parse drifted from golden");
        assert_eq!(
            parsed.duration(),
            rec.duration(),
            "{file}: duration derived from last event"
        );
    }
}

/// asciinema 官方播放器对 v2 的可读性下界：header 是合法 JSON 且 version=2
/// （本仓 golden 与 asciinema 工具链互通的形态锚）。
#[test]
fn golden_headers_are_version_2() {
    for file in ["cast_basic.cast", "cast_cjk.cast"] {
        let committed = std::fs::read_to_string(cast_path(file)).expect("read golden cast file");
        let header: CastHeader =
            serde_json::from_str(committed.lines().next().expect("header line"))
                .expect("golden header is valid json");
        assert_eq!(header.version, 2);
    }
}
