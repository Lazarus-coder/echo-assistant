# Resolve the terminal language before printing prompts, including on a Mac
# where Node.js has not been installed yet.
echo_select_language() {
  local profile_root="$1" choice="${ECHO_LANGUAGE:-}" profile system_lang node_path
  case "$choice" in
    en|zh-CN) ;;
    *)
      profile="${ECHO_CONFIG:-$profile_root/config.json}"
      node_path="$(command -v node 2>/dev/null || true)"
      if [ -z "$node_path" ]; then
        for node_path in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$node_path" ] && break; done
      fi
      if [ -r "$profile" ] && [ -x "$node_path" ]; then
        # Older profiles and unrecognized saved language codes use the server's Chinese default.
        choice="$("$node_path" -e 'try { const value = String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).language || "zh-CN"); process.stdout.write(/^en(?:[-_]|$)/i.test(value) ? "en" : "zh-CN") } catch {}' "$profile")"
      elif [ -f "${ECHO_DATA_DIR:-$profile_root/data}/conversations/main.json" ]; then
        choice=zh-CN
      fi
      ;;
  esac
  case "$choice" in
    en|zh-CN) ECHO_DISPLAY_LANGUAGE="$choice" ;;
    *)
      system_lang="${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}"
      if [ -z "$system_lang" ] && [ -x /usr/bin/defaults ]; then
        system_lang="$(/usr/bin/defaults read -g AppleLanguages 2>/dev/null | sed -n '2{s/[" ,]//g;p;}' || true)"
      fi
      case "$system_lang" in zh*) ECHO_DISPLAY_LANGUAGE=zh-CN ;; *) ECHO_DISPLAY_LANGUAGE=en ;; esac
      ;;
  esac
  source "$(dirname "${BASH_SOURCE[0]}")/locales/$ECHO_DISPLAY_LANGUAGE.sh"
}
