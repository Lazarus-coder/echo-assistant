#!/bin/bash
# Echo 安装器（双击运行，也可命令行调用）
#   ./Install\ Echo.command [--target DIR] [--no-launchd] [--no-open] [--yes]
# 环境变量（可选，用于无人值守）：OPENAI_BASE_URL / OPENAI_API_KEY / ECHO_PASSWORD / ECHO_FORCE
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${ECHO_HOME:-$HOME/Library/Application Support/Echo}"
LABEL="com.echo.chat"
MENUBAR_LABEL="com.echo.menubar"
PORT="${ECHO_PORT:-8787}"
UID_NUM="$(id -u)"
DO_LAUNCHD=1
DO_OPEN=1
ASSUME_YES="${ECHO_FORCE:-0}"

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --no-launchd) DO_LAUNCHD=0; shift ;;
    --no-open) DO_OPEN=0; shift ;;
    --yes) ASSUME_YES=1; shift ;;
    *) shift ;;
  esac
done

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '\033[36m·\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; echo; echo "按回车关闭…"; read -r _; exit 1; }

printf '\n\033[1mEcho 安装器\033[0m\n'
echo "把「跑在自己 Mac 上的私人对话窗口」装到 $TARGET"
echo "（数据也放在那里：明文可读、删除即卸载干净）"
echo

# ── 1. 找 Node（≥22.13） ─────────────────────────────────────────────
NODE=""
for cand in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  if "$cand" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)' 2>/dev/null; then NODE="$cand"; break; fi
done
if [ -z "$NODE" ]; then
  warn "没有找到 Node 22.13 或更高版本"
  echo "  装一个再回来（任选其一）："
  echo "    brew install node        # 有 Homebrew"
  echo "    或到 https://nodejs.org 下载 LTS 版"
  die "缺少 Node"
fi
ok "Node: $NODE ($("$NODE" -v))"

# ── 2. 复制文件 ─────────────────────────────────────────────────────
mkdir -p "$TARGET"
for item in server.mjs package.json package-lock.json node_modules bin lib public tests docs CHANGELOG.md README.md README.zh-CN.md; do
  if [ -e "$SRC/$item" ]; then
    rm -rf "$TARGET/$item" && cp -R "$SRC/$item" "$TARGET/$item" || die "复制失败：$item"
  fi
done
[ -f "$TARGET/package-lock.json" ] || die "缺少依赖锁文件，请重新下载完整发行包"
if [ ! -d "$SRC/node_modules/@modelcontextprotocol/sdk" ]; then
  NPM="$(dirname "$NODE")/npm"
  [ -x "$NPM" ] || NPM="$(command -v npm || true)"
  [ -n "$NPM" ] || die "此发行包未包含运行依赖，需要 npm（随 Node.js 安装）"
  info "安装锁定版本的运行依赖…"
  ( cd "$TARGET" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --ignore-scripts ) || die "运行依赖安装失败"
fi
( cd "$TARGET" && "$NODE" --input-type=module -e "await import('./lib/mcp.mjs')" ) || die "MCP 运行依赖不完整，请重新下载安装包"
chmod +x "$TARGET/bin/echo" "$TARGET/bin/echo" 2>/dev/null
[ -e "$SRC/docs" ] && true
mkdir -p "$TARGET/data/logs"
if [ -d "$SRC/Echo.app" ]; then
  rm -rf "$TARGET/Echo.app"
  # 先删旧 bundle 再拷贝，避免旧签名残留
  ditto "$SRC/Echo.app" "$TARGET/Echo.app"
  codesign --force --deep --sign - --identifier com.echoassistant.menubar "$TARGET/Echo.app" >/dev/null 2>&1 || true
  ok "已安装应用：$TARGET/Echo.app（ad-hoc 签名，路径固定；屏幕录制授权只需给一次）"
fi
ok "已复制程序文件到 $TARGET"

# ── 3. 模型端点与密钥（可跳过，之后在网页引导里填） ──────────────────
ENV_FILE="$TARGET/data/echo.env"
if [ -f "$ENV_FILE" ]; then
  ok "沿用已有凭据（$ENV_FILE）"
