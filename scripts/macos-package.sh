#!/bin/bash
# 构建 macOS 发行包：Echo.app（状态栏应用）+ 安装器 → .dmg / .zip
# 用法：bash scripts/macos-package.sh [--no-verify]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
source "$ROOT/bin/language.sh"
echo_select_language "$ROOT"
VER="$(node -p "require('./package.json').version")"
NAME="Echo-$VER-macos"
STAGE="$ROOT/dist/stage/$NAME"
OUT="$ROOT/dist"
VERIFY=1

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '\033[36m·\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in --allow-dirty) ALLOW_DIRTY=1 ;; --no-verify) VERIFY=0 ;; esac
done
if [ -n "$(git status --porcelain)" ] && [ "$ALLOW_DIRTY" = "0" ]; then
  printf '\033[31m✗ %s\033[0m\n' "$(msg dirty_dmg)"
  git status --short | head -12 | sed 's/^/    /'
  printf '  %s\n' "$(msg dirty_hint)"
  exit 1
fi

command -v swiftc >/dev/null || die "$(msg pack_swift)"
command -v hdiutil >/dev/null || die "$(msg pack_hdiutil)"
command -v npm >/dev/null || die "$(msg pack_npm)"
[ -f "$ROOT/package-lock.json" ] || die "$(msg pack_lock)"
if ! installer_checks="$(node tests/installer-regressions.mjs 2>&1)"; then
  printf '%s\n' "$installer_checks" >&2
  die "$(msg installer_tests_failed)"
fi

rm -rf "$STAGE" && mkdir -p "$STAGE" "$OUT" "$ROOT/build"

# 1) 编译状态栏 App（通用二进制：Apple Silicon + Intel）+ 图标
info "$(msg compile_universal)"
SWIFT_SRC="menubar/main.swift menubar/EchoBar.swift menubar/CompanionOverlay.swift"
swiftc -O -target arm64-apple-macos13.0 -o "$ROOT/build/EchoBar.arm64" $SWIFT_SRC
if swiftc -O -target x86_64-apple-macos13.0 -o "$ROOT/build/EchoBar.x86" $SWIFT_SRC 2>/dev/null; then
  lipo -create "$ROOT/build/EchoBar.arm64" "$ROOT/build/EchoBar.x86" -output "$ROOT/build/EchoBar"
  ok "$(msg universal "$(lipo -archs "$ROOT/build/EchoBar")")"
else
  cp "$ROOT/build/EchoBar.arm64" "$ROOT/build/EchoBar"
  info "$(msg arm_only "$(lipo -archs "$ROOT/build/EchoBar")")"
fi
mkdir -p "$ROOT/build/icons"
swiftc -O -o "$ROOT/build/makeicon" menubar/make-icon.swift
"$ROOT/build/makeicon" "$ROOT/build/icons" >/dev/null
iconutil -c icns -o "$ROOT/build/Echo.icns" "$ROOT/build/icons/Echo.iconset" 2>/dev/null || true

# 2) 组装 Echo.app
APP="$STAGE/Echo.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/build/EchoBar" "$APP/Contents/MacOS/EchoBar"
[ -f "$ROOT/build/Echo.icns" ] && cp "$ROOT/build/Echo.icns" "$APP/Contents/Resources/Echo.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Echo</string>
  <key>CFBundleDisplayName</key><string>Echo</string>
  <key>CFBundleIdentifier</key><string>com.echoassistant.menubar</string>
  <key>CFBundleExecutable</key><string>EchoBar</string>
  <key>CFBundleIconFile</key><string>Echo</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VER</string>
  <key>CFBundleVersion</key><string>$VER</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>Local-first personal assistant</string>
  <key>NSSupportsAutomaticTermination</key><false/>
</dict>
</plist>
PLIST
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint "$APP/Contents/Info.plist" >/dev/null || die "$(msg plist_invalid)"
# ad-hoc 签名：固定 bundle id + 固定路径，让"屏幕录制"授权尽量一次生效（未签名的裸二进制每次重编都会被当成新 App）
codesign --force --deep --sign - --identifier com.echoassistant.menubar "$APP" >/dev/null 2>&1 || true
codesign -dv "$APP" 2>&1 | grep -q 'adhoc' && ok "$(msg signed)" || info "$(msg unsigned)"
ok "$(msg assembled "$(du -sh "$APP" | awk '{print $1}')")"

