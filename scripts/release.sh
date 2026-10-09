#!/usr/bin/env bash
# Ottr 发布自动化（一条命令完成一次完整发布）。
#
# 流程:
#   1. 前置检查（main 分支 / 工作树干净 / 与远端同步 / 版本 tag 未占用）
#   2. 版本号三处对齐（tauri.conf.json / package.json / Cargo.toml）+ 两份锁文件同步
#   3. 提交版本号并推送 main
#   4. 等待推送门（spike-build：fmt+clippy+三平台构建）全绿
#   5. 打 tag 推送，触发发布流水线（四平台构建 + 签名更新件 + latest.json）
#   6. 等待 Release 自动创建后，用分类整理的发布说明覆盖正文
#      （✨ 新功能 / 🐞 问题修复 / 🔧 优化改进 / 📦 平台提示 / 📋 完整变更）
#
# 用法:
#   scripts/release.sh <版本号>                 # 例: scripts/release.sh 0.4.0
#   scripts/release.sh --notes-only <v0.4.0>    # 仅重新生成/应用某 tag 的发布说明
#
# 选项:
#   --skip-gate   跳过「推送门全绿」等待（不推荐）
#   --no-wait     打 tag 后不等待 Release 创建（之后可用 --notes-only 补说明）
#   --dry-run     演练：执行版本号修改并预览发布说明，最后自动还原，不改任何状态
#
# 环境变量:
#   GATE_TIMEOUT      推送门最长等待秒数（默认 1800）
#   RELEASE_TIMEOUT   Release 最长等待秒数（默认 2700）

set -euo pipefail

# 让 macOS 找到 arm64 node/npm/cargo（仓库惯例 PATH 前置）
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"

VERSION=""
MODE="release"
TAG=""
SKIP_GATE=0
NO_WAIT=0
DRYRUN=0

usage() { sed -n '2,23p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --notes-only) MODE="notes" ;;
    --skip-gate) SKIP_GATE=1 ;;
    --no-wait) NO_WAIT=1 ;;
    --dry-run) DRYRUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "未知选项: $1"; usage; exit 2 ;;
    *) if [ -z "$VERSION" ]; then VERSION="$1"; else echo "多余参数: $1"; exit 2; fi ;;
  esac
  shift
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 前置检查
step "前置检查"
command -v git >/dev/null || die "git 不可用"
command -v gh >/dev/null || die "gh 不可用（brew install gh && gh auth login）"
command -v python3 >/dev/null || die "python3 不可用"

cd "$(git rev-parse --show-toplevel)"
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

if [ "$MODE" = "notes" ]; then
  [ -n "$VERSION" ] || { usage; exit 2; }
  TAG="$VERSION"
  case "$TAG" in v*) ;; *) TAG="v$TAG" ;; esac
  git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "远端/本地不存在 tag $TAG"
else
  [ -n "$VERSION" ] || { usage; exit 2; }
  case "$VERSION" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) die "版本号需为 x.y.z 形态（如 0.4.0），收到: $VERSION" ;;
  esac
  { [ "$DRYRUN" = 1 ] || [ "$(git branch --show-current)" = "main" ]; } || die "请在 main 分支上发布（当前: $(git branch --show-current)）"
  [ "$DRYRUN" = 1 ] || git diff-index --quiet HEAD -- || die "工作树有未提交改动，先提交或暂存"
  [ -z "$(git diff --cached --name-only)" ] || die "暂存区非空"
  git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && die "tag v$VERSION 已存在"
fi

git fetch origin --tags 2>/dev/null || true
if [ "$MODE" = "release" ] && [ "$DRYRUN" = 0 ]; then
  BEHIND=$(git rev-list --count HEAD..origin/main)
  [ "$BEHIND" = 0 ] || die "本地 main 落后远端 $BEHIND 个提交——先 git pull --rebase 再发布"
  AHEAD=$(git rev-list --count origin/main..HEAD)
  echo "  main 领先远端 $AHEAD 个提交（将随本次发布推送）"
fi

