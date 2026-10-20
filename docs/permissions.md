# Permissions & residency (macOS)

Echo asks for as little as possible, but two things need your explicit consent, and one command decides whether it survives a reboot.

## 1. Model API (BYOK) — no special permission

Echo talks to whatever OpenAI-compatible endpoint you configure. There is no bundled provider and no bundled key. Setup can be done three ways:

1. **First-run wizard** (recommended): open the app → the wizard asks for *endpoint presets → key → models → memory profile → search chain → permissions*. Keys are written to `data/echo.env` (mode `600`), never to `config.json` and never to git.
2. **Installer**: `./install.sh` asks for a base URL (with common presets) and reads `OPENAI_BASE_URL` / `OPENAI_API_KEY` from your login shell if present.
3. **Manually**: put `OPENAI_API_KEY=…` and `OPENAI_BASE_URL=…` into `data/echo.env`, or export them in the environment that launches the service.

Which endpoint works with what:

| Capability | Needs |
|---|---|
| text / reasoning / streaming / tool calls | the basic `/chat/completions` API |
| vision (image input) | a vision-capable model id |
| image generation (`image_gen`) | a model id that generates images; leave it empty to disable the tool |
| hosted search (`gateway` provider) | an endpoint that implements the Responses API with `web_search` (e.g. Aliyun Bailian) |

## 2. Screen Recording — only if you enable screen awareness

Screen awareness is **off by default**; the `light`/`standard` memory profiles keep it off, and only the `deep` profile turns it on.

What actually happens when it is on:

- the menu-bar app (`EchoBar`) captures the screen on an interval;
- **OCR runs on-device** (Apple Vision). By default only the *text* is sent to your model endpoint — the image never leaves the machine;
- the camera-roll of screenshots is not kept: the temporary file is deleted right after the analysis;
- capture is skipped while the screen is locked or the keyboard/mouse has been idle;
- every capture path still has the same block-list you configure in *Settings → Screen awareness* (default: empty — your machine, your rules).

How to grant it:

1. Click the Echo icon in the menu bar → if you see `⚠️ 屏幕感知需要「屏幕录制」权限`, click it (it opens the right System Settings pane).
2. In **System Settings → Privacy & Security → Screen Recording**, enable `EchoBar`.
3. Restart the menu-bar item (`./bin/echo down && ./bin/echo up`, or launchctl kickstart) — macOS only re-reads this permission at process start.
4. Verify: *Settings → 引导与权限 → 测试屏幕录制权限* should report “已授权，能抓到画面”.

Without the grant, Echo degrades quietly: captures are skipped, the log says so, and everything else keeps working.

## 2b. Companion mode — same grant, higher frequency

Companion mode (off by default, enabled from the menu bar or *Settings → 伴随模式*) reuses the same Screen Recording grant but captures far more often (default every 20 s instead of every 5 minutes). Everything above still applies: on-device OCR, text only, screenshots deleted after analysis, block-list respected, and nothing is sent to the model when the screen hasn't changed. It can be paused instantly from the menu bar, and it silences itself after three dismissals in a row.

## 2c. Why macOS sometimes asks again (and how to stop it)

Screen Recording is granted **per app identity**. Our menu-bar binary is not Developer-ID signed*, so whenever the binary itself changes (e.g. rebuilding from source), macOS treats it as a different app and asks again.

Two rules keep it quiet:

1. **For everyday use, install from the DMG** — the installer places `Echo.app` at `~/Library/Application Support/Echo/Echo.app` (fixed path, fixed bundle id `com.echoassistant.menubar`) and ad-hoc signs it. Grant once; it stays granted.
2. **When developing from source, expect one re-grant per rebuild.** `./install.sh` detects an already-installed app and *skips* rebuilding the binary on purpose. If you do rebuild, macOS will ask once more — that is the price of changing the binary, not a bug.

Echo never *initiates* a permission dialog on its own: without the grant it simply skips captures, notes it in the log, and shows one ⚠️ item in the menu-bar menu. Nothing pops up until you click it (or run the screen test in *Settings → 引导与权限*).

`*` A Developer ID signature would make this permanent; it needs a paid Apple account, which a local personal tool does not warrant.

## 3. Notifications — optional

Proactive messages announce themselves through `osascript`. If nothing shows up, allow notifications for your terminal/launcher app in **System Settings → Notifications**, or just rely on the unread dot in the menu bar.

## 4. Residency — `./install.sh`

Echo is designed to stay running. `./install.sh` registers two launchd agents:

| Label | What | Notes |
|---|---|---|
| `com.echo.chat` | the Node service (`server.mjs`) | starts at login, restarted on crash, logs to `data/logs/echo.out.log` |
| `com.echo.menubar` | the menu-bar icon (`build/EchoBar`) | `Aqua` session only; builds from `menubar/EchoBar.swift` if `swiftc` is available |

Useful commands:

```bash
./bin/echo status           # process / health / LAN URL / memory & proactivity summary
./bin/echo logs             # follow logs
./bin/echo down | up        # stop / start (also removes/starts the menu-bar icon)
xcode-select --install      # only if you want the menu-bar app and lack swiftc
```

`GET /api/permissions` (or *Settings → 引导与权限*) reports the current state: endpoint configured, launchd residency, `swiftc`, bind address, data directory.

## 5. Network exposure

- Default bind is `0.0.0.0:8787` so your phone on the same Wi-Fi can use it; **no password by default** (local personal use).
- On untrusted networks: `./bin/echo auth on` then `./bin/echo passwd`. Sessions are HttpOnly + SameSite=Strict; write requests additionally require a custom header that cross-site pages cannot forge.
- To bind loopback only, set `bind: "local"` in `config.json` (or `ECHO_BIND=local`).

## 6. Files on disk

