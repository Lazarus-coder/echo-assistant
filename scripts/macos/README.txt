Echo — a private chat window that runs on your Mac
==================================================

Install
-------
1. Double-click  "Install Echo.command"
   (if macOS refuses to open it, right-click → Open, or run:
    xattr -dr com.apple.quarantine "<this folder>")
2. It will ask for your model API endpoint + key (BYOK). Press Enter to skip —
   the browser setup can save these details later.
3. When it finishes, your browser opens http://127.0.0.1:8787

What gets installed
-------------------
  ~/Library/Application Support/Echo      the app, its data, its logs
  ~/Library/LaunchAgents/com.echo.chat.plist      service (login start, crash restart)
  ~/Library/LaunchAgents/com.echo.menubar.plist   menu-bar icon
  ~/Library/Application Support/Echo/Echo.app   the menu-bar app

Everything Echo knows lives under "Application Support/Echo/data" as plain
files: echo.env (keys, mode 600), conversations, memory, images, logs.
Deleting the data directory does not remove the launchd registrations.
Use "Uninstall Echo.command" to stop the services and remove those registrations;
it asks for confirmation before deleting the application and its data.

Requirements
------------
  macOS 13+ and Node 22.13 or newer (brew install node, or nodejs.org).

Notes
-----
* New profiles listen only on this Mac. With LAN access explicitly enabled,
  run "<target>/bin/echo status" to see the listening address.
* Screen awareness (off by default) needs Screen Recording permission:
  menu-bar icon → Grant Screen Recording permission for screen awareness.
* Packaging and installation attempt ad-hoc signing. The app is not Developer ID
  signed or notarized; macOS may block launch or require renewed permissions
  after an update or rebuild.
* Uninstall: double-click "Uninstall Echo.command" to stop services, remove
  launchd registrations, and delete the application and data after confirmation.
* CLI (optional): the installer's log line shows the target path; run
  "<target>/bin/echo status" for process/health/memory summary.

Language
--------
Choose English or Simplified Chinese in Echo settings. Installers and the CLI
use the saved profile language. Fresh installs follow the system language;
older profiles without a saved choice keep Simplified Chinese. Set
ECHO_LANGUAGE=en or ECHO_LANGUAGE=zh-CN to override the terminal language.
Simplified Chinese installation guide: README.zh-CN.txt

More: https://github.com/Lazarus-coder/echo-assistant
