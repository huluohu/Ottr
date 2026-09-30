//! Task 6（A4）：keygen 生成/指纹/导入测试。
//!
//! 指纹 golden 策略（裁定 #1）：生成是随机的，**生成密钥的指纹不可能 golden**——
//! golden 只落在 `tests/fixtures/` 里的固定测试密钥上，断言值即
//! `ssh-keygen -lf tests/fixtures/<key>.pub` 的输出（2026-09-29 生成时采集）：
//! ```text
//! 256 SHA256:qSN7JTePqMBmh4z4GPwkowdywkdV5ldIt1p5cwdRQPw ottr-keygen-golden (ED25519)
//! 256 SHA256:f8TvmisjmAG/5XjlAaKDAU2/za3LuWqzkT4sh6Fo2fQ ottr-keygen-golden-enc (ED25519)
//! 256 SHA256:njsl7KFtJtNO6sgvqX1xxk+zpX4OV6zweQ4xpNdhllY ottr-keygen-golden-ecdsa (ECDSA)
//! 2048 SHA256:AR4stfGflOlgfYF+LjbMIQ//5JhvFUJ/DW1ykdDZgWE ottr-keygen-golden-rsa (RSA)
//! ```
//! 生成密钥只验证「russh 能加载 + 指纹格式合法（SHA256: + 43 字符标准 base64）+
//! 私钥/公钥指纹一致」的往返性质。

use std::path::PathBuf;

use ottr_ssh::keygen::{KeyAlgorithm, generate, inspect, parse_public_key};
use ottr_ssh::KeyError;

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures");

fn fixture(name: &str) -> String {
    std::fs::read_to_string(PathBuf::from(FIXTURES).join(name))
        .unwrap_or_else(|e| panic!("read tests/fixtures/{name}: {e}"))
}

/// 指纹格式：`SHA256:` + 43 字符无填充标准 base64（base64 字符集）。
fn assert_fingerprint_shape(fp: &str) {
    let body = fp
        .strip_prefix("SHA256:")
        .unwrap_or_else(|| panic!("fingerprint must start with SHA256:, got {fp}"));
    assert_eq!(body.len(), 43, "sha256 fingerprint body must be 43 chars: {fp}");
    assert!(
        body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/'),
        "fingerprint body must be standard base64: {fp}"
    );
}

// --- golden：固定夹具指纹与 ssh-keygen -lf 一致 ------------------------------

#[test]
fn keygen_golden_ed25519_fingerprint_matches_ssh_keygen() {
    let key = inspect(&fixture("test_ed25519"), None).expect("inspect unencrypted fixture");
    assert_eq!(key.algorithm, KeyAlgorithm::Ed25519);
    assert_eq!(
        key.fingerprint, "SHA256:qSN7JTePqMBmh4z4GPwkowdywkdV5ldIt1p5cwdRQPw",
        "must equal `ssh-keygen -lf test_ed25519.pub`"
    );
    assert!(key.public_openssh.starts_with("ssh-ed25519 "));
}

#[test]
fn keygen_golden_ecdsa_rsa_imports_match_ssh_keygen() {
    let ecdsa = inspect(&fixture("test_ecdsa"), None).expect("inspect ecdsa fixture");
    assert_eq!(ecdsa.algorithm, KeyAlgorithm::EcdsaP256);
    assert_eq!(
        ecdsa.fingerprint, "SHA256:njsl7KFtJtNO6sgvqX1xxk+zpX4OV6zweQ4xpNdhllY",
        "must equal `ssh-keygen -lf test_ecdsa.pub`"
    );
    let rsa = inspect(&fixture("test_rsa"), None).expect("inspect rsa fixture");
    assert_eq!(rsa.algorithm, KeyAlgorithm::Rsa);
    assert_eq!(
        rsa.fingerprint, "SHA256:AR4stfGflOlgfYF+LjbMIQ//5JhvFUJ/DW1ykdDZgWE",
        "must equal `ssh-keygen -lf test_rsa.pub`"
    );
}

