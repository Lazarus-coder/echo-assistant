#!/bin/bash
# 构建 macOS 发行包：Echo.app（状态栏应用）+ 安装器 → .dmg / .zip
# 用法：bash scripts/macos-package.sh [--no-verify]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
VER="$(node -p "require('./package.json').version")"
NAME="Echo-$VER-macos"
STAGE="$ROOT/dist/stage/$NAME"
OUT="$ROOT/dist"
VERIFY=1
[ "${1:-}" = "--no-verify" ] && VERIFY=0

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '\033[36m·\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v swiftc >/dev/null || die "需要 swiftc（xcode-select --install）"
command -v hdiutil >/dev/null || die "需要 hdiutil（macOS 自带）"

rm -rf "$STAGE" && mkdir -p "$STAGE" "$OUT"

# 1) 编译状态栏 App（通用二进制：Apple Silicon + Intel）+ 图标
info "编译状态栏 App（arm64 + x86_64）…"
swiftc -O -target arm64-apple-macos13.0 -o "$ROOT/build/EchoBar.arm64" menubar/EchoBar.swift
if swiftc -O -target x86_64-apple-macos13.0 -o "$ROOT/build/EchoBar.x86" menubar/EchoBar.swift 2>/dev/null; then
  lipo -create "$ROOT/build/EchoBar.arm64" "$ROOT/build/EchoBar.x86" -output "$ROOT/build/EchoBar"
  ok "通用二进制：$(lipo -archs "$ROOT/build/EchoBar")"
else
  cp "$ROOT/build/EchoBar.arm64" "$ROOT/build/EchoBar"
  info "（x86_64 编译不可用，仅 Apple Silicon：$(lipo -archs "$ROOT/build/EchoBar")）"
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
plutil -lint "$APP/Contents/Info.plist" >/dev/null || die "Info.plist 不合法"
ok "Echo.app 组装完成（$(du -sh "$APP" | awk '{print $1}')）"

# 3) 程序文件 + 安装器
for item in server.mjs package.json bin lib public tests docs CHANGELOG.md README.md README.zh-CN.md; do
  [ -e "$ROOT/$item" ] && cp -R "$ROOT/$item" "$STAGE/$item"
done
rm -rf "$STAGE/tests/last-report.json"
cp "scripts/macos/Install Echo.command" "$STAGE/"
cp "scripts/macos/Uninstall Echo.command" "$STAGE/"
cp "scripts/macos/README.txt" "$STAGE/安装说明 README.txt"
chmod +x "$STAGE/Install Echo.command" "$STAGE/Uninstall Echo.command" "$STAGE/bin/echo"

# 4) DMG + ZIP
info "生成 DMG…"
rm -f "$OUT/$NAME.dmg" "$OUT/$NAME.zip"
hdiutil create -volname "Echo $VER" -srcfolder "$STAGE" -ov -format UDZO -quiet "$OUT/$NAME.dmg"
( cd "$OUT" && ditto -c -k --sequesterRsrc --keepParent "stage/$NAME" "$NAME.zip" )
rm -rf "$ROOT/dist/stage"
( cd "$OUT" && { shasum -a 256 "$NAME.dmg" "$NAME.zip" | awk '{print $1"  "$2}'; } > "SHA256SUMS-macos" )
ok "DMG: $(du -h "$OUT/$NAME.dmg" | awk '{print $1}')  ZIP: $(du -h "$OUT/$NAME.zip" | awk '{print $1}')"
printf '  sha256 %s\n' "$(awk '/dmg/{print $1}' "$OUT/SHA256SUMS-macos")"

# 5) 验证：挂载 DMG → 在临时 HOME 里真装一遍 → 用装出来的副本跑自测
if [ "$VERIFY" = "1" ]; then
  info "挂载 DMG 验证…"
  MOUNT="$(hdiutil attach -nobrowse -readonly "$OUT/$NAME.dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
  [ -d "$MOUNT" ] || die "DMG 挂载失败"
  ls "$MOUNT" | sed 's/^/    /'
  [ -x "$MOUNT/Install Echo.command" ] || die "安装器没有可执行位"
  [ -f "$MOUNT/Echo.app/Contents/Info.plist" ] || die "Echo.app 不完整"

  FAKE_HOME="$(mktemp -d)"
  info "在临时 HOME 里试装（不触碰你现有安装）…"
  if HOME="$FAKE_HOME" ECHO_FORCE=1 OPENAI_API_KEY=sk-installer-selftest OPENAI_BASE_URL=https://example.invalid/v1 \
     ECHO_HOME="$FAKE_HOME/Apps/Echo" \
     "$MOUNT/Install Echo.command" --no-launchd --no-open --target "$FAKE_HOME/Apps/Echo" <<< "" >/tmp/echo-install-test.log 2>&1; then
    ok "安装器跑通"
  else
    tail -20 /tmp/echo-install-test.log
    hdiutil detach "$MOUNT" -quiet || true
    die "安装器在临时 HOME 下失败（见上面输出）"
  fi
  INST="$FAKE_HOME/Apps/Echo"
  [ -f "$INST/server.mjs" ] && [ -f "$INST/Echo.app/Contents/MacOS/EchoBar" ] && [ -x "$INST/bin/echo" ] || die "安装结果缺少关键文件"
  ok "装出的内容完整（server.mjs / Echo.app / bin/echo）"

  info "用装出来的副本跑离线自测…"
  if ( cd "$INST" && node tests/selftest.mjs --json >/tmp/echo-installed-test.json 2>&1 ); then
    ok "安装副本自测通过"
  else
    tail -12 /tmp/echo-installed-test.json
    hdiutil detach "$MOUNT" -quiet || true
    die "安装副本自测未通过"
  fi

  # 隔离/凭据检查
  if [ -f "$INST/data/echo.env" ]; then
    perm=$(stat -f '%Lp' "$INST/data/echo.env")
    [ "$perm" = "600" ] || die "echo.env 权限不是 600（是 $perm）"
    ok "凭据文件权限 600"
  fi
  rm -rf "$FAKE_HOME"
  hdiutil detach "$MOUNT" -quiet || true
  ok "DMG 验证通过"
fi

echo
info "上传到 release："
echo "  gh release upload v$VER dist/$NAME.dmg dist/$NAME.zip dist/SHA256SUMS-macos --clobber"