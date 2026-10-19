<div align="center">

# Echo · 跑在自己 Mac 上的私人 agent

> 我们不是我们记住的东西，而是我们忘记的东西。

![BYOK](https://img.shields.io/badge/BYOK-任意端点%20·%20自带%20Key-2f6f57?style=flat-square)
![个人 agent](https://img.shields.io/badge/个人%20agent-本地优先-2f6f57?style=flat-square)
![主动能动性](https://img.shields.io/badge/主动能动性-可测量的闭环-2f6f57?style=flat-square)
![零依赖](https://img.shields.io/badge/npm%20依赖-0-2f6f57?style=flat-square)
![状态](https://img.shields.io/badge/status-alpha-orange?style=flat-square)

<p align="center">
  <a href="#定位">定位</a> ·
  <a href="#byok">BYOK</a> ·
  <a href="#主动能动性">主动能动性</a> ·
  <a href="#记忆与遗忘">记忆与遗忘</a> ·
  <a href="#安装">安装</a> ·
  <a href="docs/permissions.md">权限说明</a> ·
  <a href="#未来规划">未来规划</a> ·
  <a href="docs/landscape.md">同类对照</a> ·
  <a href="README.md">English</a>
</p>

<p align="center"><em>一个住在你 Mac 上的私人 agent。<br />
<b>模型你自己带</b>——任意 OpenAI 兼容端点、你自己的 Key、数据全在本机明文文件里。<br />
<b>它有能动性</b>——自己决定记住什么、忘记什么、什么时候开口、什么时候闭嘴。</em></p>

</div>

---

<a id="定位"></a>
## 定位

大多数助手是"你问我答"。Echo 押的是相反的一注：一个 **BYOK 的私人 agent，并具备主动能动性（proactive agency）**——常驻在你机器上，维护一份"允许被遗忘"的记忆，在有值得说的话时主动找你。

| | |
|---|---|
| **BYOK，不是"我们的云"** | 任意 OpenAI 兼容端点（OpenAI · 阿里云百炼 · DeepSeek · Moonshot · OpenRouter · Ollama · 你自己的网关）。密钥写在 `data/echo.env`（600）——不进 config、不进 git、不进日志。换供应商不用改程序。 |
| **能动性，不是自动补全** | 你睡觉时它在巩固记忆、**有意识地遗忘**、给自己的跟进台账排序，并决定要不要打扰你——判断依据来自你真实回复构成的奖励信号。 |
| **本地优先，不是托管服务** | 0 个 npm 依赖、无向量库、无账号。它知道的一切都是 `data/` 下的明文文件：可读、可备份、可删除。 |
| **一人一机** | 设计上就是单用户：一个状态栏图标、一个对话窗口、一个给手机的局域网地址。没有多租户那一套。 |

它**不是**：套了好看皮肤的聊天壳、云端记忆服务、多 agent 框架。想要一个带团队功能的托管助手，Echo 是故意不合适的工具。

<a id="byok"></a>
## BYOK —— 什么都可以自带

### 模型

指向任意 OpenAI 兼容端点即可；首次引导会给出常用预设，然后**测试连通并拉取你账号下的模型列表**（`GET /models`）。你选默认模型、后台杂活模型（标题、记忆抽取、Dream），以及可选的出图模型（留空则该工具直接不存在）。

能力跟着你的端点走，不靠承诺：

| 能力 | 需要 | Echo 的表现 |
|---|---|---|
| 对话 / 流式 / 工具调用 | 基础 API | 核心循环 |
| 视觉理解（粘贴/拖拽/上传） | 支持视觉的模型 | 上传前客户端压边 |
| 出图 | 出图模型 id | `image_gen` 工具 + 界面"画图"；结果**落盘本地**（远端链接会过期） |
| 托管联网搜索 | 实现 Responses API 的端点 | `gateway` 搜索提供方，无需额外订阅 |
| 语音 / 视频 | 暴露 `/audio`、视频接口的端点 | 有就接上，没有就当作已知缺失 |

端点若不具备某能力，对应工具会**直接不出现**，而不是调用时才报错；主模型不可用时走**降级链**，而不是把你的这轮对话丢掉。

### 搜索（可插拔，用你的 Key 或干脆不用）

搜索是一条**你自己配的链**，按顺序尝试；前面的失败（限流、缺 Key）自动交给下一个。密钥从 `data/echo.env` 的环境变量读取。

| 提供方 | 需要 | 说明 |
|---|---|---|
| `none` | — | 明确不联网 |
| `scrape` | — | 零配置抓取；最快，可能被第三方限流（有熔断冷却） |
| `gateway` | — | 你端点的托管搜索（Responses `web_search`，3–8s，带 sources） |
| `tavily` · `brave` · `bocha` | API Key | 面向 LLM / 独立索引 / 中文结果好 |
| `searxng` | 实例地址 | 你自己的聚合实例 |
| `custom` | — | 任何返回 `{results:[{title,url,snippet}]}` 的 HTTP 接口 |

<a id="主动能动性"></a>
## 主动能动性

这是它成为 agent 而不是窗口的部分，而且做的是**可测量的闭环**，不是一句"你要主动一点"的提示词。

```
观察 ─▶ 决策 ─▶ 开口 ─▶ 结算 ─▶ 学习
  │        │        │        │        │
屏幕 L0    bandit   主对话   6 小时未   各类型的后验
活动、     选类型 +  里出现   回应按 0   与门槛自动
记忆、     台账排序  消息     奖励结算   更新
台账       + 门禁
```

**观察**：动手之前先拼上下文——最近的屏幕活动（本地 OCR 摘要，约 90 分钟工作记忆）、此刻真正相关的记忆、带截止日期的跟进台账、主对话的尾部。它知道你是在编辑器里专注、在开会，还是闲着。

**决策**：三个机制各司其职：

| 机制 | 决定什么 | 怎么算 |
|---|---|---|
| **Thompson 采样 bandit** | 开口**用哪种类型** | 每个类型一个 Beta 后验（`跟进 · 建议 · 指导 · 询问 · 日报`），采样取最高 |
| **台账 EV 排序** | **跟哪一件事** | 确定性打分：截止临近度 × 置信度 − 已提过次数 − 放置过久 |
| **门禁** | **到底要不要开口** | 静默时段、每日预算、最小间隔、连续被忽视则间隔翻倍，以及"你正在打字时不打断" |

**开口**：主动消息落在长期存在的**主对话**里，换模型不影响连续性——连续的是*你*，不是某个模型。通知可选；状态栏图标显示未读点。

**结算与学习**：被接住记 1 分；放 6 小时没人理按 0 分结算。这个奖励会更新该类型的后验，**并且**在它反复失败时抬高该类消息的置信门槛。有效的类型会被更多尝试，招人烦的类型会自动变安静——全自动，而且看得见（后验与门槛就在界面上，不藏在日志里）。

**你始终掌控**：预算、静默时段、最小间隔、置信门槛、各类型门槛都可改；消息上的 *有用 / 没用* 立即进入闭环，*多说一点 / 少说一点* 一键整体收紧或放宽。最强的信号源——屏幕感知——**默认关闭**，只有 `deep` 记忆档才会打开。

数字不靠嘴说：离线回放（2000 轮、固定的各类型被接住概率、跑的是真实 bandit 代码）里，自适应策略比固定轮换多拿到 **60–80%** 的回复。这是模拟，我标明了——真正诚实的指标是你自己的自报告里的"被接住率"（`./bin/echo diag`），用上几天后它才开始说真话。

### 能动性也体现在别处

主动发言只是可见的那一半，同样的决策在后台持续发生：

- **Dream**（睡眠时巩固）：重写核心记忆、调和事实，并**决定忘掉什么**——每次淡出都写下理由与依据的数字。
- **跟进台账**：维护你说过要做的事、快到期的事、已经提过几次、以及你悄悄放下的事。
- **台账 → 对话**：过期事项会变成具体的话（"你说明天到期——按天还是按话题收个尾？"），而不是通用提醒。

<a id="记忆与遗忘"></a>
## 记忆与遗忘

| 层 | 存什么 | 生命周期 | 用途 |
|---|---|---|---|
| **L0 工作记忆** | 最近 ~90 分钟的屏幕活动摘要 | 自动过期、容量上限 | 知道"你此刻在做什么" |
| **L1 即时事实** | 从对话与屏幕抽取的稳定事实 | 强度衰减，久不用淡出 | 检索召回、L2 的原料 |
| **L2 核心记忆** | `data/memory/MEMORY.md` | 每次 Dream 重写 | 每轮注入，可手改 |
| **L3 归档与图谱** | Dream 快照、遗忘日志、实体图 | 保留可回溯 | 审计、实体召回 |

强度 = 重要度 × 使用增益 × 指数衰减。被检索命中会强化；久不用的事实**淡出**（保留、可复活，不是删除）；超容量时按强度从最弱淘汰；**每一次淡出与遗忘都写进 `memory/forgetting.md` 并附理由**。你可以保护、复活、明确忘掉任何一条。记忆档位（`off · light · standard · deep`）决定这套机制要跑多少。

<a id="安装"></a>
## 安装

**macOS 安装包（推荐，通用二进制：Apple Silicon + Intel）**：到 [Releases](https://github.com/Lazarus-coder/echo-assistant/releases) 下载 `Echo-0.1.0-alpha.2-macos.dmg`，打开后双击 **Install Echo.command**。它把 `Echo.app` 与服务装到 `~/Library/Application Support/Echo`、注册 launchd 常驻、并询问模型端点与 Key（可跳过，网页里有向导）。卸载双击同一目录里的 `Uninstall Echo.command`。

**从源码装**（macOS，Node ≥ 20）：

```bash
git clone https://github.com/Lazarus-coder/echo-assistant.git && cd echo-assistant
./install.sh          # 凭据 → launchd 常驻 → 编译状态栏图标
./bin/echo status     # 进程 / 健康 / 局域网地址 / 记忆与主动服务概览
./bin/echo open       # 打开对话窗口
```

| 命令 | 作用 |
|---|---|
| `./bin/echo up / down / restart` | 启动 / 停止 / 重启 |
| `./bin/echo logs` | 跟踪日志 |
| `./bin/echo dream` | 立刻巩固记忆 + 执行遗忘 |
| `./bin/echo say` | 立刻判断一次"要不要主动说句话" |
| `./bin/echo diag` | 自报告：延迟、失败、工具成功率、**被接住率**、存储 |
| `./bin/echo forget` | 看它忘了什么、为什么忘 |
| `./bin/echo auth on\|off` | 开关口令验证（默认关） |
| `./bin/echo selftest [--live]` | 冻结评估器（隔离沙箱；`--live` 会真调模型） |

手机访问：同一 WiFi 下打开 `http://<Mac 的局域网 IP>:8787`，Safari"添加到主屏幕"即可。公共网络下建议 `./bin/echo auth on`。

## 权限与常驻

完整说明：[docs/permissions.md](docs/permissions.md)。要点：**默认全部关**（不要口令、不采集屏幕、不发通知）；安装器注册两个 launchd 任务（`com.echo.chat` / `com.echo.menubar`）；屏幕感知（主动决策的输入之一）需要一次系统授权，入口在状态栏图标菜单里。

## 数据与磁盘

```
data/
  echo.env              密钥（600）——不进 config、不进 git
  conversations/*.json  消息、工具轨迹、用量、滚动摘要
  memory/               MEMORY.md · observations.jsonl · working.jsonl · graph.json
                        forgetting.md · engines.json · dreams/（审计）
  uploads/              你发的图与生成的图
  metrics.jsonl         自报告（延迟、失败、被接住率）
```

磁盘预算自动执行（`config.json → storage`）：截图 200MB / 3 天、生成图 300MB / 60 天，超 80% 从最旧删，被最近对话引用的图永不删；每 6 小时与开机各维护一次；设置里有"全部忘掉"。

## 自我改进

Echo 不改自己的代码，只取这件事里保守的那一半：**冻结评估器**（`tests/selftest.mjs`，隔离沙箱，离线 69 条 + 实时 79 条断言，断言的是设计不变量而非实现细节）、公开的迭代日志（假设、分数、判决、教训，见 [docs/rsi-log.md](docs/rsi-log.md)），以及一条规矩：判据只增严，不放松。

<a id="未来规划"></a>
## 未来规划

Echo 还在 alpha。方向是：让这个私人 agent 真正能**动手**，并沿用它在记忆上的那套纪律——有预算、可解释、可回滚。

### Computer use（计划中）

地基已经在：状态栏 App 负责截屏与本地 OCR，循环本来就能调工具，每个动作都落在审计轨迹里。Computer use 要把它从"看懂"推进到"动手"（`computer_use` 工具：点击、输入、滚动、切换应用）。

上线时的约束（草案；必须显式开启，绝不默认）：

- **模型提议、App 执行**——真正的操作放在状态栏 App（Accessibility API + `CGEvent`）里，单独授权；模型拿不到输入设备的直接句柄。
- **破坏性操作逐次确认**；应用与动作类型允许清单；确认粒度"每次问 / 同应用只问一次 / 全自动"。
- **每个动作留审计**（做了什么、在哪、哪个应用、前后快照哈希），格式与 `forgetting.md` 一样可读可删。
- **急停 + 硬预算**（每分钟/每天动作数），沿用搜索那套熔断思路。
- **dry-run**：先把计划讲一遍，你看过再给写权限。
- 也可以**直接插 computer-use MCP 服务**——MCP 支持已有，确认、审计、预算三条同样施加于它暴露的任何工具。

### 也在考虑

可选的 **embedding 检索**（现在是词法 BM25 + 实体图，零依赖，做成"想开就开"的索引）· 实体图的**双时态**（让"以前成立"的关系能显式失效）· 端点支持 OpenAI 兼容 `/audio` 时的**语音进出**。

### 明确不做

多用户托管、记忆云端同步、遥测、任何需要账号的东西。一个人、一台机器、一堆你可以随手删掉的明文文件。

## 仓库结构

```
server.mjs          路由 / SSE / 调度 / 认证 / 引导
lib/                chat · context · memory(分层/遗忘) · graph · screen · dream
                    proactive · agency(bandit/台账) · providers · search · media
                    mcp · storage · metrics · tools
public/             单页前端（零构建、零依赖）
menubar/            Swift 状态栏 App（源码 + 图标生成器）
tests/selftest.mjs  冻结评估器（隔离沙箱）
bin/echo CLI        install.sh / scripts/macos（安装器与 DMG）
docs/               landscape · rsi-log · permissions · release notes
```

## 许可

仓库暂未放许可证文件，默认保留所有权利。想复用可以开 issue，我们挑一个（通常 MIT 或 Apache-2.0）。