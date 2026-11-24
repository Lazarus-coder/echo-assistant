Echo — 在自己的 Mac 上运行的私人助手

安装
----
1. 双击 “Install Echo.command”。如果系统拦截，请右键单击并选择“打开”。
2. 输入自己的模型接口地址和 API 密钥，也可以直接回车，之后在网页里设置。
3. 安装完成后，浏览器会打开 http://127.0.0.1:8787。

文件位置
--------
程序、菜单栏应用 Echo.app、日志及数据位于 ~/Library/Application Support/Echo/。
data/echo.env 保存密钥，仅当前用户可读写。对话、记忆、图片和日志也以普通文件保存。
服务和菜单栏图标通过 ~/Library/LaunchAgents/ 下的 com.echo.chat.plist 和
com.echo.menubar.plist 注册，登录时启动，崩溃后自动重启。

系统要求
--------
macOS 13 或更高版本，Node.js 22.13 或更高版本。可通过 brew install node 安装，
或前往 https://nodejs.org 下载长期支持版。

使用
----
新配置仅允许本机连接。手动启用局域网访问后，用以下命令查看实际监听地址：
  "$HOME/Library/Application Support/Echo/bin/echo" status
屏幕感知默认关闭。在菜单栏图标中选择授予屏幕录制权限的选项即可启用。
安装脚本尝试对应用进行本机临时签名。当前版本未使用开发者 ID 签名或公证，
macOS 可能会阻止启动，更新后也可能需要重新授予权限。

语言
----
可在 Echo 的设置中选择英语或简体中文。安装器和命令行优先使用已保存的语言，
全新安装跟随系统，未曾选择语言的旧资料继续使用简体中文。可用 ECHO_LANGUAGE=zh-CN 或 ECHO_LANGUAGE=en 指定终端语言。
英文安装说明见 README.en.txt。

卸载
----
双击 “Uninstall Echo.command”。确认后会停止服务，移除登录任务并删除程序和所有数据。
只删除数据目录不会移除登录任务。

项目主页：https://github.com/Lazarus-coder/echo-assistant
