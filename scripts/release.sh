#!/usr/bin/env bash
# Ottr 发布自动化（一条命令完成一次完整发布）。
#
# 流程:
#   1. 前置检查（main 分支 / 工作树干净 / 与远端同步 / 版本 tag 未占用）
#   2. 版本号三处对齐（tauri.conf.json / package.json / Cargo.toml）+ 两份锁文件同步
#   3. 发布正文就位（2026-10-14 用户裁定：正文随 tag 发布，不发完再补）——
#      docs/release-notes/v<版本>.md 不存在则生成草稿并中止；人工润色后重跑，
#      正文随版本号提交一起进仓库，流水线创建 Release 时直接采用
#   4. 提交版本号与正文并推送 main
#   5. 打 tag 推送，触发发布流水线（四平台构建 + 签名更新件 + latest.json；
#      Release 正文 = 仓库内 docs/release-notes/<tag>.md，缺文件回退自动生成）
#
# 用法:
#   scripts/release.sh <版本号>                 # 例: scripts/release.sh 0.4.0
#   scripts/release.sh --notes-only <v0.4.0>    # 仅重新生成/应用某 tag 的发布说明
#
# 选项:
#   --gate        打 tag 前等待「main 推送门全绿」（默认不等——发布流水线
#                 本身就是全量验证，双跑约浪费 15-20 分钟；2026-10-12 用户裁定）
#   --wait        打 tag 后阻塞等待 Release 创建并应用说明（默认不等——
#                 不阻塞开发，2026-10-14 用户裁定；之后可用 --notes-only 补说明）
#   --dry-run     演练：执行版本号修改并预览发布说明，最后自动还原，不改任何状态
#
# 环境变量:
#   GATE_TIMEOUT      推送门最长等待秒数（默认 1800；仅 --gate 时生效）
#   RELEASE_TIMEOUT   Release 最长等待秒数（默认 2700）

set -euo pipefail

# 让 macOS 找到 arm64 node/npm/cargo（仓库惯例 PATH 前置）
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:$PATH"

VERSION=""
MODE="release"
TAG=""
SKIP_GATE=1
NO_WAIT=1
DRYRUN=0

usage() { sed -n '2,23p' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --notes-only) MODE="notes" ;;
    --gate) SKIP_GATE=0 ;;
    --wait) NO_WAIT=0 ;;
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

# 可选环境变量默认值（set -u 下引用前必须已定义；v0.5.0 首跑实测踩坑）
GATE_TIMEOUT="${GATE_TIMEOUT:-1800}"
RELEASE_TIMEOUT="${RELEASE_TIMEOUT:-2700}"

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
  old=$(python3 -c "import json;print(json.load(open('desktop/tauri.conf.json'))['version'])")
  new="$VERSION"
  if [ "$old" = "$new" ]; then
    echo "  版本号已是 ${new}（断点重跑），跳过对齐"
    return 0
  fi
  for f in desktop/tauri.conf.json package.json; do
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
" desktop/Cargo.toml "$old" "$new"
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
  # 2026-10-10 用户裁定（第二遍）：Release 正文只写正经的功能与 bugfix，
  # 开发过程/CI/文档/重构一概不进——统一走 gen-release-notes.py 的用户视角
  # 清洗（feat/fix only、剥前缀、砍长解释、剔内部括注），本函数不再自建分类。
  python3 scripts/gen-release-notes.py --range "$1..$2" "$2" "$3"
  # 平台提示（面向用户的安装注意事项，保留）：
  {
    echo
    echo "## 📦 平台提示"
    echo "- macOS：本版本未使用 Apple 开发者签名。首次打开如提示「已损坏，无法打开」，在终端执行 \`xattr -cr /Applications/Ottr.app\`；"
    echo "  连接局域网主机如提示 No route to host 或要求本地网络授权，见 README「macOS 提示已损坏或连不上局域网主机」一节。"
    echo "- Windows：安装时如遇 SmartScreen 拦截，点「更多信息 → 仍要运行」。"
    echo "- Linux：AppImage 需 \`chmod +x\` 后运行；deb/rpm 按发行版安装。"
  } >> "$3"
}
NOTES_FILE=$(mktemp -t ottr-notes)

# ---------------------------------------------------------------- 模式分派
if [ "$MODE" = "notes" ]; then
  # 仓库内正文优先（人工润色过的版本）；仅旧 tag 缺文件时才从提交历史重新生成。
  if [ -f "docs/release-notes/$TAG.md" ]; then
    step "应用仓库内发布正文（docs/release-notes/$TAG.md）"
    gh release edit "$TAG" -R "$REPO" --notes-file "docs/release-notes/$TAG.md" && echo "✓ Release $TAG 正文已更新"
    exit 0
  fi
  step "生成发布说明（${PREV_TAG}..${TAG}；仓库无 docs/release-notes/$TAG.md，从提交历史生成）"
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
  git checkout -- desktop/tauri.conf.json package.json desktop/Cargo.toml package-lock.json Cargo.lock 2>/dev/null || true
  rm -f "$NOTES_FILE"
  echo "✓ 演练完成，未提交/未推送/未打 tag"
  exit 0
fi

# 发布正文就位（2026-10-14 用户裁定：不发完再补）——不存在则生成草稿并
# 中止，人工润色后重跑（版本号已对齐，断点续跑安全）；存在则随版本提交
# 进仓库，流水线创建 Release 时直接采用。
NOTES_PATH="docs/release-notes/v$VERSION.md"
if [ ! -f "$NOTES_PATH" ]; then
  step "生成发布正文草稿（${NOTES_PATH}）"
  mkdir -p "$(dirname "$NOTES_PATH")"
  gen_notes "$PREV_TAG" "HEAD" "$NOTES_PATH"
  echo "  草稿已写入 $NOTES_PATH"
  die "发布正文需人工润色（访客视角/信息量检验/无内部黑话）——编辑 $NOTES_PATH 后重跑本命令即可继续发版"
fi

step "提交版本号与发布正文并推送 main"
git add desktop/tauri.conf.json package.json desktop/Cargo.toml package-lock.json Cargo.lock "$NOTES_PATH"
if git diff --cached --quiet; then
  echo "  版本号无变化，跳过提交（断点重跑）"
else
  git commit -m "chore(release): v$VERSION 版本号三处对齐 + 锁文件同步 + 发布正文"
fi
git push origin main
SHA=$(git rev-parse HEAD)

if [ "$SKIP_GATE" = 0 ]; then
  step "等待推送门（spike-build）全绿——最长 ${GATE_TIMEOUT}s（--gate 关闭时跳过本等待）"
  waited=0
  while :; do
    sleep 30; waited=$((waited + 30))
    line=$(gh run list -R "$REPO" --workflow spike-build --commit "$SHA" --json status,conclusion 2>/dev/null |
      python3 -c "import json,sys;d=json.load(sys.stdin);print(f'{d[0][\"status\"]}|{d[0].get(\"conclusion\") or \"-\"}' if d else 'none|-')" 2>/dev/null || echo "none|-")
    echo "  [$waited s] 推送门: $line"
    case "$line" in
      completed|*) status="${line%%|*}"; concl="${line#*|}";;
    esac
    [ "${line%%|*}" = "completed" ] && { [ "${line#*|}" = "success" ] && break || die "推送门未全绿（${line}）——已中止打 tag；修复后重跑本脚本（tag 未创建）"; }
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
