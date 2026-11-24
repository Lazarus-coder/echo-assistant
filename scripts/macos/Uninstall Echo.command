#!/bin/bash
# Confirm deletion before stopping services and removing the app and user data.
set -uo pipefail
TARGET="${ECHO_HOME:-$HOME/Library/Application Support/Echo}"
UID_NUM="$(id -u)"
LABEL="com.echo.chat"
MENUBAR_LABEL="com.echo.menubar"

# The same commands run from a release bundle or its source checkout.
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SRC/bin/language.sh" ]; then
  source "$SRC/bin/language.sh"
else
  source "$SRC/../../bin/language.sh"
fi
echo_select_language "$TARGET"

echo
echo "$(msg uninstall_target "$TARGET")"
printf '%s' "$(msg confirm_delete)"
read -r ans
case "$ans" in y|Y) ;; *) echo "$(msg canceled)"; exit 0 ;; esac

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/$MENUBAR_LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/Library/LaunchAgents/$MENUBAR_LABEL.plist"
rm -rf "$TARGET"
echo "$(msg uninstalled)"
echo "$(msg close)"
read -r _