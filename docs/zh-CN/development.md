# 开发与源码安装

[English](../development.md) · [产品介绍](../../README.zh-CN.md) · [权限与数据](permissions.md)

## 从源码启动

需要 Node.js 22.13 以上版本与 npm。菜单栏、屏幕采集和登录启动需要 macOS。编译菜单栏程序还需要 Xcode 命令行工具中的 `swiftc`。

```sh
git clone https://github.com/Lazarus-coder/echo-assistant.git
cd echo-assistant
npm ci --omit=dev --ignore-scripts
ECHO_BIND=local ECHO_LANGUAGE=zh-CN npm start
```

在浏览器打开终端显示的本机地址，通过首次设置填写自己的模型端点、密钥和模型编号。已有资料可以在「设置 → 界面语言」中更改语言。用 Ctrl+C 停止前台服务。

运行 `./install.sh` 可注册登录启动服务与菜单栏程序。源码安装与安装包共用 `com.echo.chat` 和 `com.echo.menubar` 两个服务名称，重新安装会影响已有实例。升级前先备份资料目录，重新编译的程序可能需要重新授权屏幕录制。

## 配置与日常命令

| 设置 | 用途 |
|---|---|
| `ECHO_DATA_DIR`、`ECHO_CONFIG` | 分别指定运行资料目录与配置文件。默认使用当前源码目录中的 `data/` 和 `config.json`。 |
| `ECHO_BIND`、`ECHO_PORT` | 指定监听范围与端口。`local` 仅监听本机，`all` 开放局域网。设置密码并启用认证后重启以应用监听范围。 |
| `ECHO_LANGUAGE` | 用 `en` 或 `zh-CN` 指定本次终端显示语言，也可指定新资料的初始语言。 |
| `ECHO_LOG_LEVEL` | 可选 `debug`、`info`、`warn` 或 `error`。 |

`./bin/echo status` 查看服务状态，`open` 打开聊天，`logs` 查看日志。`up`、`down`、`restart` 管理常驻服务。`diag` 查看耗时、失败、工具与存储统计。`dream` 会整理记忆，`say` 会执行主动提醒判断，两者都可能调用模型。`forget` 显示遗忘记录。`auth on` 与 `passwd` 用于启用和设置密码。

密钥存入资料目录下的 `echo.env`，文件权限为 600；启动时已有的环境变量优先。备份时应带上整个资料目录，尤其是 `runs/` 中的命令输出与编辑快照。仅导出对话无法一并保留它们。

## 测试与打包

- `npm run test:regressions` 运行完整回归链。可用 `npm run test:harness`、`npm run test:relationships` 或 `npm run test:proactive` 单独检查工作区、交流偏好或主动提醒。
- `npm run selftest` 在临时资料中离线验证，并写入未跟踪的 `tests/last-report.json`。`npm run selftest:live` 会使用当前资料的凭据调用外部服务。
- 手工启动测试服务时，显式设置 `ECHO_CONFIG` 与 `ECHO_DATA_DIR` 指向临时位置，避免维护任务影响日常资料。
- `npm run package` 在干净工作树中从当前提交制作源码包，并在临时目录安装依赖、运行离线检查。`bash scripts/macos-package.sh` 构建 macOS 安装包。

## 本地预览产品网站

在项目根目录运行以下命令，再打开 [中文网站](http://127.0.0.1:4173/)。Ctrl+C 停止预览。

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory site
```

预览只提供 `site/` 中的静态文件，不读取聊天资料，也不启动 Echo 服务。