# 上一版本 tag（发布说明的范围起点）：当前 HEAD 可达的最近 v* tag
PREV_TAG=$(git tag --list 'v*' --merged HEAD --sort=-v:refname | head -1 || true)
if [ "$MODE" = "notes" ]; then
  PREV_TAG=$(git describe --tags --abbrev=0 "$TAG^" 2>/dev/null || true)
fi

# ---------------------------------------------------------------- 版本号对齐
bump_versions() {
  local old new f
  old=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
  new="$VERSION"
  [ "$old" != "$new" ] || die "tauri.conf.json 已是 $new——确认版本号是否要变更"
  for f in src-tauri/tauri.conf.json package.json; do
    python3 -c "
import sys
p, o, n = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
needle = '\"version\": \"%s\"' % o
assert needle in s, '%s: 未找到 %s' % (p, needle)
open(p, 'w', encoding='utf-8').write(s.replace(needle, '\"version\": \"%s\"' % n, 1))
" "$f" "$old" "$new"
  done
  python3 -c "
import sys
p, o, n = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
needle = 'version = \"%s\"' % o
assert needle in s, '%s: 未找到 %s' % (p, needle)
open(p, 'w', encoding='utf-8').write(s.replace(needle, 'version = \"%s\"' % n, 1))
" src-tauri/Cargo.toml "$old" "$new"
  # 锁文件同步：npm 重算根版本；cargo 用增量 check 同步（不扰动依赖版本）
  command -v npm >/dev/null && npm install --package-lock-only --silent
  if command -v cargo >/dev/null; then
    cargo check -p ottr --lib -q 2>/dev/null || echo "⚠ cargo check 未通过——请人工确认 Cargo.lock"
  else
    echo "⚠ 未找到 cargo——Cargo.lock 未同步，请补跑 cargo check -p ottr"
  fi
}

# ---------------------------------------------------------------- 发布说明
gen_notes() { # $1=prev_tag  $2=head_or_tag  $3=输出文件
  python3 - "$1" "$2" "$3" <<'PY'
import subprocess, sys, datetime
prev, head, out = sys.argv[1], sys.argv[2], sys.argv[3]
rng = f"{prev}..{head}" if prev else head
subjects = subprocess.run(["git", "log", "--format=%s", rng],
                          capture_output=True, text=True).stdout.strip().splitlines()
BUCKETS = [("✨ 新功能", ("feat",)), ("🐞 问题修复", ("fix",)),
           ("🔧 优化改进", ("perf", "refactor", "ui", "style", "docs", "ci", "chore", "test", "build"))]
rows = {k: [] for k, _ in BUCKETS}
rows["📎 其他"] = []
for s in subjects:
    if s.startswith("chore(release):"):
        continue  # 版本号对齐提交不进发布说明
    kind, _, rest = s.partition(": ")
    text = rest if rest else s
    if "(" in kind and kind.endswith(")"):
        kind = kind.split("(")[0]
    hit = False
    for title, prefixes in BUCKETS:
        if kind in prefixes:
            rows[title].append(text)
            hit = True
            break
    if not hit:
        rows["📎 其他"].append(text)
lines = [f"Ottr {head.lstrip('v') if head.startswith('v') else head}", ""]
for title, _ in BUCKETS + [("📎 其他", ())]:
    if rows[title]:
        lines += [f"## {title}"] + [f"- {t}" for t in rows[title]] + [""]
lines += [
    "## 📦 平台提示",
    "- macOS：本版本未使用 Apple 开发者签名。首次打开如提示「已损坏，无法打开」，在终端执行 `xattr -cr /Applications/Ottr.app`；",
    "  连接局域网主机如提示 No route to host 或要求本地网络授权，见 README「macOS 提示已损坏或连不上局域网主机」一节。",
    "- Windows：安装时如遇 SmartScreen 拦截，点「更多信息 → 仍要运行」。",
    "- Linux：AppImage 需 `chmod +x` 后运行；deb/rpm 按发行版安装。",
    "",
]
open(out, "w", encoding="utf-8").write("\n".join(lines))
PY
}

