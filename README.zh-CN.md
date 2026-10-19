<div align="center">

# Echo · 跑在自己 Mac 上的私人对话窗口

> 我们不是我们记住的东西，而是我们忘记的东西。

![Local-first](https://img.shields.io/badge/本地优先-yes-2f6f57?style=flat-square)
![零依赖](https://img.shields.io/badge/npm%20依赖-0-2f6f57?style=flat-square)
![BYOK](https://img.shields.io/badge/BYOK-自带%20API%20Key-2f6f57?style=flat-square)
![macOS](https://img.shields.io/badge/macOS-Node%20%E2%89%A520-2f6f57?style=flat-square)
![状态](https://img.shields.io/badge/status-alpha-orange?style=flat-square)

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#它特别在哪">它特别在哪</a> ·
  <a href="#记忆与遗忘">记忆与遗忘</a> ·
  <a href="#搜索提供方">搜索提供方</a> ·
  <a href="#首次引导byok">首次引导</a> ·
  <a href="docs/permissions.md">权限说明</a> ·
  <a href="#未来规划">未来规划</a> ·
  <a href="docs/landscape.md">同类项目对照</a> ·
  <a href="docs/rsi-log.md">自我改进日志</a> ·
  <a href="README.md">English</a>
</p>

<p align="center"><em>你自己的模型端点（BYOK）· 会主动遗忘的分层记忆 · 知道何时该闭嘴的主动服务 ·
只在本地理解的屏幕感知。<br />零第三方依赖，全部状态是 data/ 里的明文文件。</em></p>

</div>

---

> English front page: [README.md](README.md) · 权限与常驻：[docs/permissions.md](docs/permissions.md) · 同类项目调研：[docs/landscape.md](docs/landscape.md)

<a id="它特别在哪"></a>
## 它特别在哪

借鉴了 MemGPT/Letta 的"记忆块 + 上下文编译 + 睡时改写"、Mem0 的"抽取→调和式写入"、Zep 的"实体入图检索"、screenpipe 的"本地优先上下文"。在这些之上，力气花在几件少见的事上：

1. **把遗忘做成一等公民，并且可解释**——强度 = 重要度 × 使用增益 × 时间衰减；命中强化、久不用淡出、超容量按强度淘汰；每次遗忘都写进 `memory/forgetting.md`，说清忘了什么、为什么、依据哪个数字。可保护、可复活、可手动忘掉。
2. **主动性是可测量的闭环**——Thompson 采样 bandit 选开口类型（奖励=你是否接住，6 小时未回应按 0 结算）+ 门槛自适应 + 台账 EV 排序 + 静默/预算/降速门禁；被接住率在自报告里可见。离线回放比固定策略高 60–80%。
3. **屏幕感知是"瞬时理解"而非"全部录下来"**——本地 OCR 只发文字、截图分析完即删、工作记忆有 TTL；对照"持续录制 + 可搜索历史"的另一条路：不做第二记忆库。
4. **零依赖 + 全明文可审计**——0 个 npm 包、无向量库、无数据库；打开文件就能看懂它记住了什么、忘了什么。
5. **工程化预算与韧性**——磁盘预算（超 80% 从最旧删、被引用图片永不删）、搜索熔断器、模型降级链、上下文预算 + 滚动摘要、`metrics.jsonl` 自报告。
6. **内建冻结评估器**——`tests/selftest.mjs` 在隔离沙箱里跑 60+ 条断言，标准只增严不放松；迭代过程见 [docs/rsi-log.md](docs/rsi-log.md)。

诚实的短板（无向量检索、图谱无双时态、bandit 无上下文特征、屏幕是快照非事件流）也写在 [docs/landscape.md](docs/landscape.md) 里。

<a id="快速开始"></a>
## 快速开始

**macOS 安装包（推荐，通用二进制：Apple Silicon + Intel）**：到 [Releases](https://github.com/Lazarus-coder/echo-assistant/releases) 下载 `Echo-0.1.0-alpha.2-macos.dmg`，打开后双击 **Install Echo.command**。它会把 `Echo.app` 与服务装到 `~/Library/Application Support/Echo`、注册 launchd 常驻、并询问模型端点与 Key（可跳过，网页里有向导）。卸载双击同一目录里的 `Uninstall Echo.command`。

**从源码装：**

```bash
git clone https://github.com/Lazarus-coder/echo-assistant.git && cd echo-assistant
./install.sh          # 凭据 → launchd 常驻 → 编译状态栏图标
./bin/echo status     # 进程 / 健康 / 局域网地址 / 记忆与主动服务概览
./bin/echo open       # 打开对话窗口
```

首次打开会走一遍 **BYOK 引导**（端点 → 密钥 → 模型 → 记忆档位 → 搜索链 → 权限）；也可以跳过，自己往 `data/echo.env` 里写。

要求：macOS + Node ≥ 20；状态栏图标需要 `swiftc`（Xcode Command Line Tools）。

| 命令 | 作用 |
|---|---|
| `./bin/echo up / down / restart` | 启动 / 停止 / 重启 |
| `./bin/echo logs` | 跟踪日志 |
| `./bin/echo dream` | 立刻做一次记忆巩固 + 遗忘 |
| `./bin/echo say` | 立刻判断"要不要主动说句话" |
| `./bin/echo diag` | 自报告：延迟、失败、工具成功率、存储、记忆、图谱 |
| `./bin/echo forget` | 看它忘了什么、为什么忘 |
| `./bin/echo remember <内容>` | 手动记一条事实 |
| `./bin/echo auth on\|off` | 开关口令验证（默认关） |
| `./bin/echo search <词>` | 测试搜索链路与引擎健康 |
| `./bin/echo selftest [--live]` | 跑冻结评估器（沙箱隔离；`--live` 会真调模型） |

手机访问：同一 WiFi 下打开 `http://<Mac 的局域网 IP>:8787`（默认免登录），Safari"添加到主屏幕"即可像 App 一样用。公共网络下建议 `./bin/echo auth on`。

<a id="记忆与遗忘"></a>
## 记忆与遗忘

| 层 | 存什么 | 生命周期 | 用途 |
|---|---|---|---|
| **L0 工作记忆** | 最近 ~90 分钟的屏幕活动摘要 | 自动过期、容量上限 | 知道"你此刻在做什么" |
| **L1 即时事实** | 从对话与屏幕抽取的稳定事实 | 强度衰减，久不用淡出 | 检索召回、长期记忆的原料 |
| **L2 核心记忆** | `data/memory/MEMORY.md` | 每次 Dream 重写 | 每轮注入，可手改 |
| **L3 归档与图谱** | Dream 快照、遗忘日志、实体图 | 保留可回溯 | 审计、实体召回 |

**Dream**（空闲时自动 + 手动）：重写核心记忆、调和事实、明确忘掉过期项并写理由、复活误淡项、产出跟进事项与主动话题、刷新实体图、留审计快照。

**记忆档位**（引导时选，之后可改）：`off` 完全不记 / `light` 只记事实 / `standard` 事实 + Dream + 主动 / `deep` 再加屏幕感知。

<a id="搜索提供方"></a>
## 搜索提供方（可插拔）

搜索是一条你自己配的链，不是写死的引擎。勾选的按顺序尝试，前面的失败（限流、缺 key）自动交给下一个。需要密钥的提供方从 `data/echo.env` 的对应环境变量读取——密钥不进 `config.json`、不进 git。

| 提供方 | 需要 | 说明 |
|---|---|---|
| `none` | — | 明确不联网 |
| `scrape` | — | 零配置抓取（中文引擎）；最快，可能被第三方限流（有熔断冷却） |
| `gateway` | — | 复用你模型端点的托管搜索（Responses API `web_search`，3–8s，带 sources） |
| `tavily` | `TAVILY_API_KEY` | 面向 LLM 的搜索 API，返回正文摘要 |
| `brave` | `BRAVE_API_KEY` | 独立索引，隐私友好 |
| `bocha` | `BOCHA_API_KEY` | 中文结果质量好 |
| `searxng` | `SEARXNG_URL` | 自建或公共实例，聚合多引擎 |
| `custom` | — | 任何返回 `{results:[{title,url,snippet}]}` 的接口；方法/请求头/请求体模板可配 |

默认链是 `scrape → gateway`（都免 key）；引导页与「设置 → 联网搜索」编辑的是同一条链。

<a id="首次引导byok"></a>
## 首次引导（BYOK）

六步、每步一个决定：**端点**（预设：OpenAI / 阿里云百炼 / DeepSeek / Moonshot / OpenRouter / Ollama / 自定义，可"测试并拉取模型"）→ **模型**（默认 / 后台杂活 / 出图，出图留空即关闭该工具）→ **记忆档位** → **搜索链** → **权限**（常驻状态、swiftc、监听地址、可选口令、屏幕录制测试）→ **完成**。

保存时：密钥写进 `data/echo.env`（600），其余写进 `config.json`。随时可在「设置 → 引导与权限」重跑。

## 权限与常驻

完整说明（屏幕录制、通知、launchd、网络暴露、磁盘文件）：[docs/permissions.md](docs/permissions.md)。要点：**默认全部关**（不要口令、不采集屏幕、不发通知）；`./install.sh` 注册两个 launchd 任务（`com.echo.chat` + `com.echo.menubar`）实现登录自启、崩溃拉起；屏幕感知需要一次系统授权，入口在状态栏图标菜单里。

## 数据、磁盘与安全

`data/` 下全是明文：`echo.env`（密钥，600）、会话、记忆（`MEMORY.md` / `observations.jsonl` / `working.jsonl` / `graph.json` / `forgetting.md`）、图片、`metrics.jsonl`、日志。磁盘预算自动执行（截图 200MB/3 天、生成图 300MB/60 天，超 80% 从最旧删且保护被引用的图）；设置里有"全部忘掉"。

安全：免登录默认开启但写操作要求自定义请求头（跨站网页伪造不了）；`web_fetch` 有 SSRF 防护；模型输出经白名单转义；管理接口只接受本机回环请求。

## 仓库结构

```
server.mjs          路由 / SSE / 调度 / 认证 / 引导
lib/                chat · context · memory(分层/遗忘) · graph · screen · dream
                    proactive · agency(bandit/台账) · providers · search · media
                    mcp · storage · metrics · tools
public/             单页前端（零构建、零依赖）
menubar/            Swift 状态栏 App 源码
tests/selftest.mjs  冻结评估器（隔离沙箱）
bin/echo CLI        install.sh 安装与 launchd 注册
docs/               landscape(同类对照) · rsi-log · permissions · release notes
```

<a id="未来规划"></a>
## 未来规划

Echo 还在 alpha。方向是：**一个真正能替你动手的个人 agent，并且沿用它在记忆上的那套纪律——有预算、可解释、可回滚。**

### Computer use（计划中）

地基其实已经在了：状态栏 App 负责截屏与本地 OCR，对话循环本来就能调工具，每个动作也都落在审计轨迹里。Computer use 要做的是把它从"看懂"推进到"动手"——新增一个 `computer_use` 工具，可以点击、输入、滚动、切换应用。

它会带着这些约束上线（草案；必须显式开启，绝不默认打开）：

- **模型提议、App 执行**：真正的操作放在状态栏 App 里（Accessibility API + `CGEvent`），需要单独授权；模型拿不到你输入设备的直接句柄。
- **破坏性操作逐次确认**；应用与动作类型都有允许清单；确认粒度可选"每次问 / 同一应用只问一次 / 全自动"。
- **每个动作都留审计**：做了什么、在哪、哪个应用、前后快照哈希——格式和 `forgetting.md` 一样，可读、可删。
- **急停与硬预算**：状态栏一键停止执行；每分钟/每天动作数上限，沿用搜索那套熔断思路。
- **空转（dry-run）模式**：先把"我打算怎么做"讲一遍，你看过再给写入权限。
- **也可以直接插一个 computer-use MCP 服务**：MCP 支持已经有了，确认、审计、预算这三条同样会施加在它暴露的任何工具上。

### 也在考虑

- **可选的 embedding 检索**（现在是词法 BM25 + 实体图，零依赖）：做成"想开就开"的索引，而不是新增依赖。
- **实体图的双时态**：让"以前成立、现在不成立"的关系能显式失效，而不只靠衰减。
- **语音进出**：当你的端点提供 OpenAI 兼容的 `/audio`（ASR + TTS）时接上，权限口径与屏幕感知一致。

### 明确不做

多用户托管、记忆云端同步、遥测、任何需要注册账号的东西。Echo 是一个人、一台机器、一堆你可以随手删掉的明文文件。

## 许可

仓库暂未放许可证文件，默认保留所有权利。想复用可以开 issue，我们挑一个（通常 MIT 或 Apache-2.0）。