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

---

## 中文速览

- **模型端点**：无内置厂商与密钥；首次打开会引导你填端点 → 密钥 → 模型 → 记忆档位 → 搜索链 → 权限。密钥只写 `data/echo.env`（600），不进 `config.json`、不进 git。
- **屏幕录制**：默认不采集；只有 `deep` 档会开。开了以后本地 OCR、只发文字、截图即删、锁屏与空闲自动跳过、屏蔽名单你自己定。授权入口在状态栏图标的菜单里，授权后要重启一次图标进程。
- **通知**：主动消息走 osascript，必要时在系统设置里允许。
- **常驻**：`./install.sh` 注册 `com.echo.chat` + `com.echo.menubar` 两个 launchd 任务（登录自启、崩溃自动拉起）。
- **网络**：默认监听 `0.0.0.0:8787` 且免登录；公共网络下用 `./bin/echo auth on` 开启口令。
- **数据**：全在 `data/`，明文可读可删；磁盘预算自动执行；设置里有"全部忘掉"。