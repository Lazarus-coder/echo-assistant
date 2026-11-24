# Echo 0.1.0-alpha.10

[English](../release-notes-0.1.0-alpha.10.md) · [开始使用](getting-started.md)

在登录、首次设置或「设置 → 界面语言」中选择英语或简体中文。聊天、迷你对话、菜单栏、模型指令、工具说明与新的主动建议都使用所选语言，也可以在对话中要求使用另一种语言作答。

切换语言在本机完成，不会请求模型。已配置的端点和密钥、提醒偏好、历史消息与来源原文都会保留。内置会话名称随语言切换，本版本中手动设置的标题保留原文。

新资料优先采用系统语言，不支持的系统语言默认使用英语。旧资料默认保留简体中文。可用 `ECHO_LANGUAGE=zh-CN ./bin/echo status` 指定单次终端命令的语言。

此预发布版支持 macOS 13 或更高版本，兼容 Apple Silicon 与 Intel。请先安装 Node.js 22.13 或更高版本。使用安装包在独立目录试装后，全部 98 项离线检查通过。[下载 macOS 安装包](https://github.com/Lazarus-coder/echo-assistant/releases/download/v0.1.0-alpha.10/Echo-0.1.0-alpha.10-macos.dmg) · [ZIP、源码与校验文件](https://github.com/Lazarus-coder/echo-assistant/releases/tag/v0.1.0-alpha.10)
