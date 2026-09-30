//! crypto TDD（Task 3 Loop 1）：固定密钥向量往返与密文结构、AAD 不匹配必 Err、
//! 1000 次 nonce 唯一性抽样（spec §3：随机 nonce + AAD 绑定实体，防密文换绑）。

use ottr_vault::{Cipher, VaultError};

// 固定 32 字节测试密钥：不派生、不随机，保证向量可复现。
const KEY: [u8; 32] = [
    0x5a, 0x2c, 0x11, 0x9e, 0x0d, 0x71, 0xf3, 0x84, 0x6b, 0xa0, 0x22, 0xc7, 0x91, 0x3e, 0x55, 0xd8,
    0x04, 0xbb, 0x7f, 0x60, 0xe2, 0x1a, 0x93, 0x4c, 0xd6, 0x08, 0x87, 0x3b, 0xf9, 0x40, 0x76, 0xad,
];
const NONCE: [u8; 12] = [7; 12];
const PLAINTEXT: &[u8] = b"ottr: credential secret for vector test";

#[test]
fn fixed_key_vector_roundtrip_and_structure() {
    let cipher = Cipher::new(&KEY).expect("32B key is valid");

    // 密文结构确定：nonce(12B 前置) || 密文 || GCM tag(16B)。
    // 结构断言走 seal_with_nonce（随机 nonce 无法预知前 12 字节）。
    let blob = cipher
        .seal_with_nonce(&NONCE, PLAINTEXT, "credentials:42:secret")
        .unwrap();
    assert_eq!(blob.len(), 12 + PLAINTEXT.len() + 16);
    assert_eq!(&blob[..12], &NONCE[..], "nonce 不前置前 12 字节");

    // 同 key + 同 nonce + 同 aad → 密文逐字节确定（固定向量）。
    let again = cipher
        .seal_with_nonce(&NONCE, PLAINTEXT, "credentials:42:secret")
        .unwrap();
    assert_eq!(blob, again);

    // 正常路径 seal（随机 nonce）往返一致。
    let sealed = cipher.seal(PLAINTEXT, "credentials:42:secret").unwrap();
    assert_eq!(sealed.len(), 12 + PLAINTEXT.len() + 16);
    assert_eq!(cipher.open(&sealed, "credentials:42:secret").unwrap(), PLAINTEXT);

    // 往返：open 还原明文。
    let opened = cipher.open(&blob, "credentials:42:secret").unwrap();
    assert_eq!(opened, PLAINTEXT);
}

#[test]
fn aad_mismatch_must_err() {
    let cipher = Cipher::new(&KEY).unwrap();
    let blob = cipher.seal(PLAINTEXT, "credentials:42:secret").unwrap();

    // AAD 纪律：aad = "{table}:{row_id}:{field}"，换绑到另一行/另一字段必须失败。
    for tampered in [
        "credentials:43:secret",
        "credentials:42:passphrase",
        "hosts:42:secret",
    ] {
        match cipher.open(&blob, tampered) {
            Err(VaultError::Crypto(_)) => {}
            other => panic!("AAD 换绑 {tampered} 应报 Crypto 错，实际 {:?}", other.is_ok()),
        }
    }
    // 原始 AAD 仍可解。
    assert_eq!(cipher.open(&blob, "credentials:42:secret").unwrap(), PLAINTEXT);
}

#[test]
fn wrong_key_must_err() {
    let cipher = Cipher::new(&KEY).unwrap();
    let other = Cipher::new(&[0xAB; 32]).unwrap();
    let blob = cipher.seal(PLAINTEXT, "credentials:42:secret").unwrap();
    assert!(other.open(&blob, "credentials:42:secret").is_err());
}

#[test]
fn nonce_unique_across_1000_seals() {
    let cipher = Cipher::new(&KEY).unwrap();
    let mut nonces = std::collections::HashSet::new();
    for i in 0..1000 {
        let blob = cipher.seal(b"x", "credentials:1:secret").unwrap();
        assert_eq!(
            nonces.insert(blob[..12].to_vec()),
            true,
            "第 {i} 次出现重复 nonce"
        );
    }
    assert_eq!(nonces.len(), 1000);
}

#[test]
fn aad_helper_follows_discipline() {
    // AAD 纪律字符串由 helper 统一构造："{table}:{row_id}:{field}"。
    assert_eq!(ottr_vault::aad("credentials", 42, "secret"), "credentials:42:secret");
}

#[test]
fn truncated_blob_must_err() {
    let cipher = Cipher::new(&KEY).unwrap();
    assert!(matches!(
        cipher.open(&[0u8; 5], "credentials:1:secret"),
        Err(VaultError::Crypto(_))
    ));
}
