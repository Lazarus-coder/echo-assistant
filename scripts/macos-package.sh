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

ALLOW_DIRTY=0
for arg in "$@"; do [ "$arg" = "--allow-dirty" ] && ALLOW_DIRTY=1; done
if [ -n "$(git status --porcelain)" ] && [ "$ALLOW_DIRTY" = "0" ]; then
  printf '\033[31m✗ 工作区有未提交改动，拒绝打包（DMG 装的是工作区内容，会带上未提交的改动）\033[0m\n'
  git status --short | head -12 | sed 's/^/    /'
  printf '  先提交，或显式用 --allow-dirty 打包\n'
  exit 1
fi

command -v swiftc >/dev/null || die "需要 swiftc（xcode-select --install）"
command -v hdiutil >/dev/null || die "需要 hdiutil（macOS 自带）"
command -v npm >/dev/null || die "需要 npm 来打包锁定版本的运行依赖"
[ -f "$ROOT/package-lock.json" ] || die "缺少 package-lock.json"
node tests/installer-regressions.mjs || die "安装器隔离回归未通过"

rm -rf "$STAGE" && mkdir -p "$STAGE" "$OUT" "$ROOT/build"

# 1) 编译状态栏 App（通用二进制：Apple Silicon + Intel）+ 图标
info "编译状态栏 App（arm64 + x86_64）…"
SWIFT_SRC="menubar/main.swift menubar/EchoBar.swift menubar/CompanionOverlay.swift"
swiftc -O -target arm64-apple-macos13.0 -o "$ROOT/build/EchoBar.arm64" $SWIFT_SRC
if swiftc -O -target x86_64-apple-macos13.0 -o "$ROOT/build/EchoBar.x86" $SWIFT_SRC 2>/dev/null; then
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
# ad-hoc 签名：固定 bundle id + 固定路径，让"屏幕录制"授权尽量一次生效（未签名的裸二进制每次重编都会被当成新 App）
codesign --force --deep --sign - --identifier com.echoassistant.menubar "$APP" >/dev/null 2>&1 || true
codesign -dv "$APP" 2>&1 | grep -q 'adhoc' && ok "已 ad-hoc 签名（Identifier=com.echoassistant.menubar）" || info "未签名（macOS 会要求单独授权）"
ok "Echo.app 组装完成（$(du -sh "$APP" | awk '{print $1}')）"

# 3) 仅打包已提交的程序文件，排除目录内未跟踪的本机文件。
git archive HEAD -- server.mjs install.sh package.json package-lock.json bin lib public tests docs CHANGELOG.md README.md README.zh-CN.md | tar -x -C "$STAGE"
info "打包锁定版本的运行依赖（安装 DMG 时无需联网下载）…"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts ) || die "运行依赖安装失败"
( cd "$STAGE" && node --input-type=module -e "await import('./lib/mcp.mjs')" ) || die "MCP 运行依赖校验失败"
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

# 5) 验证：挂载 DMG → 在临时目标目录试装 → 用装出来的副本跑自测
if [ "$VERIFY" = "1" ]; then
  MOUNT=""
  INSTALL_TEST_ROOT="$(mktemp -d)"
  cleanup_verify() {
    [ -z "$MOUNT" ] || hdiutil detach "$MOUNT" -quiet || true
    rm -rf "$INSTALL_TEST_ROOT"
  }
  trap cleanup_verify EXIT
  info "挂载 DMG 验证…"
  MOUNT="$(hdiutil attach -nobrowse -readonly "$OUT/$NAME.dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
  [ -d "$MOUNT" ] || die "DMG 挂载失败"
  ls "$MOUNT" | sed 's/^/    /'
  [ -x "$MOUNT/Install Echo.command" ] || die "安装器没有可执行位"
  [ -f "$MOUNT/Echo.app/Contents/Info.plist" ] || die "Echo.app 不完整"

  info "在临时目标目录试装（不注册或打开服务）…"
  if env -u ECHO_PASSWORD -u ECHO_DATA_DIR -u ECHO_CONFIG -u NODE_OPTIONS \
     ECHO_FORCE=1 OPENAI_API_KEY=sk-installer-selftest OPENAI_BASE_URL=https://example.invalid/v1 \
     ECHO_HOME="$INSTALL_TEST_ROOT/Apps/Echo" ECHO_PORT=0 \
     "$MOUNT/Install Echo.command" --no-launchd --no-open --target "$INSTALL_TEST_ROOT/Apps/Echo" <<< "" >"$INSTALL_TEST_ROOT/install.log" 2>&1; then
    ok "安装器跑通"
  else
    tail -20 "$INSTALL_TEST_ROOT/install.log"
    die "安装器在临时目标目录下失败（见上面输出）"
  fi
  INST="$INSTALL_TEST_ROOT/Apps/Echo"
  [ -f "$INST/server.mjs" ] && [ -f "$INST/package-lock.json" ] && [ -d "$INST/node_modules/@modelcontextprotocol/sdk" ] && [ -f "$INST/Echo.app/Contents/MacOS/EchoBar" ] && [ -x "$INST/bin/echo" ] || die "安装结果缺少关键文件"
  ok "装出的内容完整（server.mjs / MCP 依赖 / Echo.app / bin/echo）"

  info "用装出来的副本跑离线自测…"
  if ( cd "$INST" && env -u NODE_OPTIONS node tests/selftest.mjs --json >"$INSTALL_TEST_ROOT/selftest.json" 2>&1 ); then
    cp "$INST/tests/last-report.json" "$OUT/$NAME.selftest.json"
    ok "安装副本自测通过"
  else
    tail -12 "$INSTALL_TEST_ROOT/selftest.json"
    die "安装副本自测未通过"
  fi

  # 隔离/凭据检查
  if [ -f "$INST/data/echo.env" ]; then
    perm=$(stat -f '%Lp' "$INST/data/echo.env")
    [ "$perm" = "600" ] || die "echo.env 权限不是 600（是 ${perm}）"
    ok "凭据文件权限 600"
  fi
  cleanup_verify
  trap - EXIT
  ok "DMG 验证通过"
fi

echo
info "上传到 release："
echo "  gh release upload v$VER dist/$NAME.dmg dist/$NAME.zip dist/SHA256SUMS-macos --clobber"