NOTES_FILE=$(mktemp -t ottr-notes)

# ---------------------------------------------------------------- 模式分派
if [ "$MODE" = "notes" ]; then
  step "生成发布说明（$PREV_TAG..$TAG）"
  gen_notes "$PREV_TAG" "$TAG" "$NOTES_FILE"
  cat "$NOTES_FILE"
  echo
  gh release edit "$TAG" -R "$REPO" --notes-file "$NOTES_FILE" && echo "✓ Release $TAG 正文已更新"
  exit 0
fi

step "版本号三处对齐 → $VERSION"
bump_versions
git diff --stat | tail -6

if [ "$DRYRUN" = 1 ]; then
  step "生成发布说明预览（dry-run）"
  gen_notes "$PREV_TAG" HEAD "$NOTES_FILE"
  cat "$NOTES_FILE"
  step "dry-run 结束——还原版本号修改"
  git checkout -- src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml package-lock.json Cargo.lock 2>/dev/null || true
  rm -f "$NOTES_FILE"
  echo "✓ 演练完成，未提交/未推送/未打 tag"
  exit 0
fi

step "提交版本号并推送 main"
git add src-tauri/tauri.conf.json package.json src-tauri/Cargo.toml package-lock.json Cargo.lock
git commit -m "chore(release): v$VERSION 版本号三处对齐（tauri.conf/package.json/Cargo.toml）+ 锁文件同步"
git push origin main
SHA=$(git rev-parse HEAD)

if [ "$SKIP_GATE" = 0 ]; then
  step "等待推送门（spike-build）全绿——最长 ${GATE_TIMEOUT}s，--skip-gate 可跳过"
  waited=0
  while :; do
    sleep 30; waited=$((waited + 30))
    line=$(gh run list -R "$REPO" --workflow spike-build --commit "$SHA" --json status,conclusion 2>/dev/null |
      python3 -c "import json,sys;d=json.load(sys.stdin);print(f'{d[0][\"status\"]}|{d[0].get(\"conclusion\") or \"-\"}' if d else 'none|-')" 2>/dev/null || echo "none|-")
    echo "  [$waited s] 推送门: $line"
    case "$line" in
      completed|*) status="${line%%|*}"; concl="${line#*|}";;
    esac
    [ "${line%%|*}" = "completed" ] && { [ "${line#*|}" = "success" ] && break || die "推送门未全绿（$line）——已中止打 tag；修复后重跑本脚本（tag 未创建）"; }
    [ $waited -ge "$GATE_TIMEOUT" ] && die "推送门等待超时——可用 --skip-gate 跳过，或稍后重跑"
  done
fi

step "打 tag v$VERSION 并推送（触发发布流水线）"
git tag "v$VERSION"
git push origin "v$VERSION"

if [ "$NO_WAIT" = 1 ]; then
  echo "✓ tag 已推送。Release 创建后执行: scripts/release.sh --notes-only v$VERSION 应用分类发布说明"
  exit 0
fi

step "等待发布流水线创建 Release（最长 ${RELEASE_TIMEOUT}s）"
waited=0
while :; do
  sleep 30; waited=$((waited + 30))
  if gh api "repos/$REPO/releases/tags/v$VERSION" >/dev/null 2>&1; then
    echo "  Release 已创建"; break
  fi
  echo "  [$waited s] 等待 Release 创建…"
  [ $waited -ge "$RELEASE_TIMEOUT" ] && die "等待超时——构建可能仍在进行或失败，请到 Actions 页确认"
done

step "应用分类发布说明"
gen_notes "$PREV_TAG" "v$VERSION" "$NOTES_FILE"
gh release edit "v$VERSION" -R "$REPO" --notes-file "$NOTES_FILE" >/dev/null && echo "✓ Release 正文已更新"

echo
echo "=== 发布完成 ==="
gh release view "v$VERSION" -R "$REPO" --json url,assets --jq '"URL: " + .url, (.assets[] | "  " + .name + "  (" + ((.size/1048576*100|floor/100)|tostring) + " MB)")'
