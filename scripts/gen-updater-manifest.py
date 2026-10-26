#!/usr/bin/env python3
"""扫描 CI 产物目录，生成 Tauri updater 的 latest.json 清单。

用法: gen-updater-manifest.py <bundle_dir> <tag> <out_path>

产物→平台映射（命名 = tauri bundler 实际输出 + release.yml 的按架构改名）:
  *aarch64*.app.tar.gz → darwin-aarch64   (macOS 更新件 = .app.tar.gz，非 dmg)
  *x86_64*.app.tar.gz  → darwin-x86_64
  *x64-setup.exe       → windows-x86_64   (v2 直接签名 NSIS 安装器)
  *amd64.AppImage      → linux-x86_64

纪律:
* 更新件必须带同名 .sig——没有签名件的平台跳过（未签名发布 = 无更新清单，
  静默给无签名清单等于骗过校验链）；
* 一个平台多个命中取第一个（按文件名排序保证确定性）；
* 全部平台缺失 → 不产出清单文件（CI 的 files 通配自然不挂载）。
"""

import json
import os
import sys
import datetime
import pathlib

RULES = [
    ("darwin-aarch64", "*aarch64*.app.tar.gz"),
    ("darwin-x86_64", "*x86_64*.app.tar.gz"),
    ("windows-x86_64", "*x64-setup.exe"),
    ("linux-x86_64", "*amd64.AppImage"),
]


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    bundle, tag, out = (pathlib.Path(sys.argv[1]), sys.argv[2], pathlib.Path(sys.argv[3]))
    repo = os.environ.get("GITHUB_REPOSITORY", "huluohu/Ottr")
    base = f"https://github.com/{repo}/releases/download/{tag}"

    platforms = {}
    for key, pattern in RULES:
        for art in sorted(bundle.rglob(pattern)):
            sig = art.with_name(art.name + ".sig")
            if not sig.exists():
                continue
            platforms[key] = {
                "signature": sig.read_text().strip(),
                "url": f"{base}/{art.name}",
            }
            break

    if not platforms:
        print("gen-updater-manifest: no signed updater artifacts - manifest skipped")
        return 0

    version = tag.lstrip("v")
    manifest = {
        "version": version,
        "notes": release_notes(tag, version),
        "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }
    out.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"gen-updater-manifest: {out} written ({', '.join(sorted(platforms))})")
    return 0


# notes 上限：latest.json 是每次检查更新都要拉的小文件，说明正文超长就截断
# （应用内面板只展示摘要，完整说明在 Release 页）。
NOTES_MAX_CHARS = 6000


def release_notes(tag: str, version: str) -> str:
    """发布说明正文 = 仓库内 docs/release-notes/<tag>.md（release.sh 打 tag 前
    强制就位、与 Release 正文同源；release job 以仓库根为 cwd 调用本脚本）。
    缺文件回退占位行「Ottr x.y.z」——应用内更新面板把该占位视为「无说明」
    不渲染说明区（frontend/update/releaseNotes.ts isPlaceholderNotes）。"""
    path = pathlib.Path("docs/release-notes") / f"{tag}.md"
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return f"Ottr {version}"
    if not text:
        return f"Ottr {version}"
    if len(text) > NOTES_MAX_CHARS:
        text = text[:NOTES_MAX_CHARS].rstrip() + "\n…"
    return text


if __name__ == "__main__":
    sys.exit(main())
