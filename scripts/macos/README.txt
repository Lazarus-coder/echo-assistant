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
* Screen awareness (off by default) needs Screen Recording permission:
  menu-bar icon → the "⚠️ 屏幕感知需要「屏幕录制」权限" item.
* Packaging and installation attempt ad-hoc signing. The app is not Developer ID
  signed or notarized; macOS may block launch or require renewed permissions
  after an update or rebuild.
* Uninstall: double-click "Uninstall Echo.command" to stop services, remove
  launchd registrations, and delete the application and data after confirmation.
* CLI (optional): the installer's log line shows the target path; run
  "<target>/bin/echo status" for process/health/memory summary.

More: https://github.com/Lazarus-coder/echo-assistant
中文速览
--------
1. 双击 "Install Echo.command"（若被系统拦下：右键 → 打开，或先执行 xattr -dr com.apple.quarantine 该文件夹）
2. 它会问模型端点与 API Key（BYOK）；直接回车可跳过，之后在网页里走六步引导
3. 结束后浏览器自动打开 http://127.0.0.1:8787

安装位置：程序与数据都在 ~/Library/Application Support/Echo/，菜单栏应用是其中的 Echo.app；数据是明文文件。
常驻：两个 launchd 任务（登录自启、崩溃自动拉起）+ 状态栏图标。
签名：打包和安装脚本尝试 ad-hoc 签名，当前没有 Developer ID 签名或公证；更新或重编后可能需要重新授权。
屏幕感知默认关闭；要用需在状态栏图标菜单里授权屏幕录制。
卸载：双击 "Uninstall Echo.command"，确认后停止服务、移除 launchd 注册并删除程序与数据；仅删除目录不会移除常驻注册。
