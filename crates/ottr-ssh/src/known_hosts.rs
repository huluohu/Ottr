//! known_hosts 解析与指纹（BL-211 收敛点）：此前指纹解析逻辑在
//! desktop commands/session.rs（整文件取首条）、desktop hostkey_audit.rs
//! （keyscan 逐行）、crates/ottr-bench（host 过滤）三处各写一份 + ottr-ssh
//! 测试助手两处——算法相同（`SHA256:<unpadded-std-b64(sha256(key_blob))>`，
//! 与 `ssh-keygen -lf` 逐字一致）但行为细节（marker 行、host 过滤）不一，
//! 「多 host 文件取首条」可能 pin 错 key。本模块提供单一 pub API：
//!
//! * [`line_fingerprint`]：单行 → 指纹。跳过注释/空行/hashed（`|1|…`）/
//!   **marker 行**（`@cert-authority` / `@revoked`——CA 公钥与已吊销钥都不是
//!   该主机的个人密钥，参与 pin 会错钉；吊销行若被当信任锚更是反向放行）。
//! * [`fingerprint_for_host`]：整文件 + 目标端点 → 指纹。只吃 host 列匹配
//!   目标端点的规范行（22 端口裸 hostname、非 22 端口 `[host]:port` 方括号
//!   形态，OpenSSH 惯例）；找不到 = `None`（fail-closed：调用方拒绝连接，
//!   绝不退化为「随便取一条」）。
//! * [`parse_known_hosts_file`]：整文件 → `(host, port, fingerprint)` 列表
//!   （导入本地 known_hosts 的解析面，2026-11-02）。
//! * [`parse_known_hosts_file_limited`]：同上，但带**条目数上限**
//!   （[`MAX_KNOWN_HOSTS_ENTRIES`]）——导入路径必须走它（超限即报错，
//!   不静默截断）；无上限的 [`parse_known_hosts_file`] 只留给测试/工具面。
//! * [`select_by_endpoint`]：端点归组 + 择一（HashMap 归组，O(n)）。

use std::collections::HashMap;

use base64::Engine as _;
use sha2::Digest;

/// 单行 known_hosts / ssh-keyscan 输出 →
/// `SHA256:<unpadded-std-b64(sha256(key_blob))>` 指纹。
///
/// 行形状：`host keytype b64 [comment…]`（**至少 3 列**）。OpenSSH 的
/// known_hosts 允许第 4 列起是自由文本注释（`hostfile.c` 读第 4 列），
/// 本实现同样忽略其后的列——早期版本要求恰好 3 列，把带注释的合法行整行
/// 丢弃，那个端点就导不进信任锚（首次连接照样弹 TOFU，导入白做）。
///
/// 以下行返回 `None`：
/// 空行/纯空白、`#` 注释、`|1|…` hashed 形态（keyscan 不产出，防御性跳过）、
/// `@cert-authority` / `@revoked` **marker 行**（见模块文档）、列数不足 3、
/// b64 段非法。
pub fn line_fingerprint(line: &str) -> Option<String> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') || line.starts_with('|') || line.starts_with('@') {
        // `|1|…`：hashed known_hosts（keyscan 不产出，防御性跳过）。
        // `@…`：marker 行（@cert-authority / @revoked）——CA 钥/已吊销钥
        // 不参与 pin（BL-211）。
        return None;
    }
    let mut parts = line.split_whitespace();
    // ≥3 列：第 4 列起是 OpenSSH 允许的自由注释，忽略即可（不判畸形）。
    let b64 = match (parts.next(), parts.next(), parts.next()) {
        (Some(_host), Some(_ktype), Some(b64)) => b64,
        _ => return None,
    };
    fingerprint_from_key_b64(b64)
}

/// known_hosts 全文 → 目标端点 `(host, port)` 的 pin 指纹（BL-211「多 host
/// 可能 pin 错 key」的根治面）：逐行做 host 列过滤后再取指纹，返回**第一条
/// 匹配行**的指纹。host 列匹配规则（OpenSSH 惯例）：`port = 22` 时裸
/// `host`，其余 `[host]:port`。marker/hashed/注释行天然不参与（见
/// [`line_fingerprint`]）。找不到 = `None` = 调用方 fail-closed。
pub fn fingerprint_for_host(content: &str, host: &str, port: u16) -> Option<String> {
    let marker = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    content.lines().find_map(|line| {
        let trimmed = line.trim();
        let mut parts = trimmed.split_whitespace();
        let line_host = match (parts.next(), parts.next()) {
            (Some(h), Some(_)) if !trimmed.starts_with('#') => h,
            _ => return None,
        };
        if line_host != marker {
            return None;
        }
        line_fingerprint(trimmed)
    })
}