else
  BASE="${OPENAI_BASE_URL:-}"
  KEY="${OPENAI_API_KEY:-}"
  if [ -z "$KEY" ] && [ "$ASSUME_YES" = "0" ]; then
    echo
    echo "现在填模型 API（BYOK）。留空则稍后在网页里引导填写。"
    echo "常用端点：OpenAI https://api.openai.com/v1 ｜ 阿里云百炼 https://dashscope.aliyuncs.com/compatible-mode/v1 ｜ DeepSeek https://api.deepseek.com/v1"
    printf '模型端点 Base URL: '; read -r BASE
    if [ -n "$BASE" ]; then
      printf 'API Key（不回显）: '; read -rs KEY; echo
    fi
  fi
  if [ -n "$KEY" ]; then
    umask 077
    {
      echo "# Echo 凭据，仅本机可读"
      echo "OPENAI_API_KEY=$KEY"
      [ -n "$BASE" ] && echo "OPENAI_BASE_URL=$BASE"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "凭据已写入 $ENV_FILE（权限 600）"
  else
    info "跳过：首次打开网页时会有六步引导"
  fi
fi

# ── 4. 访问口令（可选） ─────────────────────────────────────────────
if [ -n "${ECHO_PASSWORD:-}" ] && [ "${#ECHO_PASSWORD}" -ge 6 ]; then
  ECHO_PASSWORD="$ECHO_PASSWORD" TARGET="$TARGET" "$NODE" -e "
const crypto=require('crypto'),fs=require('fs'),path=require('path')
try{
  const salt=crypto.randomBytes(16).toString('hex')
  const hash=crypto.scryptSync(process.env.ECHO_PASSWORD,salt,64).toString('hex')
  const file=path.join(process.env.TARGET,'data','auth.json')
  let auth={}; try{ auth=JSON.parse(fs.readFileSync(file,'utf8')) }catch{}
  auth.password={salt,hash}; auth.setAt=new Date().toISOString()
  fs.writeFileSync(file,JSON.stringify(auth,null,2),{mode:0o600})
  console.log('ok')
}catch(e){ console.error(e.message) }
" >/dev/null && ok "已设置访问口令"
fi

# ── 5. launchd 常驻 ─────────────────────────────────────────────────
if [ "$DO_LAUNCHD" = "1" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  MENUBAR_PLIST="$HOME/Library/LaunchAgents/$MENUBAR_LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  NODE_BIN_DIR="$(dirname "$NODE")"
  cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$TARGET/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$TARGET</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$TARGET/data/logs/echo.out.log</string>
  <key>StandardErrorPath</key><string>$TARGET/data/logs/echo.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_BIN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ECHO_ROOT</key><string>$TARGET</string>
    <key>ECHO_PORT</key><string>$PORT</string>
  </dict>
</dict>
</plist>
PLISTEOF
  if [ -d "$TARGET/Echo.app" ]; then
    cat > "$MENUBAR_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$MENUBAR_LABEL</string>
  <key>ProgramArguments</key><array><string>$TARGET/Echo.app/Contents/MacOS/EchoBar</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$TARGET/data/logs/menubar.out.log</string>
  <key>StandardErrorPath</key><string>$TARGET/data/logs/menubar.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ECHO_ROOT</key><string>$TARGET</string>
    <key>ECHO_PORT</key><string>$PORT</string>
    <key>ECHO_SERVICE</key><string>$LABEL</string>
  </dict>
</dict>
</plist>
PLISTEOF
  fi
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null
  if [ -f "$MENUBAR_PLIST" ]; then
    launchctl bootout "gui/$UID_NUM/$MENUBAR_LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_NUM" "$MENUBAR_PLIST" 2>/dev/null || launchctl load "$MENUBAR_PLIST" 2>/dev/null
  fi
  sleep 2
  ok "已注册常驻服务（登录自启、崩溃自动拉起）"
else
  info "（跳过 launchd 注册：--no-launchd）"
fi

# ── 6. 隔离标记（下载来的文件会被 Gatekeeper 拦，需要显式确认） ──────
APP_PATH="$TARGET/Echo.app"
if [ -d "$APP_PATH" ] && xattr -p com.apple.quarantine "$APP_PATH" >/dev/null 2>&1; then
  echo
  warn "检测到 macOS 隔离标记：这会阻止状态栏图标启动"
  printf '要现在移除吗？（这是你自己下载的开源项目，源码在本机可查）[y/N] '
  read -r ans
  case "$ans" in
    y|Y) xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null && ok "已移除隔离标记"
         if [ "$DO_LAUNCHD" = "1" ]; then
           launchctl kickstart -k "gui/$UID_NUM/$MENUBAR_LABEL" 2>/dev/null || true
         fi ;;
    *) info "保留标记：首次可右键点图标 → 打开；或自行运行 xattr -dr com.apple.quarantine \"$APP_PATH\"" ;;
  esac
fi

# ── 7. 完成 ─────────────────────────────────────────────────────────
echo
if curl -sf -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  ok "服务在跑：http://127.0.0.1:$PORT"
else
  warn "服务还没起来；看看 $TARGET/data/logs/echo.err.log"
fi
LAN="$(ipconfig getifaddr en0 2>/dev/null || true)"
[ -n "$LAN" ] && info "同一 WiFi 下手机可访问：http://$LAN:$PORT"
info "常用命令：$TARGET/bin/echo status | logs | dream | diag | selftest"
if [ "$DO_OPEN" = "1" ]; then open "http://127.0.0.1:$PORT"; fi
echo
echo "安装结束。按回车关闭这个窗口。"
read -r _