Everything Echo knows lives under `data/` — `echo.env` (keys, `600`), conversations, memory (`MEMORY.md`, `observations.jsonl`, `working.jsonl`, `graph.json`, `forgetting.md`), uploads, `metrics.jsonl`, logs. You can read, back up, or delete any of it. Disk budgets for screenshots/images are enforced (`config.json → storage`), and *Settings → 隐私兜底* has a one-click “forget everything”.

**Memory → 相处方式** stores response preferences and manually entered person notes in `data/state.json`. These are ordinary personal memory: existing login and write-request protections apply. With personalization and memory injection enabled, response preferences and up to three people matched to the current conversation are sent to the chosen model endpoint. A short follow-up may use the immediately preceding user message to resolve the person. Existing proactive/companion calls receive only response preferences, not these person notes; this feature creates no additional notifications or model calls.

Disable personalization, turn off memory injection, or delete a person to stop including the affected saved context in subsequent requests. This does not retract prior provider requests or erase conversation history. JSON backups include these records, and “forget everything” removes them. No separate mood scores or emotional profiles are stored. Emotional restraint and source attribution are model instructions, not a guarantee about every generated response.

## 7. Workspace tools and MCP

Workspace tools start disabled. On the host Mac, open **工作区**, select an existing directory, and enable reading, editing, and Shell separately. File tools stay inside this directory, reject symlinks and Echo private data, and check the current file hash before replacement. Enabling editing authorizes direct edits; before/after snapshots are saved for review.

Every Shell and MCP tool call requires approval of its exact inputs. Shell runs with your operating-system account privileges: **this is not an OS sandbox**, and a working directory is not a file or network access boundary. MCP servers also run with their own configured privileges; connecting a stdio server launches its configured program. Only configure trusted servers. The official MCP SDK handles protocol negotiation, transport, and cancellation. Required subprocess credentials must be explicitly supplied in the server's `env`; Echo's provider keys are not automatically inherited.

Stop terminates the local Shell process group and requests cancellation from MCP. It cannot undo completed actions or guarantee that a remote MCP server stops its work. Approval expires after five minutes, denial ends the turn, and interrupted runs are never replayed on restart. Disabling capabilities cancels active runs.

Configuration, local execution, approvals, and output downloads are restricted to loopback connections; phone/LAN chat has no workspace or MCP tools. Run records, command logs, and edit snapshots are stored under `data/runs/` and may contain project data. They persist until “forget everything” clears them; back up this directory separately from conversation JSON exports. File contents and tool results used by the model are sent to your chosen model endpoint. Goal preparation remains read-only and receives no unattended command authority.

## 8. Background research

Background research starts disabled. Enable it on the host Mac in **主动服务**. The separate “discover from new chats” setting allows bounded analysis of messages written after activation; it does not turn off or on ordinary memory. It may send those messages and the current case to the configured model endpoint, and public search queries to the configured search provider. It creates no mood or relationship profiles.

Each goal has its own research scope: public URLs, up to five explicitly uploaded PDF/text documents, and up to three selected folders relative to the enabled workspace. Folder reads retain workspace path/symlink/private-data protections. Background tools cannot execute Shell, call MCP, edit files, submit forms, or send messages to other people. Uploaded document extraction is local; selected extracts are sent to the model when used. Documents persist in `data/research/documents/`, are included in JSON backups, and are removed by “forget everything.” Research run outputs live in `data/runs/`.

User-confirmed official domains establish which sources may support a verified deadline claim; a search result does not certify itself as official. Unknown or conflicting dates remain visible as candidates. Research and notification permissions are independent: quiet hours and delivery budgets still apply. Disable research to cancel its active work. A memory-only reset also advances the discovery start time, so retained old chats are not immediately re-imported. The Mac must be awake with Echo running for checks to execute.

---

## 中文速览

- **模型端点**：无内置厂商与密钥；首次打开会引导你填端点 → 密钥 → 模型 → 记忆档位 → 搜索链 → 权限。密钥只写 `data/echo.env`（600），不进 `config.json`、不进 git。
- **屏幕录制**：默认不采集；只有 `deep` 档会开。开了以后本地 OCR、只发文字、截图即删、锁屏与空闲自动跳过、屏蔽名单你自己定。授权入口在状态栏图标的菜单里，授权后要重启一次图标进程。
- **通知**：主动消息走 osascript，必要时在系统设置里允许。
- **常驻**：`./install.sh` 注册 `com.echo.chat` + `com.echo.menubar` 两个 launchd 任务（登录自启、崩溃自动拉起）。
- **网络**：默认监听 `0.0.0.0:8787` 且免登录；公共网络下用 `./bin/echo auth on` 开启口令。
- **相处方式**：交流偏好与手动人物背景存在 `data/state.json`，随备份导出、“忘掉一切”清除。开启功能与记忆注入时，相关资料会发给所选模型；关闭或删除只影响后续请求，不抹去历史对话。此功能不增加通知，也不单独保存情绪档案。
- **后台研究**：默认关闭，在本机单独开启。新对话与选定来源可能发给已配置的模型，搜索词发给搜索提供方；不自动读取邮箱或所有文件。只读工具不获得 Shell/MCP/外部写权限，通知仍受静默与预算控制。关闭会取消研究，“全部忘掉”清除文档和事务；睡眠期间不运行。
- **工作区与 MCP**：本机显式开启；文件编辑检查哈希并保存前后快照；Shell/MCP 每次确认。Shell 以本机账号权限运行，并非操作系统沙箱。局域网对话不能调用本机工具。停止不等于撤销，重启不会重放；`data/runs/` 保存输出，“全部忘掉”会清除。
- **数据**：全在 `data/`，明文可读可删；磁盘预算自动执行；设置里有"全部忘掉"。