/// b64 公钥段 → SHA256 指纹（unpadded 标准 b64；与 `ssh-keygen -lf` 逐字一致）。
fn fingerprint_from_key_b64(b64: &str) -> Option<String> {
    let blob = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    Some(fingerprint_from_blob(&blob))
}

/// known_hosts 的一条解析结果（含**密钥型**——择一优先级要用）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnownHostEntry {
    /// 主机地址（IPv6 为裸地址，方括号由上层统一补回）。
    pub host: String,
    /// 端口（22 = 裸 host 形态）。
    pub port: u16,
    /// 密钥型（`ssh-ed25519` / `ecdsa-sha2-nistp256` / `ssh-rsa` …）。
    pub key_type: String,
    /// `SHA256:…` 指纹。
    pub fingerprint: String,
}

/// 端点归组后的择一结果（导入落库的输入面）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectedEndpoint {
    pub host: String,
    pub port: u16,
    /// **择一后**的落库指纹（按 [`key_type_rank`] 优先级）。
    pub fingerprint: String,
    /// 该端点在源文件中的**全部**候选指纹（重复判定用：既有锚 ∈ 候选集 → 重复）。
    pub candidates: Vec<String>,
}

/// 密钥型优先级（用户裁定 2026-11-02：同端点多密钥型**优先 ed25519**）。
///
/// 序号小 = 优先。`ssh-rsa`（SHA-1）垫底——现代 OpenSSH 已默认关闭
/// `ssh-rsa` 主机密钥算法，服务端出示它的概率最低。
pub const KEY_TYPE_PRIORITY: &[&str] = &[
    "ssh-ed25519",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "ssh-rsa",
];

/// 密钥型 → 优先级序号（越小越优先）；未知型 = `None`（按文件序兜底）。
pub fn key_type_rank(key_type: &str) -> Option<usize> {
    KEY_TYPE_PRIORITY.iter().position(|k| *k == key_type)
}

/// 解析结果（导入面）：条目 + **各类跳过计数**。
///
/// 计数不是装饰——真机实测（192.168.9.102 的真实 `~/.ssh/known_hosts`）里
/// **37 条全是 hashed 条目**（`|1|…`，不可反解 host），导入报告若只说
/// 「新增 0 条」而不说「跳过了 37 条 hashed」，用户无法区分「文件是空的」
/// 「文件全是 hashed」还是「路径指错了」——报告必须诚实交代去向。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KnownHostsParseResult {
    /// 成功解析出的条目（含密钥型）。
    pub entries: Vec<KnownHostEntry>,
    /// 跳过的 hashed 条目数（`|1|salt|hash`，host 被哈希不可反解）。
    pub skipped_hashed: usize,
    /// 跳过的注释 / 空行 / marker 行 / 畸形行合计（除 hashed 外的全部跳过）。
    pub skipped_other: usize,
}

/// 解析整份 known_hosts → 条目列表（含密钥型；导入本地 known_hosts 的解析面，
/// 2026-11-02）。
///
/// 指纹算法复用 [`line_fingerprint`]（与 `ssh-keygen -lf` 逐字一致），本函数
/// 只做「host 列 → 端点」这层解析。跳过：
/// * 注释行（`#`）、纯空白行；
/// * `|1|…` hashed 条目——**不可反解**（哈希的是 host 名），无法还原端点；
/// * `@cert-authority` / `@revoked` marker 行——CA 公钥与已吊销钥不是该主机
///   的个人密钥（语义同 [`line_fingerprint`]）；
/// * 畸形行：列数不对 / b64 非法 / 端口非法（宁可少导不错导）。
///
/// host 列口径沿用 [`fingerprint_for_host`] 的既有惯例：22 端口裸 hostname，
/// 其余 `[host]:port` 方括号形态（OpenSSH）。另有两处 OpenSSH 语义：
/// * 一行多 pattern（`a,b`）→ 拆成各自端点（绝不把 "a,b" 当主机名）；
/// * IPv6 一律 `[addr]:port`（含 22 端口）→ 地址还原为裸 IPv6（方括号由
///   上层 `host_endpoint_key` 统一补回）。
///
/// **一个 host 可能有多枚密钥**（rsa/ecdsa/ed25519 并存）——本函数**全部返回**，
/// 由 [`select_by_endpoint`] 择一。
///
/// **无条目上限**（既有 API 形状不变）：导入路径请用
/// [`parse_known_hosts_file_limited`]（超限报错，绝不静默截断）。
pub fn parse_known_hosts_file(content: &str) -> KnownHostsParseResult {
    // `usize::MAX` 上限永不触发 `TooManyEntries`（条目数不可能超过 usize::MAX）。
    match parse_known_hosts_file_limited(content, usize::MAX) {
        Ok(parsed) => parsed,
        Err(e) => unreachable!("usize::MAX 条目上限不可能触发：{e}"),
    }
}

