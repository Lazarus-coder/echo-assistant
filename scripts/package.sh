#!/bin/bash
# 打包可复现的发布件：只包含 git 跟踪的文件（凭据、数据、构建产物天然排除），
# 并产出 SHA256 校验和。用法：bash scripts/package.sh [--no-verify]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/bin/language.sh"
echo_select_language "$ROOT"
VER="$(node -p "require('./package.json').version")"
NAME="echo-assistant-$VER"
DIST="$ROOT/dist"
OUT="$DIST/$NAME.tar.gz"
VERIFY=1

ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in --allow-dirty) ALLOW_DIRTY=1 ;; --no-verify) VERIFY=0 ;; esac
done

# 工作区不干净就拒绝打包：git archive 打的是 HEAD，未提交的改动不会进去，
# 结果就是"发布件与当前代码不一致"（这个错真的犯过，而且是从发布页下载验证时发现的）
if [ -n "$(git status --porcelain)" ] && [ "$ALLOW_DIRTY" = "0" ]; then
  printf '\033[31m✗ %s\033[0m\n' "$(msg dirty_archive)"
  git status --short | head -12 | sed 's/^/    /'
  printf '  %s\n' "$(msg dirty_hint)"
  exit 1
fi

mkdir -p "$DIST"
rm -f "$OUT" "$DIST/$NAME.tar.gz.sha256"

# git archive：只打跟踪文件，且带前缀目录，解包即得 $NAME/
git archive --format=tar.gz --prefix="$NAME/" -o "$OUT" HEAD
if ! tar -tzf "$OUT" | grep -Fx "$NAME/package-lock.json" >/dev/null; then
  printf '\033[31m✗ %s\033[0m\n' "$(msg package_lock)"
  exit 1
fi
rm -f "$DIST/SHA256SUMS"
( cd "$DIST" && shasum -a 256 "$NAME.tar.gz" | awk '{print $1"  "$2}' > SHA256SUMS )

# 断言"产品决策演变记录"已跟上当前版本：它必须随每次发版更新，否则拒绝出包
JOURNEY="docs/product-journey.md"
[ -f "$JOURNEY" ] || { printf '\033[31m✗ %s\033[0m\n' "$(msg missing_record "$JOURNEY")"; exit 1; }
JOURNEY_VER="$(sed -nE 's/.*(覆盖版本：|Covered version:[[:space:]]*)([0-9][A-Za-z0-9.-]*).*/\2/p' "$JOURNEY" | head -1)"
if [ "$JOURNEY_VER" != "$VER" ]; then
  printf '\033[31m✗ %s\033[0m\n' "$(msg record_version "${JOURNEY_VER:-—}" "$VER")"
  printf '  %s\n' "$(msg update_record "$JOURNEY" "$VER")"
  exit 1
fi
printf '· %s\n' "$(msg record_ok "$JOURNEY_VER")"

# 断言发布件里的版本号与当前工作区一致（防止"发了旧树"这类时序错误）
ARCHIVED_VER="$(tar -xzOf "$OUT" "$NAME/package.json" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8")).version' 2>/dev/null || echo '?')"
if [ "$ARCHIVED_VER" != "$VER" ]; then
  printf '\033[31m✗ %s\033[0m\n' "$(msg archive_mismatch "$ARCHIVED_VER" "$VER")"
  exit 1
fi
printf '· %s\n' "$(msg archive_version "$ARCHIVED_VER")"
SIZE="$(du -h "$OUT" | awk '{print $1}')"
FILES="$(tar -tzf "$OUT" | grep -vc '/$' || true)"
printf '\033[32m✓\033[0m %s\n' "$(msg archive_details "$OUT" "$SIZE" "$FILES")"
printf '  sha256: %s\n' "$(awk '{print $1}' "$DIST/SHA256SUMS")"

# 自检：解包到临时目录并跑一遍离线自测，确认发布件自洽
if [ "$VERIFY" = "1" ]; then
  TMP="$(mktemp -d)"
  tar -xzf "$OUT" -C "$TMP"
  printf '· %s\n' "$(msg verify_archive)"
  ( cd "$TMP/$NAME" && node --check server.mjs && for f in lib/*.mjs; do node --check "$f"; done )
  if ! ( cd "$TMP/$NAME" && npm ci --omit=dev --ignore-scripts ); then
    printf '\033[31m✗ %s\033[0m\n' "$(msg archive_deps_failed)"
    rm -rf "$TMP"
    exit 1
  fi
  if ( cd "$TMP/$NAME" && node tests/selftest.mjs --json >/dev/null 2>&1 ); then
    printf '\033[32m✓\033[0m %s\n' "$(msg archive_passed)"
  else
    printf '\033[31m✗ %s\033[0m\n' "$(msg archive_failed)"
    rm -rf "$TMP"
    exit 1
  fi
  # 发布件里不该出现凭据/数据
  if tar -tzf "$OUT" | grep -E '(^|/)(data|\.snapshots|build|node_modules)/|echo\.env|local\.token|auth\.json' >/dev/null; then
    printf '\033[31m✗ %s\033[0m\n' "$(msg runtime_leak)"
    rm -rf "$TMP"
    exit 1
  fi
  printf '\033[32m✓\033[0m %s\n' "$(msg clean_archive)"
  rm -rf "$TMP"
fi

printf '\n%s\n' "$(msg tag_next "$VER")"
printf '        gh release create v%s dist/%s.tar.gz dist/SHA256SUMS --prerelease --notes-file docs/release-notes-%s.md\n' "$VER" "$NAME" "$VER"
