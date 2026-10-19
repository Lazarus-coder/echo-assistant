#!/bin/bash
# 一键安装：环境文件 → 访问口令 → launchd 常驻 → 状态栏图标
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.echo.chat"
MENUBAR_LABEL="com.echo.menubar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
MENUBAR_PLIST="$HOME/Library/LaunchAgents/$MENUBAR_LABEL.plist"
UID_NUM="$(id -u)"
PORT="${ECHO_PORT:-8787}"
NODE="$(command -v node || true)"
WITH_MENUBAR=1
[ "${1:-}" = "--no-menubar" ] && WITH_MENUBAR=0

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '\033[36m·\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$NODE" ] || die "没找到 node。先装 Node（brew install node）再跑这个脚本。"
info "node: $NODE"
info "项目目录: $ROOT"

mkdir -p "$ROOT/data/logs" "$ROOT/data/conversations" "$ROOT/data/memory" "$ROOT/data/uploads" "$ROOT/build"

# ---------------------------------------------------------------- 1. 凭据文件
if [ -f "$ROOT/data/echo.env" ]; then
  ok "data/echo.env 已存在，沿用（要换 key 就删掉它重跑）"
else
  info "从你的登录 shell 读取 OPENAI_API_KEY / OPENAI_BASE_URL（不会回显）…"
  KEY="$(zsh -ic 'printf "%s" "${OPENAI_API_KEY:-}"' 2>/dev/null || true)"
  BASEURL="$(zsh -ic 'printf "%s" "${OPENAI_BASE_URL:-}"' 2>/dev/null || true)"
  if [ -z "$BASEURL" ]; then
    echo "常用端点："
    echo "  1) OpenAI                https://api.openai.com/v1"
    echo "  2) 阿里云百炼(兼容模式)  https://dashscope.aliyuncs.com/compatible-mode/v1"
    echo "  3) DeepSeek              https://api.deepseek.com/v1"
    echo "  4) Moonshot(Kimi)        https://api.moonshot.cn/v1"
    echo "  5) OpenRouter            https://openrouter.ai/api/v1"
    echo "  6) Ollama(本机)          http://127.0.0.1:11434/v1"
    printf '模型端点 Base URL（或直接回车，稍后在网页引导里填）: '
    read -r BASEURL
  fi
  if [ -z "$KEY" ]; then
    printf 'shell 里没有 OPENAI_API_KEY，直接贴一个（输入不回显）: '
    read -rs KEY; echo
  fi
  [ -n "$KEY" ] || die "没有 API Key，无法继续"
  umask 077
  {
    echo "# Echo 本地凭据，仅本机可读（chmod 600）"
    echo "OPENAI_API_KEY=$KEY"
    echo "OPENAI_BASE_URL=$BASEURL"
  } > "$ROOT/data/echo.env"
  chmod 600 "$ROOT/data/echo.env"
  ok "已写入 data/echo.env（base=$BASEURL）"
fi

# ------------------------------------------------------------------- 2. 口令
if node -e "const a=require('fs').existsSync('$ROOT/data/auth.json')&&JSON.parse(require('fs').readFileSync('$ROOT/data/auth.json','utf8')).password; process.exit(a?0:1)"; then
  ok "访问口令已设置（改口令：./bin/echo passwd）"
else
  printf '设置访问口令（≥6 位，手机访问要用）: '
  read -rs PW; echo
  if [ "${#PW}" -lt 6 ]; then
    warn "太短或为空，先跳过。局域网访问会退化为仅本机；之后可用 ./bin/echo passwd 设置"
  else
    PW="$PW" ROOT="$ROOT" node -e "
const crypto=require('crypto'),fs=require('fs'),path=require('path')
const salt=crypto.randomBytes(16).toString('hex')
const hash=crypto.scryptSync(process.env.PW,salt,64).toString('hex')
const file=path.join(process.env.ROOT,'data','auth.json')
let auth={}; try{ auth=JSON.parse(fs.readFileSync(file,'utf8')) }catch{}
auth.password={salt,hash}; auth.setAt=new Date().toISOString()
fs.writeFileSync(file,JSON.stringify(auth,null,2),{mode:0o600})
console.log('ok')
"
    ok "口令已写入 data/auth.json（scrypt 加盐哈希）"
  fi
fi

# --------------------------------------------------------------- 3. launchd
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$ROOT/data/logs/echo.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/echo.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>ECHO_ROOT</key><string>$ROOT</string>
    <key>ECHO_PORT</key><string>$PORT</string>
  </dict>
</dict>
</plist>
PLISTEOF
ok "已写 $PLIST"

# ------------------------------------------------------------ 4. 状态栏图标
MENUBAR_BIN=""
if [ "$WITH_MENUBAR" = "1" ]; then
  if command -v swiftc >/dev/null 2>&1; then
    info "编译状态栏 App（首次约 10–30 秒）…"
    if swiftc -O -o "$ROOT/build/EchoBar" "$ROOT/menubar/main.swift" "$ROOT/menubar/EchoBar.swift" "$ROOT/menubar/CompanionOverlay.swift" 2>"$ROOT/data/logs/swiftc.log"; then
      MENUBAR_BIN="$ROOT/build/EchoBar"
      ok "状态栏 App 编译完成：build/EchoBar"
    else
      warn "编译失败，日志见 data/logs/swiftc.log（跳过状态栏，其余功能不受影响）"
    fi
  else
    warn "没有 swiftc（装 Xcode Command Line Tools 后可再跑一次）"
  fi
fi

if [ -n "$MENUBAR_BIN" ]; then
  cat > "$MENUBAR_PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$MENUBAR_LABEL</string>
  <key>ProgramArguments</key><array><string>$MENUBAR_BIN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$ROOT/data/logs/menubar.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/menubar.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ECHO_ROOT</key><string>$ROOT</string>
    <key>ECHO_PORT</key><string>$PORT</string>
    <key>ECHO_SERVICE</key><string>$LABEL</string>
  </dict>
</dict>
</plist>
PLISTEOF
  ok "已写 $MENUBAR_PLIST"
fi

# ------------------------------------------------------------------ 5. 启动
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
if [ -n "$MENUBAR_BIN" ]; then
  launchctl bootout "gui/$UID_NUM/$MENUBAR_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$MENUBAR_PLIST"
fi
sleep 2

LAN="$(ipconfig getifaddr en0 2>/dev/null || true)"
echo
if curl -sf -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  ok "Echo 已常驻运行（登录自动启动、崩溃自动拉起）"
  echo "   本机   http://127.0.0.1:$PORT"
  [ -n "$LAN" ] && echo "   手机   http://$LAN:$PORT  （同一 WiFi，需要口令）"
  echo
  echo "   常用命令： ./bin/echo status | logs | dream | say | open"
else
  warn "服务还没起来，看看日志： tail -20 $ROOT/data/logs/echo.err.log"
fi