/// 导入条目数上限（2026-11-02 审计整改）。
///
/// 文件**字节**上限（8 MiB，在命令层）之外再加**条目数**上限：一个 8 MiB 的
/// 畸形/巨型文件能产出几十万条目，解析 + 逐条落库（每条都要抢 vault 连接锁）
/// 足以把一次导入拖成分钟级。2 万条远超任何真实 known_hosts（真机实测 37 条）。
pub const MAX_KNOWN_HOSTS_ENTRIES: usize = 20_000;

/// 解析面错误（仅导入路径用；[`parse_known_hosts_file`] 无上限，不会出错）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KnownHostsParseError {
    /// 条目数超限（`limit` = 当时生效的上限）。
    TooManyEntries { limit: usize },
}

impl std::fmt::Display for KnownHostsParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KnownHostsParseError::TooManyEntries { limit } => {
                write!(f, "known_hosts has too many entries (limit {limit})")
            }
        }
    }
}

impl std::error::Error for KnownHostsParseError {}

/// 带**条目数上限**的整文件解析（导入路径专用面，2026-11-02 审计整改）。
///
/// 语义与 [`parse_known_hosts_file`] **逐条相同**（同一套跳过/拆分口径），
/// 只多一条硬约束：产出的条目数**超过** `limit` → 立刻返回
/// [`KnownHostsParseError::TooManyEntries`]，**不继续处理**（既不静默截断，
/// 也不把几十万条目塞进内存再逐条落库）。
///
/// 上限按**产出的端点条目数**计（一行多 pattern 会产出多条）；被跳过的行
/// （注释/hashed/marker/畸形）不计入——它们不产生落库压力。
pub fn parse_known_hosts_file_limited(
    content: &str,
    limit: usize,
) -> Result<KnownHostsParseResult, KnownHostsParseError> {
    let mut out = KnownHostsParseResult::default();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            // 注释 / 空白行。
            out.skipped_other += 1;
            continue;
        }
        if line.starts_with('|') {
            // hashed（`|1|salt|hash`）：host 被哈希，**不可反解** → 跳过并计数。
            out.skipped_hashed += 1;
            continue;
        }
        if line.starts_with('@') {
            // marker 行（`@cert-authority` / `@revoked`）：CA 钥与已吊销钥不是
            // 该主机的个人密钥，不参与 pin（见模块文档）。
            out.skipped_other += 1;
            continue;
        }
        // 指纹走既有算法核（列数/b64 合法性一并由它把关）。
        let Some(fingerprint) = line_fingerprint(line) else {
            out.skipped_other += 1;
            continue;
        };
        let mut parts = line.split_whitespace();
        let (Some(host_field), Some(key_type)) = (parts.next(), parts.next()) else {
            out.skipped_other += 1;
            continue;
        };
        let mut matched = false;
        for pattern in host_field.split(',') {
            let Some((host, port)) = parse_host_port(pattern) else {
                continue;
            };
            matched = true;
            out.entries.push(KnownHostEntry {
                host,
                port,
                key_type: key_type.to_string(),
                fingerprint: fingerprint.clone(),
            });
            if out.entries.len() > limit {
                // 超限即停：不再解析剩余行，也不再把超量条目交给落库层。
                return Err(KnownHostsParseError::TooManyEntries { limit });
            }
        }
        if !matched {
            out.skipped_other += 1;
        }
    }
    Ok(out)
}

