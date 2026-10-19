#!/bin/bash
# 打包可复现的发布件：只包含 git 跟踪的文件（凭据、数据、构建产物天然排除），
# 并产出 SHA256 校验和。用法：bash scripts/package.sh [--no-verify]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VER="$(node -p "require('./package.json').version")"
NAME="echo-assistant-$VER"
DIST="$ROOT/dist"
OUT="$DIST/$NAME.tar.gz"
VERIFY=1
[ "${1:-}" = "--no-verify" ] && VERIFY=0

ALLOW_DIRTY=0
for arg in "$@"; do [ "$arg" = "--allow-dirty" ] && ALLOW_DIRTY=1; done

# 工作区不干净就拒绝打包：git archive 打的是 HEAD，未提交的改动不会进去，
# 结果就是"发布件与当前代码不一致"（这个错真的犯过，而且是从发布页下载验证时发现的）
if [ -n "$(git status --porcelain)" ] && [ "$ALLOW_DIRTY" = "0" ]; then
  printf '\033[31m✗ 工作区有未提交改动，拒绝打包（发布件来自 HEAD，会与当前代码不一致）\033[0m\n'
  git status --short | head -12 | sed 's/^/    /'
  printf '  先提交，或显式用 --allow-dirty 打包\n'
  exit 1
fi

mkdir -p "$DIST"
rm -f "$OUT" "$DIST/$NAME.tar.gz.sha256"

# git archive：只打跟踪文件，且带前缀目录，解包即得 $NAME/
git archive --format=tar.gz --prefix="$NAME/" -o "$OUT" HEAD
rm -f "$DIST/SHA256SUMS"
( cd "$DIST" && shasum -a 256 "$NAME.tar.gz" | awk '{print $1"  "$2}' > SHA256SUMS )

# 断言发布件里的版本号与当前工作区一致（防止"发了旧树"这类时序错误）
ARCHIVED_VER="$(tar -xzOf "$OUT" "$NAME/package.json" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version' 2>/dev/null || echo '?')"
if [ "$ARCHIVED_VER" != "$VER" ]; then
  printf '\033[31m✗ 发布件版本不一致：包内 %s ≠ 工作区 %s\033[0m\n' "$ARCHIVED_VER" "$VER"
  exit 1
fi
printf '· 版本一致：%s\n' "$ARCHIVED_VER"
SIZE="$(du -h "$OUT" | awk '{print $1}')"
FILES="$(tar -tzf "$OUT" | grep -vc '/$' || true)"
printf '\033[32m✓\033[0m %s  (%s, %s 个文件)\n' "$OUT" "$SIZE" "$FILES"
printf '  sha256: %s\n' "$(awk '{print $1}' "$DIST/SHA256SUMS")"

# 自检：解包到临时目录并跑一遍离线自测，确认发布件自洽
if [ "$VERIFY" = "1" ]; then
  TMP="$(mktemp -d)"
  tar -xzf "$OUT" -C "$TMP"
  printf '· 在临时目录验证发布件…\n'
  ( cd "$TMP/$NAME" && node --check server.mjs && for f in lib/*.mjs; do node --check "$f"; done )
  if ( cd "$TMP/$NAME" && node tests/selftest.mjs --json >/dev/null 2>&1 ); then
    printf '\033[32m✓\033[0m 发布件自测通过（隔离沙箱，未触碰真实数据）\n'
  else
    printf '\033[31m✗ 发布件自测未通过，先别发\033[0m\n'
    rm -rf "$TMP"
    exit 1
  fi
  # 发布件里不该出现凭据/数据
  if tar -tzf "$OUT" | grep -Eq '(^|/)(data|\.snapshots|build|node_modules)/|echo\.env|local\.token|auth\.json'; then
    printf '\033[31m✗ 发布件里混进了运行时数据或凭据\033[0m\n'
    rm -rf "$TMP"
    exit 1
  fi
  printf '\033[32m✓\033[0m 发布件不含 data/、凭据与构建产物\n'
  rm -rf "$TMP"
fi

printf '\n下一步：git tag v%s && git push origin main --tags\n' "$VER"
printf '        gh release create v%s dist/%s.tar.gz dist/SHA256SUMS --prerelease --notes-file docs/release-notes-%s.md\n' "$VER" "$NAME" "$VER"