#!/usr/bin/env python3
"""从 git 提交历史生成面向用户的 Release 更新内容。

用法: gen-release-notes.py <tag> <out_path>   （需在仓库根、完整历史下运行）

纪律（2026-10-10 用户裁定：Release 页只写正经的功能与修复，不写开发过程）:
* 只收录 feat / fix 提交，docs/chore/ci/test 一律不进正文；
* 剥离 `type(scope): ` 前缀；长解释（`——` 之后）整段舍弃；
* 含内部标记的括注（用户反馈/实测/裁定/回归/迁移/门禁/BL-/年份等）整块剔除；
* 提交主题里不得出现内部工具名（ZCode 等），出现即剔除该词；
* 去重、限长 70 字符。无 feat/fix 时输出口径：稳定性与体验优化。
* Full Changelog 链接不拼（generate_release_notes 自动附加，拼了就重复两行）。
"""

import re
import subprocess
import sys
from typing import Optional

INTERNAL_PAREN = re.compile(r"（[^（）]*(?:用户|实测|反馈|裁定|回归|迁移|门禁|BL-|20\d\d)[^（）]*）")
PREFIX = re.compile(r"^(feat|fix)(?:\([^)]*\))?:\s*(.+)$")
FORBIDDEN_WORDS = ("ZCode", "zcode")


def clean_subject(subj) -> Optional[str]:
    m = PREFIX.match(subj)
    if not m:
        return None
    text = m.group(2)
    full = text
    for word in FORBIDDEN_WORDS:
        full = (full
                .replace(" " + word + " 式", "")
                .replace(word + " 式", "")
                .replace(word + "式", "")
                .replace(word, ""))
    text = full.split("——")[0]
    for _ in range(3):
        text = INTERNAL_PAREN.sub("", text)
    text = re.sub(r"\s+", " ", text).strip(" ；，。、-—·")
    # 首段是过程性表述（实测/反馈）而破折号后是编号要点（①…；②…）→
    # 取要点段；否则取首段。两种取法统一：剥内部括注 → 压空白 → 截尾。
    if re.search(r"实测|反馈", text):
        parts = [p.strip() for p in full.split("——") if p.strip()]
        if len(parts) >= 2 and re.match(r"^[①-⑩]", parts[1]):
            text = parts[1]
        else:
            text = full
    for _ in range(3):
        text = INTERNAL_PAREN.sub("", text)
    text = re.sub(r"\s+", " ", text).strip(" ；，。、-—·")
    # 未闭合括号（截断/剔括注造成）→ 自最后一个未配对「（」起舍弃
    if text.count("（") > text.count("）"):
        text = text[: text.rfind("（")]
    text = text.strip(" ；，。、")
    if len(text) > 70:
        text = text[:77].rstrip() + "…"
    return text or None


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    tag, out = sys.argv[1], sys.argv[2]
    prev = subprocess.run(
        ["git", "describe", "--tags", "--abbrev=0", f"refs/tags/{tag}^"],
        capture_output=True, text=True,
    ).stdout.strip()
    rng = f"{prev}..{tag}" if prev else tag
    log = subprocess.run(
        ["git", "log", "--pretty=format:%s", rng],
        capture_output=True, text=True,
    ).stdout.splitlines()

    feats: list[str] = []
    fixes: list[str] = []
    for subj in log:
        if subj.startswith("chore(release)"):
            continue
        text = clean_subject(subj)
        if not text or text in feats or text in fixes:
            continue
        (feats if subj.startswith("feat") else fixes).append(text)

    lines = ["## 🚀 更新内容", ""]
    if feats:
        lines += ["### ✨ 新功能", *[f"- {t}" for t in feats], ""]
    if fixes:
        lines += ["### 🐞 问题修复", *[f"- {t}" for t in fixes], ""]
    if not feats and not fixes:
        lines += ["- 稳定性与体验优化", ""]
    # Full Changelog 链接不在此拼——generate_release_notes 会自动附加同款
    # 链接，自己再拼一遍就是用户截图里的两行重复。
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(f"gen-release-notes: {out} written ({len(feats)} feat / {len(fixes)} fix)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