/// 端点归组 + 密钥型优先级择一（用户裁定 2026-11-02：优先 ed25519）。
///
/// 同端点的多枚密钥里挑**优先级最高**的一枚落库（[`key_type_rank`]：
/// ed25519 > ecdsa > rsa）——落库的是「服务端最可能实际出示」的那一枚，
/// 否则首次连接会因指纹不符被判成 changed 强提醒，导入白做。
///
/// 优先级相同（同一密钥型多行）或全部为未知型 → 取**文件序第一条**
/// （与既有 `fingerprint_for_host` 的「取首条」口径一致）。
///
/// 候选集（candidates）保留同端点的**全部**指纹：落库层据此判定「既有锚
/// 是否仍在候选集内」——在则算重复（用户先前锚的是同一台服务器的另一型
/// 密钥），不在才算真冲突。
///
/// **算法（2026-11-02 审计整改）**：归组走 `HashMap<(host, port), 组号>`
/// ——一趟建组（O(n)），组内择一用「首见排名表 + 哈希去重」增量完成
/// （O(n) 摊还）。旧实现对每条 entry 线性扫 `grouped` 与 `entries`
/// （O(n²)，且 `ranked_key_type` 每次都重扫全表）——真机量级（10 万条）
/// 要按分钟计，导入大文件时命令线程直接趴窝。
///
/// **输出语义逐字不变**：同端点多密钥型 → 优先 ed25519 > ecdsa > rsa；
/// 同型 → 文件序首条；候选集按文件序去重保序；输出按端点**首次出现**序。
/// 语义守恒由 `tests/known_hosts_test.rs` 的差分回归测试钉住（新实现 vs
/// 旧算法参考实现逐字段比对，含病态样本）。
pub fn select_by_endpoint(entries: &[KnownHostEntry]) -> Vec<SelectedEndpoint> {
    // 组号表：`HashMap` 归组替代旧实现的「线性扫 grouped」。
    let mut group_of: HashMap<(&str, u16), usize> = HashMap::with_capacity(entries.len());
    let mut groups: Vec<EndpointGroup> = Vec::new();
    for entry in entries {
        match group_of.get(&(entry.host.as_str(), entry.port)) {
            // 已有组 → 增量吸收（候选集去重 + 优先级夺魁）。
            Some(&idx) => groups[idx].absorb(entry),
            // 新端点 → 建组（首条即初始夺魁者，候选集 = [该指纹]）。
            None => {
                let idx = groups.len();
                groups.push(EndpointGroup::new(entry));
                group_of.insert((entry.host.as_str(), entry.port), idx);
            }
        }
    }
    groups
        .into_iter()
        .map(EndpointGroup::into_selected)
        .collect()
}

/// 端点归组态（择一过程中的可变聚合体）。
///
/// `first_rank` 是**首见排名表**：某指纹在组内**首次出现**的那条 entry 的
/// 密钥型排名（旧实现 `ranked_key_type` 的口径——「取文件序第一个同指纹
/// 条目」，而非「当前这条」）。夺魁比较用的正是它，故语义与旧实现逐字一致
/// （含「同一指纹配不同密钥型」的病态样本）。
struct EndpointGroup {
    host: String,
    port: u16,
    /// 当前落库指纹（夺魁者）。
    winner_fp: String,
    /// 夺魁者的首见排名（未知密钥型 = `None`）。
    winner_rank: Option<usize>,
    /// 该端点的全部候选指纹（文件序、去重）。
    candidates: Vec<String>,
    /// 每个候选指纹的首见排名。
    first_rank: HashMap<String, Option<usize>>,
}

impl EndpointGroup {
    /// 新建组（该端点的第一条 entry 即初始夺魁者）。
    fn new(entry: &KnownHostEntry) -> Self {
        let rank = key_type_rank(&entry.key_type);
        let mut first_rank = HashMap::new();
        first_rank.insert(entry.fingerprint.clone(), rank);
        Self {
            host: entry.host.clone(),
            port: entry.port,
            winner_fp: entry.fingerprint.clone(),
            winner_rank: rank,
            candidates: vec![entry.fingerprint.clone()],
            first_rank,
        }
    }