#[test]
fn keygen_encrypted_fixture_import_requires_and_verifies_passphrase() {
    let pem = fixture("test_ed25519_enc");
    // 缺口令 → 明确的 PassphraseRequired
    let err = inspect(&pem, None).unwrap_err();
    assert!(matches!(err, KeyError::PassphraseRequired), "got: {err:?}");
    // 正确口令 → 指纹 golden
    let key = inspect(&pem, Some("ottr-fixture-pass")).expect("inspect with passphrase");
    assert_eq!(
        key.fingerprint, "SHA256:f8TvmisjmAG/5XjlAaKDAU2/za3LuWqzkT4sh6Fo2fQ",
        "must equal `ssh-keygen -lf test_ed25519_enc.pub`"
    );
    // 错误口令 → 明确的 PassphraseRequired（不是笼统 Invalid）
    let err = inspect(&pem, Some("wrong-passphrase")).unwrap_err();
    assert!(matches!(err, KeyError::PassphraseRequired), "got: {err:?}");
}

// --- 生成 → russh 加载往返 ----------------------------------------------------

#[test]
fn keygen_generated_ed25519_roundtrips_through_russh_load() {
    let key = generate(KeyAlgorithm::Ed25519, None, "roundtrip-test").expect("generate");
    assert_eq!(key.algorithm, KeyAlgorithm::Ed25519);
    assert!(key.private_openssh.contains("BEGIN OPENSSH PRIVATE KEY"));
    assert!(key.public_openssh.starts_with("ssh-ed25519 "));
    assert!(key.public_openssh.ends_with(" roundtrip-test"), "comment preserved");
    assert_fingerprint_shape(&key.fingerprint);

    // 私钥 PEM 再经 russh decode_secret_key 加载：指纹一致 = 往返成立
    let reloaded = inspect(&key.private_openssh, None).expect("reload generated key");
    assert_eq!(reloaded.fingerprint, key.fingerprint);
    assert_eq!(reloaded.public_openssh, key.public_openssh);

    // 公钥行单独解析：同一指纹
    let pub_fp = parse_public_key(&key.public_openssh).expect("parse public line");
    assert_eq!(pub_fp.fingerprint, key.fingerprint);
}

#[test]
fn keygen_generated_encrypted_key_loads_only_with_passphrase() {
    let key =
        generate(KeyAlgorithm::Ed25519, Some("gen-pass"), "enc-roundtrip").expect("generate enc");
    // openssh 加密标记藏在 base64 内，PEM 明文无 "ENCRYPTED" 字样——
    // 加密与否的判据就是「缺口令加载报 PassphraseRequired」（下方断言）。

    let err = inspect(&key.private_openssh, None).unwrap_err();
    assert!(matches!(err, KeyError::PassphraseRequired), "got: {err:?}");
    let ok = inspect(&key.private_openssh, Some("gen-pass")).expect("correct passphrase");
    assert_eq!(ok.fingerprint, key.fingerprint);
}

#[test]
fn keygen_generated_ecdsa_p256_roundtrips() {
    let key = generate(KeyAlgorithm::EcdsaP256, None, "ecdsa-roundtrip").expect("generate");
    assert_eq!(key.algorithm, KeyAlgorithm::EcdsaP256);
    assert!(key.public_openssh.starts_with("ecdsa-sha2-nistp256 "));
    let reloaded = inspect(&key.private_openssh, None).expect("reload");
    assert_eq!(reloaded.fingerprint, key.fingerprint);
    assert_fingerprint_shape(&key.fingerprint);
}

/// RSA 生成（ssh-key 固定 4096 位，debug 下可达数十秒）挂 `#[ignore]`，
/// 手测：`cargo test -p ottr-ssh --release -- --ignored keygen`（task-6 报告记录实测）。
#[test]
#[ignore = "RSA-4096 生成耗时（debug 数十秒），随 RSA 导入矩阵一起人工验证"]
fn keygen_generated_rsa_roundtrips() {
    let key = generate(KeyAlgorithm::Rsa, None, "rsa-roundtrip").expect("generate");
    assert_eq!(key.algorithm, KeyAlgorithm::Rsa);
    assert!(key.public_openssh.starts_with("ssh-rsa "));
    let reloaded = inspect(&key.private_openssh, None).expect("reload");
    assert_eq!(reloaded.fingerprint, key.fingerprint);
    assert_fingerprint_shape(&key.fingerprint);
}

// --- 非法输入 -----------------------------------------------------------------

#[test]
fn keygen_garbage_input_reports_invalid() {
    let err = inspect("not a key at all", None).unwrap_err();
    assert!(matches!(err, KeyError::Invalid { .. }), "got: {err:?}");
}
