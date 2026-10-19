#!/bin/bash
# 卸载 Echo：停服务、删 launchd、删程序与数据（会先问一次）
set -uo pipefail
TARGET="${ECHO_HOME:-$HOME/Library/Application Support/Echo}"
UID_NUM="$(id -u)"
LABEL="com.echo.chat"
MENUBAR_LABEL="com.echo.menubar"

echo
echo "将从 $TARGET 卸载 Echo（包含记忆与会话数据）。"
printf '确认删除？[y/N] '
read -r ans
case "$ans" in y|Y) ;; *) echo "已取消"; exit 0 ;; esac

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootout "gui/$UID_NUM/$MENUBAR_LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/Library/LaunchAgents/$MENUBAR_LABEL.plist"
rm -rf "$TARGET"
echo "✓ 已卸载。数据也一并删除了。"
echo "按回车关闭。"
read -r _