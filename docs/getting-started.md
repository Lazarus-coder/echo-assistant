# Getting started

[English](#english) · [中文](#中文) · [Product overview](../README.md)

## English

### Before you install

Echo is an alpha app for macOS 13 or newer, with packages for Apple Silicon and Intel. Install **Node.js 22.13 or newer** first; the app's runtime dependencies are bundled in the macOS package, but Node itself is not. Have a compatible model endpoint and API key ready, or enter them later in the setup wizard.

Download from the [v0.1.0-alpha.6 release](https://github.com/Lazarus-coder/echo-assistant/releases/tag/v0.1.0-alpha.6) and read its notes. This is a prerelease. The current repository may include changes that are not in that package.

### Install and connect

1. Open the DMG or unpack the ZIP, then run **Install Echo.command**.
2. Follow the installer and open the chat window. Enter your endpoint, API key, default model, and utility model in the wizard. Image features need a model that supports them.

   In the current source, enter a known chat model ID to finish setup without a provider request. **测试连接并拉取模型** optionally reads the provider’s model catalog. A chat reply verifies generation with the selected model. Memory extraction and research use your utility model, falling back to your default model. Echo uses your default model to word a proactive chat reminder.

   If your installation uses a named key variable, set its name in `config.json` and its value in the environment or setup wizard. Switching a model endpoint in setup or through the settings API requires the key for the new destination.
3. Choose a memory level. Background research, workspace tools, screen awareness, and companion mode have their own controls. Selecting the deep memory profile enables screen awareness, which also needs macOS Screen Recording permission.

The installer places Echo and its data under `~/Library/Application Support/Echo` and registers the service and menu-bar app to start at login. The app uses ad-hoc signing rather than an Apple Developer ID signature; do not expect a notarized distribution. macOS may require you to approve opening it. Use the downloaded release's installation instructions and verify its origin before opening it.

### Choose your access and data settings

- **Network access.** Fresh alpha.8 profiles use loopback. For phone access, set a password and enable authentication, then set `"bind": "all"` in `config.json` and restart. The public alpha.6 installer defaults to LAN access without a password. [Network controls](permissions.md#5-network-exposure)
- **Model and search:** content used in answers goes to the endpoint you choose; search queries go to the configured search provider. Review their data terms and usage charges. Local record storage does not mean every request stays on your device.
- **Research:** enable it in **主动服务**, choose sources per goal, and review the results. Research and notification controls are independent. Checks pause when the Mac sleeps or Echo stops.
- **Follow-ups.** In the public alpha.6 package, open **主动服务** to create a goal, set its date and choose its sources. With the current source, try “Track my proposal until Friday” in chat. Check the saved date, then ask “Show me the proposal draft.” You can read the draft and its sources with proactive messages off. If the draft asks a question, open it in **主动服务**, enter your answer and choose **回答并继续准备**. Your answer stays beside the original question. The goal shows when the next draft is ready.
- **Recall in a reply.** In the current source, expand **为这条回复检索的记忆** under a chat reply to see the facts retrieved for that turn. The list shows facts that are still active and match the original text. Choose **管理记忆** to open your memory settings.
- **Tools:** workspace file access must be enabled. Shell and MCP calls need approval and can act with the privileges of your account or the configured server. Stop does not undo a completed action.

The app does not automatically import your browser, email, or calendar. Screen context is optional; on-device OCR is the default, while image mode can send screenshots to your chosen model.

For a goal saved by an earlier checkout, open its editor and check **后续何时准备**. Choose **临近截止日期** for a date, or **综合跟进来源变化和截止进展** for a date and sources. Existing goals keep their saved choice because some users explicitly selected manual preparation.

### Confirm setup or find help

Open the chat window from the Echo menu-bar icon. Save your provider and model in the setup wizard, then send a short message. An open window confirms that the interface is available; a successful reply also checks your configured model connection.

If the window does not open or replies fail, open Terminal in `~/Library/Application Support/Echo` and run `./bin/echo status` for service information or `./bin/echo logs` to follow the logs. Stop following logs with Ctrl+C. When [reporting an issue](https://github.com/Lazarus-coder/echo-assistant/issues), include the Echo version, macOS version, steps to reproduce, and a relevant error with credentials and personal content removed.

If alpha.6 reports a healthy service but opening chat returns HTTP 500 under the default installation path, the space in `Application Support` can prevent it from finding the page. The current source fixes path handling. Check for a legacy profile before switching builds.

### Upgrade or remove

**Upgrading an installation under Application Support.** Some older builds wrote the active profile to a second folder whose name contains the literal characters `%20`. If the service log reports a legacy profile, stop Echo and back up both `~/Library/Application Support/Echo` and `~/Library/Application%20Support/Echo`. Restore the intended `config.json` and `data/` together under the real installation path, checking both copies of `data/echo.env` for the credentials you intend to keep. Keep the other profile as a separately named backup, then restart. Echo checks for this ambiguity before serving chat. Source launches can also select an existing profile with explicit `ECHO_CONFIG` and `ECHO_DATA_DIR` paths.

Back up the installation's `data/` directory before upgrading. Conversation exports do not include separate command outputs and file snapshots in `data/runs/`; include that directory when those records matter. Alpha interfaces and data formats can change.

To remove the installation, first back up any data you want to keep, then use **Uninstall Echo.command** from the release package. Confirming uninstallation deletes the app and its data, including memories and conversations; cancelling leaves the installation in place. Deleting local records does not retract data already sent to a provider. For source installation and service commands, use the [developer guide](development.md).

## 中文

### 安装前

Echo 目前是 alpha 产品，面向 macOS 13 或更高版本，安装包支持 Apple Silicon 与 Intel。请先安装 **Node.js 22.13 或更高版本**；macOS 包内附带项目运行依赖，但不附带 Node 本身。模型端点与 API Key 可提前准备，也可在安装后的引导中填写。

从 [v0.1.0-alpha.6 发布页](https://github.com/Lazarus-coder/echo-assistant/releases/tag/v0.1.0-alpha.6) 下载并阅读该版本说明。这是预发布版本；当前仓库可能包含安装包尚未收录的修改。

### 安装与连接

1. 打开 DMG 或解压 ZIP，运行 **Install Echo.command**。
2. 按安装器提示打开对话窗口，在引导中填写端点、API Key、默认模型和后台模型。图片能力需要相应模型支持。

   当前源码支持直接输入已知的聊天模型 ID，保存时无需请求服务商。「测试连接并拉取模型」用于读取模型列表。发送一条消息并收到回复即可确认所选模型支持对话。记忆提取和研究使用后台模型，留空时使用默认模型。主动聊天提醒由默认模型组织措辞。
3. 选择记忆档位。后台研究、工作区工具、屏幕感知和伴随模式分别控制；选择深度记忆档会开启屏幕感知，并需要 macOS 屏幕录制授权。

程序与数据默认放在 `~/Library/Application Support/Echo`，服务及状态栏应用会在登录时启动。当前应用采用 ad-hoc 签名，并非 Apple Developer ID 签名；不要将它视为已公证的发行包。macOS 可能要求你确认打开，请按该发行包说明操作并核对下载来源。

### 选择访问与数据设置

- **网络访问。** alpha.8 新资料默认仅在本机监听。手机访问可先设置并启用口令，再配置 `"bind": "all"` 并重启。公开的 alpha.6 安装包默认向局域网开放且免登录。[网络访问说明](permissions.md#5-network-exposure)
- **模型与搜索：**回答所需内容会发送到你选择的模型端点，搜索词会发送到所配置的搜索提供方。请了解提供方的数据条款与计费；记录存在本机不代表所有请求都留在本机。
- **研究：**在 **主动服务** 开启，为每个目标选择来源，并复核结果。研究与通知分别控制；Mac 睡眠或 Echo 停止时暂停检查。
- **跟进。** 公开的 alpha.6 安装包可在「主动服务」面板中创建目标、设定日期并选择来源。使用当前源码时，也可以在对话里说“帮我跟进提案，周五截止”。核对日期后，再问“给我看看提案草稿”，就能读到当前草稿及其来源。关闭主动消息也能查。如果草稿里有待确认问题，在「主动服务」打开它，填好回答并点「回答并继续准备」。回答会保留在原问题下，回到目标即可查看下一版的进度。
- **核对回复召回的记忆。** 使用当前源码时，在回复下展开「为这条回复检索的记忆」，可以看到当时召回且现在仍有效、内容相符的事实。点「管理记忆」可进入记忆设置。
- **工具：**工作区文件访问需先开启。Shell 与 MCP 调用需要确认，并按本机账号或所配置服务的权限执行；停止不能撤销已完成的动作。

应用不会自动导入浏览器、邮箱或日历。屏幕上下文按需开启，默认在本机进行 OCR；图片模式可能把截图发给所选模型。

已有目标会保留原先选择的跟进方式。在旧版源码中创建的目标如果只有日期却一直没有跟进，可以在编辑器的「后续何时准备」中选择「临近截止日期」；同时盯日期和来源的目标请选择「综合跟进来源变化和截止进展」。

### 确认安装成功与排错

从 Echo 状态栏图标打开对话窗口，在设置引导中保存模型端点和模型，再发送一条简短消息。窗口能打开说明界面已可访问；收到正常回复也验证了你配置的模型连接。

若窗口无法打开或回复失败，在终端进入 `~/Library/Application Support/Echo`，运行 `./bin/echo status` 查看服务信息，或用 `./bin/echo logs` 跟踪日志；按 Ctrl+C 停止查看日志。[反馈问题](https://github.com/Lazarus-coder/echo-assistant/issues)时，请附 Echo 版本、macOS 版本、复现步骤，以及去除凭据和个人内容后的相关错误信息。

如果 alpha.6 显示服务健康，但在默认目录安装后打开聊天返回 HTTP 500，原因可能是安装路径中 `Application Support` 的空格。当前源码已修复路径解析。换用新构建前请先检查是否有旧版资料。

### 升级与卸载

**从旧版 Application Support 安装升级。** 部分旧版曾将资料写到名称中含有字面字符 `%20` 的目录。服务日志提示旧版资料时，先停止 Echo，备份 `~/Library/Application Support/Echo` 和 `~/Library/Application%20Support/Echo`。核对两处的 `data/echo.env` 后，将要使用的 `config.json` 和整套 `data/` 一起恢复到实际安装目录。把另一份资料另存为改名的备份，再启动服务。源码启动也可用 `ECHO_CONFIG` 和 `ECHO_DATA_DIR` 显式指定一套已有资料。

升级前请备份安装目录中的 `data/`。对话导出不包含 `data/runs/` 中单独保存的命令输出与文件快照，需要保留时应一并备份。Alpha 阶段的界面与数据格式可能调整。

卸载前请先备份想保留的数据，再使用发行包内的 **Uninstall Echo.command**。确认卸载会删除程序及其数据，包括记忆和对话；取消则保留现有安装。删除本机记录不会撤回已经发送给提供方的数据。源码安装与服务命令见[开发指南](development.md)。
