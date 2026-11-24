#!/bin/bash
# Install credentials, launchd services, and the native menu bar app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$ROOT/bin/language.sh"
echo_select_language "$ROOT"

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

[ -n "$NODE" ] || die "$(msg need_node)"
"$NODE" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)' || die "$(msg node_version)"
info "node: $NODE"
info "$(msg project_dir "$ROOT")"

NPM="$(dirname "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || die "$(msg need_npm)"
[ -f "$ROOT/package-lock.json" ] || die "$(msg missing_lock)"
info "$(msg install_sdk)"
( cd "$ROOT" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --ignore-scripts ) || die "$(msg install_failed)"

mkdir -p "$ROOT/data/logs" "$ROOT/data/conversations" "$ROOT/data/memory" "$ROOT/data/uploads" "$ROOT/build"

# Reuse the installed bundle to preserve its macOS permissions.
INSTALLED_APP="$HOME/Library/Application Support/Echo/Echo.app"
if [ -x "$INSTALLED_APP/Contents/MacOS/EchoBar" ]; then
  echo "$(msg existing_app "${INSTALLED_APP}")"
  export ECHO_SKIP_MENUBAR_BUILD=1
fi

# 1. Credentials
if [ -f "$ROOT/data/echo.env" ]; then
  ok "$(msg existing_env)"
else
  info "$(msg read_credentials)"
  KEY="$(zsh -ic 'printf "%s" "${OPENAI_API_KEY:-}"' 2>/dev/null || true)"
  BASEURL="$(zsh -ic 'printf "%s" "${OPENAI_BASE_URL:-}"' 2>/dev/null || true)"
  if [ -z "$BASEURL" ]; then
    echo "$(msg endpoints)"
    echo "  1) OpenAI                https://api.openai.com/v1"
    echo "$(msg dashscope)"
    echo "  3) DeepSeek              https://api.deepseek.com/v1"
    echo "  4) Moonshot(Kimi)        https://api.moonshot.cn/v1"
    echo "  5) OpenRouter            https://openrouter.ai/api/v1"
    echo "$(msg ollama)"
    printf '%s' "$(msg endpoint_prompt)"
    read -r BASEURL
  fi
  if [ -z "$KEY" ]; then
    printf '%s' "$(msg key_prompt)"
    read -rs KEY; echo
  fi
  if [ -n "$KEY" ]; then
    umask 077
    {
      echo "$(msg local_creds)"
      printf 'OPENAI_API_KEY=%s\n' "$KEY"
      printf 'OPENAI_BASE_URL=%s\n' "$BASEURL"
    } > "$ROOT/data/echo.env"
    chmod 600 "$ROOT/data/echo.env"
    ok "$(msg env_written "$BASEURL")"
  else
    info "$(msg key_missing)"
  fi
fi

# 2. Optional access password
if node -e 'try {process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).password ? 0 : 1)} catch {process.exit(1)}' "$ROOT/data/auth.json"; then
  ok "$(msg password_exists)"
else
  printf '%s' "$(msg password_prompt)"
  read -rs PW; echo
  if [ "${#PW}" -lt 6 ]; then
    warn "$(msg password_skipped)"
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
    ok "$(msg password_saved)"
  fi
fi

# --------------------------------------------------------------- 3. launchd
SAVED_BIND="${ECHO_BIND-$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:ECHO_BIND' "$PLIST" 2>/dev/null || true)}"
if [ "${ECHO_BIND+x}" ] && [ "$SAVED_BIND" != "all" ]; then SAVED_BIND=local; fi
BIND_XML=""
case "$SAVED_BIND" in all|local) BIND_XML="<key>ECHO_BIND</key><string>$SAVED_BIND</string>" ;; esac
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
    <key>ECHO_LANGUAGE</key><string>$ECHO_DISPLAY_LANGUAGE</string>
    $BIND_XML
  </dict>
</dict>
</plist>
PLISTEOF
ok "$(msg wrote "$PLIST")"

# 4. Menu bar app
MENUBAR_BIN=""
if [ "$WITH_MENUBAR" = "1" ] && [ "${ECHO_SKIP_MENUBAR_BUILD:-0}" = "0" ]; then
  if command -v swiftc >/dev/null 2>&1; then
    info "$(msg build_menu)"
    if swiftc -O -o "$ROOT/build/EchoBar" "$ROOT/menubar/main.swift" "$ROOT/menubar/EchoBar.swift" "$ROOT/menubar/CompanionOverlay.swift" 2>"$ROOT/data/logs/swiftc.log"; then
      MENUBAR_BIN="$ROOT/build/EchoBar"
      ok "$(msg built_menu)"
    else
      warn "$(msg build_failed)"
    fi
  else
    warn "$(msg need_swift)"
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
    <key>ECHO_LANGUAGE</key><string>$ECHO_DISPLAY_LANGUAGE</string>
    <key>ECHO_SERVICE</key><string>$LABEL</string>
  </dict>
</dict>
</plist>
PLISTEOF
  ok "$(msg wrote_menu "$MENUBAR_PLIST")"
fi

# 5. Startup
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
if [ -n "$MENUBAR_BIN" ]; then
  launchctl bootout "gui/$UID_NUM/$MENUBAR_LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$UID_NUM" "$MENUBAR_PLIST"
fi
sleep 2

echo
if curl -sf -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  ok "$(msg installed_service)"
  "$ROOT/bin/echo" status
  echo
  echo "$(msg commands)"
else
  warn "$(msg check_log "$ROOT")"
fi