    /// 吸收一条 entry：候选集去重保序 + 按密钥型优先级增量夺魁。
    fn absorb(&mut self, entry: &KnownHostEntry) {
        let challenger_rank = key_type_rank(&entry.key_type);
        if !self.first_rank.contains_key(&entry.fingerprint) {
            // 指纹首次出现 → 记下它的首见排名，并追加进候选集（文件序）。
            self.first_rank
                .insert(entry.fingerprint.clone(), challenger_rank);
            self.candidates.push(entry.fingerprint.clone());
        }
        // 优先级更高者夺魁（同优先级不动 → 保留文件序首条；未知型不夺魁）。
        if challenger_rank.is_some()
            && (self.winner_rank.is_none() || challenger_rank < self.winner_rank)
        {
            self.winner_fp = entry.fingerprint.clone();
            self.winner_rank = self.first_rank.get(&entry.fingerprint).copied().flatten();
        }
    }

    fn into_selected(self) -> SelectedEndpoint {
        SelectedEndpoint {
            host: self.host,
            port: self.port,
            fingerprint: self.winner_fp,
            candidates: self.candidates,
        }
    }
}

/// known_hosts host 列的一段 → `(地址, 端口)`。
///
/// * `[addr]:port` → `(addr, port)`（OpenSSH 非 22 端口惯例；IPv6 亦如此）；
/// * `[addr]`（无端口段）→ `(addr, 22)`；
/// * 裸 host → `(host, 22)`。
///
/// 端口须落在 `1..=65535`（0 端口不是可探测端点）；非法 → `None`（该行跳过）。
fn parse_host_port(field: &str) -> Option<(String, u16)> {
    let field = field.trim();
    if field.is_empty() {
        return None;
    }
    // **pattern 行不是端点**：OpenSSH 的 host 列可以是通配（`*` / `*.example.com`）
    // 或取反（`!bad.example.com`）。前者永远匹配不上精确端点（运行时按端点
    // 精确匹配，不做通配），后者语义正好相反（永不信任）。当成字面主机名
    // 落库 = 造一条永不匹配任何连接的垃圾信任锚，还会污染「新增 N 条」计数
    // 与巡检结果。
    if field.contains('*') || field.contains('?') || field.starts_with('!') {
        return None;
    }
    if let Some(rest) = field.strip_prefix('[') {
        let close = rest.find(']')?;
        let addr = &rest[..close];
        if addr.is_empty() {
            return None;
        }
        let tail = &rest[close + 1..];
        let port = if tail.is_empty() {
            22
        } else {
            let port_str = tail.strip_prefix(':')?;
            let port: u16 = port_str.parse().ok()?;
            if port == 0 {
                return None;
            }
            port
        };
        return Some((addr.to_string(), port));
    }
    // 裸形态：含 ']' 必是畸形（方括号不闭合）。
    if field.contains(']') {
        return None;
    }
    Some((field.to_string(), 22))
}

/// ssh public key blob → 指纹（[`line_fingerprint`] 的算法核）。
fn fingerprint_from_blob(blob: &[u8]) -> String {
    format!(
        "SHA256:{}",
        base64::engine::general_purpose::STANDARD
            .encode(sha2::Sha256::digest(blob))
            .trim_end_matches('=')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_B64: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIKGG+QLrOYImKV/X+7f0EJ1eqaBx7XCX7Dqa2/+VS+/w";
    const GOLDEN_FP: &str = "SHA256:aQYbRlhLOCUDFmDqZp0i2/ltZvBtACX57D/77LUPAU4";

    #[test]
    fn blob_fingerprint_is_unpadded_std_b64_of_sha256() {
        // 金样（tests/known_hosts_test.rs 同源向量）：ssh-keygen -lf 实测值。
        let blob = base64::engine::general_purpose::STANDARD
            .decode(GOLDEN_B64)
            .unwrap();
        assert_eq!(fingerprint_from_blob(&blob), GOLDEN_FP);
        // 指纹形态契约：SHA256: 前缀 + 43 字符无填充标准 b64。
        assert_eq!(GOLDEN_FP.len(), 7 + 43);
        assert!(!GOLDEN_FP.ends_with('='));
    }

    #[test]
    fn padded_b64_key_still_parses() {
        // 列尾 b64 段带填充（手维护文件可能出现）也能解——引擎容错 `=`。
        assert!(fingerprint_from_key_b64(GOLDEN_B64).is_some());
        assert_eq!(fingerprint_from_key_b64(GOLDEN_B64), Some(GOLDEN_FP.into()));
    }
}
