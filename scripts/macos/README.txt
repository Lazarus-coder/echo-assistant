Echo — a private chat window that runs on your Mac
==================================================

Install
-------
1. Double-click  "Install Echo.command"
   (if macOS refuses to open it, right-click → Open, or run:
    xattr -dr com.apple.quarantine "<this folder>")
2. It will ask for your model API endpoint + key (BYOK). Press Enter to skip —
   the app has a six-step setup wizard in the browser.
3. When it finishes, your browser opens http://127.0.0.1:8787

What gets installed
-------------------
  ~/Library/Application Support/Echo      the app, its data, its logs
  ~/Library/LaunchAgents/com.echo.chat.plist      service (login start, crash restart)
  ~/Library/LaunchAgents/com.echo.menubar.plist   menu-bar icon
  <this folder>/Echo.app                  the menu-bar app (stays where you copied it)

Everything Echo knows lives under "Application Support/Echo/data" as plain
files: echo.env (keys, mode 600), conversations, memory, images, logs.
Delete that folder and it is gone.

Requirements
------------
  macOS 13+ and Node 22.13 or newer (brew install node, or nodejs.org).

Notes
-----
* Screen awareness (off by default) needs Screen Recording permission:
  menu-bar icon → the "⚠️ 屏幕感知需要「屏幕录制」权限" item.
* The app is not code-signed. macOS therefore asks once before it can run;
  right-click → Open, or remove the quarantine flag yourself.
* Uninstall: double-click "Uninstall Echo.command" (asks before deleting data).
* CLI (optional): the installer's log line shows the target path; run
  "<target>/bin/echo status" for process/health/memory summary.

More: https://github.com/Lazarus-coder/echo-assistant
中文速览
--------
1. 双击 "Install Echo.command"（若被系统拦下：右键 → 打开，或先执行 xattr -dr com.apple.quarantine 该文件夹）
2. 它会问模型端点与 API Key（BYOK）；直接回车可跳过，之后在网页里走六步引导
3. 结束后浏览器自动打开 http://127.0.0.1:8787

安装位置：程序与数据都在 ~/Library/Application Support/Echo/，数据全是明文文件；删掉这个目录即卸载干净。
常驻：两个 launchd 任务（登录自启、崩溃自动拉起）+ 状态栏图标。
屏幕感知默认关闭；要用需在状态栏图标菜单里授权屏幕录制。
卸载：双击 "Uninstall Echo.command"（删数据前会再问一次）。
