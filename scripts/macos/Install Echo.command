#!/bin/bash
# Echo installer for Finder or the terminal.
#   ./Install\ Echo.command [--target DIR] [--no-launchd] [--no-open] [--yes]
# Optional unattended setup: OPENAI_BASE_URL, OPENAI_API_KEY, ECHO_PASSWORD, ECHO_FORCE.
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

# The same commands run from a release bundle or its source checkout.
if [ -f "$SRC/bin/language.sh" ]; then
  source "$SRC/bin/language.sh"
else
  source "$SRC/../../bin/language.sh"
fi
echo_select_language "$TARGET"

ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
info() { printf '\033[36m·\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; echo; echo "$(msg enter_close)"; read -r _; exit 1; }

printf '\n\033[1m%s\033[0m\n' "$(msg installer_title)"
echo "$(msg install_target "$TARGET")"
echo "$(msg data_location)"
echo

# ── 1. Locate Node.js 22.13 or newer.
NODE=""
for cand in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
  [ -n "$cand" ] && [ -x "$cand" ] || continue
  if "$cand" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)' 2>/dev/null; then NODE="$cand"; break; fi
done
if [ -z "$NODE" ]; then
  warn "$(msg node_missing)"
  echo "$(msg install_node_options)"
  echo "$(msg brew_node)"
  echo "$(msg download_node)"
  die "$(msg node_required)"
fi
ok "Node: $NODE ($("$NODE" -v))"

# ── 2. Copy application files.
mkdir -p "$TARGET"
for item in server.mjs install.sh package.json package-lock.json node_modules bin lib public tests docs CHANGELOG.md README.md README.zh-CN.md; do
  if [ -e "$SRC/$item" ]; then
    rm -rf "$TARGET/$item" && cp -R "$SRC/$item" "$TARGET/$item" || die "$(msg copy_failed "$item")"
  fi
done
[ -f "$TARGET/package-lock.json" ] || die "$(msg redownload)"
if [ ! -d "$SRC/node_modules/@modelcontextprotocol/sdk" ]; then
  NPM="$(dirname "$NODE")/npm"
  [ -x "$NPM" ] || NPM="$(command -v npm || true)"
  [ -n "$NPM" ] || die "$(msg npm_required)"
  info "$(msg install_deps)"
  ( cd "$TARGET" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --ignore-scripts ) || die "$(msg deps_failed)"
fi
( cd "$TARGET" && "$NODE" --input-type=module -e "await import('./lib/mcp.mjs')" ) || die "$(msg mcp_incomplete)"
chmod +x "$TARGET/bin/echo"
mkdir -p "$TARGET/data/logs"
if [ -d "$SRC/Echo.app" ]; then
  rm -rf "$TARGET/Echo.app"
  # Remove the old bundle to avoid carrying its signature forward.
  ditto "$SRC/Echo.app" "$TARGET/Echo.app"
  codesign --force --deep --sign - --identifier com.echoassistant.menubar "$TARGET/Echo.app" >/dev/null 2>&1 || true
  ok "$(msg installed_app "$TARGET")"
fi
ok "$(msg copied "$TARGET")"

# ── 3. Optional BYOK credentials.
ENV_FILE="$TARGET/data/echo.env"
if [ -f "$ENV_FILE" ]; then
  ok "$(msg keep_creds "${ENV_FILE}")"
else
  BASE="${OPENAI_BASE_URL:-}"
  KEY="${OPENAI_API_KEY:-}"
  if [ -z "$KEY" ] && [ "$ASSUME_YES" = "0" ]; then
    echo
    echo "$(msg byok)"
    echo "$(msg endpoint_examples)"
    printf '%s' "$(msg base_url)"; read -r BASE
    if [ -n "$BASE" ]; then
      printf '%s' "$(msg hidden_key)"; read -rs KEY; echo
    fi
  fi
  if [ -n "$KEY" ]; then
    umask 077
    {
      echo "$(msg creds_comment)"
      echo "OPENAI_API_KEY=$KEY"
      [ -n "$BASE" ] && echo "OPENAI_BASE_URL=$BASE"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "$(msg wrote_creds "${ENV_FILE}")"
  else
    info "$(msg setup_later)"
  fi
fi

# ── 4. Optional access password.
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
" >/dev/null && ok "$(msg password_set)"
fi

# ── 5. Register launchd services.
if [ "$DO_LAUNCHD" = "1" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  MENUBAR_PLIST="$HOME/Library/LaunchAgents/$MENUBAR_LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  NODE_BIN_DIR="$(dirname "$NODE")"
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
    <key>ECHO_LANGUAGE</key><string>$ECHO_DISPLAY_LANGUAGE</string>
    $BIND_XML
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
    <key>ECHO_LANGUAGE</key><string>$ECHO_DISPLAY_LANGUAGE</string>
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
  ok "$(msg registered)"
else
  info "$(msg skip_launchd)"
fi

# ── 6. Ask before removing the macOS quarantine flag.
APP_PATH="$TARGET/Echo.app"
if [ -d "$APP_PATH" ] && xattr -p com.apple.quarantine "$APP_PATH" >/dev/null 2>&1; then
  echo
  warn "$(msg quarantine_found)"
  printf '%s' "$(msg remove_quarantine)"
  read -r ans
  case "$ans" in
    y|Y) xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null && ok "$(msg quarantine_removed)"
         if [ "$DO_LAUNCHD" = "1" ]; then
           launchctl kickstart -k "gui/$UID_NUM/$MENUBAR_LABEL" 2>/dev/null || true
         fi ;;
    *) info "$(msg keep_quarantine "$APP_PATH")" ;;
  esac
fi

# ── 7. Finish.
echo
if [ "$DO_LAUNCHD" = "0" ]; then
  info "$(msg no_service)"
elif curl -sf -m 5 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  PATH="$(dirname "$NODE"):$PATH" "$TARGET/bin/echo" status
else
  warn "$(msg service_log "$TARGET")"
fi
info "$(msg installed_commands "$TARGET")"
if [ "$DO_OPEN" = "1" ]; then open "http://127.0.0.1:$PORT"; fi
echo
echo "$(msg install_done)"
if [ -t 0 ]; then read -r _; fi