# 3) 仅打包已提交的程序文件，排除目录内未跟踪的本机文件。
git archive HEAD -- server.mjs install.sh package.json package-lock.json bin lib public tests docs CHANGELOG.md README.md README.zh-CN.md | tar -x -C "$STAGE"
info "$(msg bundle_deps)"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts ) || die "$(msg deps_failed)"
( cd "$STAGE" && node --input-type=module -e "await import('./lib/mcp.mjs')" ) || die "$(msg verify_mcp)"
rm -rf "$STAGE/tests/last-report.json"
cp "scripts/macos/Install Echo.command" "$STAGE/"
cp "scripts/macos/Uninstall Echo.command" "$STAGE/"
cp scripts/macos/README.txt "$STAGE/README.en.txt"
cp scripts/macos/README.zh-CN.txt "$STAGE/README.zh-CN.txt"
chmod +x "$STAGE/Install Echo.command" "$STAGE/Uninstall Echo.command" "$STAGE/bin/echo"

# 4) DMG + ZIP
info "$(msg create_dmg)"
rm -f "$OUT/$NAME.dmg" "$OUT/$NAME.zip"
hdiutil create -volname "Echo $VER" -srcfolder "$STAGE" -ov -format UDZO -quiet "$OUT/$NAME.dmg"
( cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent "stage/$NAME" "$NAME.zip" )
rm -rf "$ROOT/dist/stage"
( cd "$OUT" && { shasum -a 256 "$NAME.dmg" "$NAME.zip" | awk '{print $1"  "$2}'; } > "SHA256SUMS-macos" )
ok "DMG: $(du -h "$OUT/$NAME.dmg" | awk '{print $1}')  ZIP: $(du -h "$OUT/$NAME.zip" | awk '{print $1}')"
printf '  sha256 %s\n' "$(awk '/dmg/{print $1}' "$OUT/SHA256SUMS-macos")"

# 5) 验证：挂载 DMG → 在临时目标目录试装 → 用装出来的副本跑自测
if [ "$VERIFY" = "1" ]; then
  MOUNT=""
  INSTALL_TEST_ROOT="$(mktemp -d)"
  cleanup_verify() {
    [ -z "$MOUNT" ] || hdiutil detach "$MOUNT" -quiet || true
    rm -rf "$INSTALL_TEST_ROOT"
  }
  trap cleanup_verify EXIT
  info "$(msg mount_dmg)"
  MOUNT="$(hdiutil attach -nobrowse -readonly "$OUT/$NAME.dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
  [ -d "$MOUNT" ] || die "$(msg mount_failed)"
  ls "$MOUNT" | sed 's/^/    /'
  [ -x "$MOUNT/Install Echo.command" ] || die "$(msg not_executable)"
  [ -f "$MOUNT/Echo.app/Contents/Info.plist" ] || die "$(msg app_incomplete)"

  info "$(msg test_install)"
  INST="$INSTALL_TEST_ROOT/Library/Application Support/Echo"
  if env -u ECHO_PASSWORD -u ECHO_DATA_DIR -u ECHO_CONFIG -u NODE_OPTIONS \
     ECHO_FORCE=1 OPENAI_API_KEY=sk-installer-selftest OPENAI_BASE_URL=https://example.invalid/v1 \
     ECHO_PORT=0 "$MOUNT/Install Echo.command" --no-launchd --no-open --target "$INST" <<< "" >"$INSTALL_TEST_ROOT/install.log" 2>&1; then
    ok "$(msg install_passed)"
  else
    tail -20 "$INSTALL_TEST_ROOT/install.log"
    die "$(msg test_install_failed)"
  fi
  [ -f "$INST/server.mjs" ] && [ -f "$INST/package-lock.json" ] && [ -d "$INST/node_modules/@modelcontextprotocol/sdk" ] && [ -f "$INST/Echo.app/Contents/MacOS/EchoBar" ] && [ -x "$INST/bin/echo" ] || die "$(msg missing_files)"
  ok "$(msg required_files)"

  info "$(msg test_copy)"
  if ( cd "$INST" && env -u NODE_OPTIONS node tests/selftest.mjs --json >"$INSTALL_TEST_ROOT/selftest.json" 2>&1 ); then
    cp "$INST/tests/last-report.json" "$OUT/$NAME.selftest.json"
    ok "$(msg copy_passed)"
  else
    tail -12 "$INSTALL_TEST_ROOT/selftest.json"
    die "$(msg copy_failed_tests)"
  fi

  # 隔离/凭据检查
  if [ -f "$INST/data/echo.env" ]; then
    perm=$(stat -f '%Lp' "$INST/data/echo.env")
    [ "$perm" = "600" ] || die "$(msg wrong_mode "$perm")"
    ok "$(msg creds_mode)"
  fi
  cleanup_verify
  trap - EXIT
  ok "$(msg dmg_passed)"
fi

echo
info "$(msg upload_release)"
echo "  gh release upload v$VER dist/$NAME.dmg dist/$NAME.zip dist/SHA256SUMS-macos --clobber"
