# Getting started

[English](#english) · [中文](#中文) · [Product overview](../README.md)

## English

### Before you install

Echo is an alpha app for macOS 13 or newer, with packages for Apple Silicon and Intel. Install **Node.js 22.13 or newer** first; the app's runtime dependencies are bundled in the macOS package, but Node itself is not. Have a compatible model endpoint and API key ready, or enter them later in the setup wizard.

Download from the [v0.1.0-alpha.6 release](https://github.com/Lazarus-coder/echo-assistant/releases/tag/v0.1.0-alpha.6) and read its notes. This is a prerelease. The current repository may include changes that are not in that package.

### Install and connect

1. Open the DMG or unpack the ZIP, then run **Install Echo.command**.
2. Follow the installer and open the chat window. Enter your endpoint, API key, default model, and utility model in the wizard. Image features need a model that supports them.
3. Choose a memory level. Background research, workspace tools, screen awareness, and companion mode have their own controls. Selecting the deep memory profile enables screen awareness, which also needs macOS Screen Recording permission.

The installer places Echo and its data under `~/Library/Application Support/Echo` and registers the service and menu-bar app to start at login. The app uses ad-hoc signing rather than an Apple Developer ID signature; do not expect a notarized distribution. macOS may require you to approve opening it. Use the downloaded release's installation instructions and verify its origin before opening it.

### Choose your access and data settings

- **Network:** chat listens on the local network by default and does not require a password. In Settings, enable password protection and set a password before using a shared network. For local access only, configure `bind: "local"` and restart Echo; source launches can use `ECHO_BIND=local`. See [the detailed controls](permissions.md#5-network-exposure).
- **Model and search:** content used in answers goes to the endpoint you choose; search queries go to the configured search provider. Review their data terms and usage charges. Local record storage does not mean every request stays on your device.
- **Research:** enable it in **主动服务**, choose sources per goal, and review the results. Research and notification controls are independent. Checks pause when the Mac sleeps or Echo stops.
- **Tools:** workspace file access must be enabled. Shell and MCP calls need approval and can act with the privileges of your account or the configured server. Stop does not undo a completed action.

The app does not automatically import your browser, email, or calendar. Screen context is optional; on-device OCR is the default, while image mode can send screenshots to your chosen model.

### Upgrade or remove

Back up the installation's `data/` directory before upgrading. Conversation exports do not include separate command outputs and file snapshots in `data/runs/`; include that directory when those records matter. Alpha interfaces and data formats can change.

To remove the installation, first back up any data you want to keep, then use **Uninstall Echo.command** from the release package. Confirming uninstallation deletes the app and its data, including memories and conversations; cancelling leaves the installation in place. Deleting local records does not retract data already sent to a provider. For source installation and service commands, use the [developer guide](development.md).

## 中文

### 安装前

Echo 目前是 alpha 产品，面向 macOS 13 或更高版本，安装包支持 Apple Silicon 与 Intel。请先安装 **Node.js 22.13 或更高版本**；macOS 包内附带项目运行依赖，但不附带 Node 本身。模型端点与 API Key 可提前准备，也可在安装后的引导中填写。

从 [v0.1.0-alpha.6 发布页](https://github.com/Lazarus-coder/echo-assistant/releases/tag/v0.1.0-alpha.6) 下载并阅读该版本说明。这是预发布版本；当前仓库可能包含安装包尚未收录的修改。

### 安装与连接

1. 打开 DMG 或解压 ZIP，运行 **Install Echo.command**。
2. 按安装器提示打开对话窗口，在引导中填写端点、API Key、默认模型和后台模型。图片能力需要相应模型支持。
3. 选择记忆档位。后台研究、工作区工具、屏幕感知和伴随模式分别控制；选择深度记忆档会开启屏幕感知，并需要 macOS 屏幕录制授权。

程序与数据默认放在 `~/Library/Application Support/Echo`，服务及状态栏应用会在登录时启动。当前应用采用 ad-hoc 签名，并非 Apple Developer ID 签名；不要将它视为已公证的发行包。macOS 可能要求你确认打开，请按该发行包说明操作并核对下载来源。

### 选择访问与数据设置

- **网络：**默认向局域网开放对话且不要求口令。在共享网络使用前，请在设置中启用口令保护并设置口令；若只需本机访问，将 `bind` 配置为 `"local"` 并重启 Echo。源码启动也可使用 `ECHO_BIND=local`。详细操作见[网络访问说明](permissions.md#5-network-exposure)。
- **模型与搜索：**回答所需内容会发送到你选择的模型端点，搜索词会发送到所配置的搜索提供方。请了解提供方的数据条款与计费；记录存在本机不代表所有请求都留在本机。
- **研究：**在 **主动服务** 开启，为每个目标选择来源，并复核结果。研究与通知分别控制；Mac 睡眠或 Echo 停止时暂停检查。
- **工具：**工作区文件访问需先开启。Shell 与 MCP 调用需要确认，并按本机账号或所配置服务的权限执行；停止不能撤销已完成的动作。

应用不会自动导入浏览器、邮箱或日历。屏幕上下文按需开启，默认在本机进行 OCR；图片模式可能把截图发给所选模型。

### 升级与卸载

升级前请备份安装目录中的 `data/`。对话导出不包含 `data/runs/` 中单独保存的命令输出与文件快照，需要保留时应一并备份。Alpha 阶段的界面与数据格式可能调整。

卸载前请先备份想保留的数据，再使用发行包内的 **Uninstall Echo.command**。确认卸载会删除程序及其数据，包括记忆和对话；取消则保留现有安装。删除本机记录不会撤回已经发送给提供方的数据。源码安装与服务命令见[开发指南](development.md)。
