//! 集成测试共享夹具。纪律：tempfile 临时目录 + InMemoryStorage，绝不触碰
//! 真实用户目录与真钥匙链。
//!
//! **per-dir 钥匙链语义（2026-10-13 主密钥事故回归钉）**：真实世界里一个库
//! 对应一把钥匙链条目，重开必须拿到同一把钥。fixture 曾是「每次 open 都给
//! 全新空 storage」——vault 侧禁止静默换钥（KeyringLost）后，凡重开同目录的
//! 用例会直接红。本模块按目录登记首开生成的钥，重开还原同一把，使 fixture
//! 语义与真实钥匙链一致。
use std::collections::HashMap;
use std::sync::Mutex;

use ottr_vault::Vault;
use ottr_vault::master_key::{InMemoryStorage, KeyStorage};

fn registry() -> &'static Mutex<HashMap<String, String>> {
    static REG: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dir_key(dir: &std::path::Path) -> String {
    dir.canonicalize()
        .unwrap_or_else(|_| dir.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

/// 打开目录下的 vault：首开生成钥并登记；重开还原同一把钥。测试内
/// drop(vault) 再开同目录 = 真实「关应用再开应用」语义。
pub fn open_vault(dir: &std::path::Path) -> Vault {
    let key = dir_key(dir);
    let storage = {
        let reg = registry().lock().unwrap();
        match reg.get(&key) {
            Some(hex) => InMemoryStorage::with_raw(hex),
            None => InMemoryStorage::new(),
        }
    };
    let vault = Vault::open_with(dir, &storage).expect("open vault");
    if let Some(hex) = storage.load().expect("storage load") {
        registry().lock().unwrap().insert(key, hex);
    }
    vault
}
