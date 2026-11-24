# Permissions & residency (macOS)

Your model endpoint handles chat. Screen access, workspace tools, background research, and LAN access each have their own controls. [Getting started](getting-started.md) · [Simplified Chinese edition](zh-CN/permissions.md)

## 1. Model API (BYOK) — no special permission

Echo talks to whatever OpenAI-compatible endpoint you configure. There is no bundled provider and no bundled key. Setup can be done three ways:

1. **First-run wizard** (recommended): open the app → the wizard asks for *endpoint presets → key → models → memory profile → search chain → permissions*. Keys are written to `data/echo.env` (mode `600`), never to `config.json` and never to git.
2. **Installer**: `./install.sh` asks for a base URL (with common presets) and reads `OPENAI_BASE_URL` / `OPENAI_API_KEY` from your login shell if present.
3. **Manually**: put `OPENAI_API_KEY=…` and `OPENAI_BASE_URL=…` into `data/echo.env`, or export them in the environment that launches the service.

A profile that names a custom key variable uses that variable exclusively. The wizard accepts a manual model ID when the endpoint cannot list models. Background work uses the configured utility model or the selected default.

| Capability | Needs |
|---|---|
| text / reasoning / streaming / tool calls | the basic `/chat/completions` API |
| vision (image input) | a vision-capable model id |
| image generation (`image_gen`) | a model id that generates images; leave it empty to disable the tool |
| hosted search (`gateway` provider) | an endpoint that implements the Responses API with `web_search` (for example, Alibaba Cloud Model Studio) |

## 2. Screen Recording — only if you enable screen awareness

Screen awareness is **off by default**; the `light`/`standard` memory profiles keep it off, and only the `deep` profile turns it on.

What actually happens when it is on:

- the menu-bar app (`EchoBar`) captures the screen on an interval;
- **OCR runs on-device** using Apple Vision. In the default OCR mode the endpoint receives text. If you explicitly select image mode, screen awareness can send the screenshot to a vision model;
- the menu-bar app uses a unique temporary image inside the selected profile's private spool. It removes the image after processing. Maintenance can remove stale capture files left by an interruption.
- capture is skipped while the screen is locked or the keyboard/mouse has been idle;
- every capture path still has the same block-list you configure in *Settings → Screen awareness* (default: empty — your machine, your rules).

How to grant it:

1. Click the Echo icon in the menu bar → choose **Grant Screen Recording permission for screen awareness**. If permission is still missing, Echo opens System Settings.
2. In **System Settings → Privacy & Security → Screen Recording**, enable `EchoBar`.
3. If macOS asks you to restart, run `./bin/echo down && ./bin/echo up` to relaunch the service and menu-bar app.
4. Open **Settings → Setup and permissions → Test Screen Recording permission** to verify access.

Without the grant, Echo degrades quietly: captures are skipped, the log says so, and everything else keeps working.

## 2b. Companion mode — same grant, higher frequency

Companion mode (off by default, enabled from the menu bar or *Settings → Companion mode*) reuses the same Screen Recording grant but captures far more often (default every 20 s instead of every 5 minutes). Everything above still applies: on-device OCR, text only, screenshots deleted after analysis, block-list respected, and nothing is sent to the model when the screen hasn't changed. It can be paused instantly from the menu bar, and it silences itself after three dismissals in a row.

**Published alpha.6 users.** Companion OCR in that package can send text from an excluded window to your model. Keep companion mode off in alpha.6 if you rely on exclusions. The current source applies the same app, title and text filters to companion OCR and ordinary screen awareness.

## 2c. Why macOS sometimes asks again (and how to stop it)

Screen Recording permission is managed by macOS and tied to **app identity**. The packaging and installation scripts attempt ad-hoc signing; Echo is not Developer ID signed or notarized. Moving or rebuilding the app may require granting access again.

Two practices reduce unnecessary app-identity changes:

1. **For everyday use, install from the DMG** — the installer places `Echo.app` at `~/Library/Application Support/Echo/Echo.app` with a fixed bundle id, `com.echoassistant.menubar`. This does not guarantee that macOS will preserve permission indefinitely.
2. **When developing from source, permission may need to be renewed after a rebuild.** `./install.sh` detects an already-installed app and *skips* rebuilding the binary on purpose.

Echo never *initiates* a permission dialog on its own: without the grant it simply skips captures, notes it in the log, and shows one ⚠️ item in the menu-bar menu. Nothing pops up until you click it (or run the screen test in *Settings → Setup and permissions*).

## 3. Notifications — optional

Proactive messages announce themselves through `osascript`. If a banner is missing, check the notification settings for the sending app in **System Settings → Notifications**, or just rely on the unread dot in the menu bar.

### How timing is personalized in the current source

The timing policy belongs to the Mac's Echo data profile. Anyone chatting through a shared installation contributes to that same profile. While proactive messages or companion bubbles are enabled, Echo records which three-hour local time bands contained a user chat, at most once per band and date. The timing sample contains no chat text. The policy considers the last 14 local dates in the current time zone. **Forget everything** clears the learned timing history.

The presets are starting parameters. Quiet starts with a 120-minute interval for optional suggestions, a six-hour wait for an established chat window, and a 0.70 content threshold. Balanced starts at 0 minutes, three hours and 0.62. Engaged starts at 0 minutes, 0 hours and 0.52. A zero here leaves the configured minimum gaps in force. The local policy adjusts these values using recent timing votes and regularity across distinct chat dates. Open **Proactive assistance → Interruption timing and feedback** to compare the preset with today's effective values. User-requested drafts take priority. Quiet hours, active chats, fresh meeting or deep-focus signals, pauses and delivery limits still apply.

Rate a reminder's content with **Useful** or **Not useful**, and its timing with **Good timing** or **Bad timing**. Marking the timing wrong starts a 30-minute pause. Timing votes apply to the kind of interruption and its original delivery time. Usefulness votes affect the ranking of topics and types of help. You can correct a vote on its original message.

When a suggestion is eligible, the local engine selects its topic and evidence. The wording request contains that selection and the communication preferences enabled for background use. Companion bubbles use one selected OCR excerpt. Proactive chat can use a recent activity summary from screen awareness when that feature is enabled. A saved preparation can be delivered directly. The decision uses no model calls when all candidates are held. The score expresses priority on a 0–1 scale.

In **Proactive assistance → Preview candidates**, Echo shows up to three candidates using the same local ranking and timing checks as delivery. Viewing the preview makes no model request, consumes no notification budget and records no vote. A chat topic mute matches the normalized title, including across new source IDs. A companion mute matches a cue family, such as failed tests. You can undo either in the preview or on the original message. User-requested preparations retain their usual timing rules. Personal topic names come from currently available sources. An unavailable topic can still be unmuted by its saved entry and date.

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
./bin/echo down             # stop both services
./bin/echo up               # start both services
xcode-select --install      # only if you want the menu-bar app and lack swiftc
```

`GET /api/permissions` (or *Settings → Setup and permissions*) reports the current state: endpoint configured, launchd residency, `swiftc`, bind address, data directory.

## 5. Network exposure

- Fresh profiles from alpha.8 onward listen on `127.0.0.1:8787`. The public alpha.6 installer defaults to all interfaces without a password.
- Before sharing the listener, set a password with `./bin/echo passwd`, then enable authentication with `./bin/echo auth on`. Sessions are HttpOnly + SameSite=Strict; write requests additionally require a custom header that cross-site pages cannot forge.
- For phone access, enable password protection, set `"bind": "all"` in `config.json` and restart Echo. An explicit `ECHO_BIND` overrides the saved value.

## 6. Files on disk

Everything Echo knows lives under `data/` — `echo.env` (keys, `600`), conversations, memory (`MEMORY.md`, `observations.jsonl`, `working.jsonl`, `graph.json`, `forgetting.md`), uploads, `metrics.jsonl`, logs. You can read, back up, or delete any of it. Disk budgets for screenshots/images are enforced (`config.json → storage`), and *Settings → Privacy controls* has a one-click “forget everything”.

**Memory → Interaction preferences** stores response preferences and manually entered person notes in `data/state.json`. These are ordinary personal memory: existing login and write-request protections apply. With personalization and memory injection enabled, response preferences and up to three people matched to the current conversation are sent to the chosen model endpoint. A short follow-up may use the immediately preceding user message to resolve the person. Existing proactive/companion calls receive only response preferences, not these person notes; this feature creates no additional notifications or model calls.

Disable personalization, turn off memory injection, or delete a person to stop including the affected saved context in subsequent requests. This does not retract prior provider requests or erase conversation history. JSON backups include these records, and “forget everything” removes them. No separate mood scores or emotional profiles are stored. Emotional restraint and source attribution are model instructions, not a guarantee about every generated response.

## 7. Workspace tools and MCP

Workspace tools start disabled. On the host Mac, open **Workspace**, select an existing directory, and enable reading, editing, and Shell separately. File tools stay inside this directory, reject symlinks and Echo private data, and check the current file hash before replacement. Enabling editing authorizes direct edits; before/after snapshots are saved for review.

**Conversation mode.** On the host Mac, choose **Read-only plan** to review a project before making changes. The server limits the assistant to read tools in that conversation, even if the project permits editing. It can search source text, read files and review existing results. Choosing **Work** restores the tools enabled for this workspace. Existing conversations start in that mode. The mode controls tools for the interactive turn. Echo still saves the chat and applies the profile’s memory and background settings.

Every Shell and MCP tool call requires approval of its exact inputs. Shell runs with your operating-system account privileges: **this is not an OS sandbox**, and a working directory is not a file or network access boundary. MCP servers also run with their own configured privileges; connecting a stdio server launches its configured program. Only configure trusted servers. The official MCP SDK handles protocol negotiation, transport, and cancellation. Required subprocess credentials must be explicitly supplied in the server's `env`; Echo's provider keys are not automatically inherited.

Stop terminates the local Shell process group and requests cancellation from MCP. It cannot undo completed actions or guarantee that a remote MCP server stops its work. Approval expires after five minutes, denial ends the turn, and interrupted runs are never replayed on restart. Disabling capabilities cancels active runs.

Configuration, local execution, approvals, and output downloads are restricted to loopback connections; phone/LAN chat has no workspace or MCP tools. Run records, command logs, and edit snapshots are stored under `data/runs/` and may contain project data. They persist until “forget everything” clears them; back up this directory separately from conversation JSON exports. File contents and tool results used by the model are sent to your chosen model endpoint. Goal preparation remains read-only and receives no unattended command authority.

## 8. Background research

Background research starts disabled. Enable it on the host Mac in **Proactive assistance**. The separate “discover from new chats” setting allows bounded analysis of messages written after activation; it does not turn off or on ordinary memory. It may send those messages and the current case to the configured model endpoint, and public search queries to the configured search provider. It creates no mood or relationship profiles.

Each goal has its own research scope: public URLs, up to five explicitly uploaded PDF/text documents, and up to three selected folders relative to the enabled workspace. Folder reads retain workspace path/symlink/private-data protections. Background tools cannot execute Shell, call MCP, edit files, submit forms, or send messages to other people. Uploaded document extraction is local; selected extracts are sent to the model when used. Documents persist in `data/research/documents/`, are included in JSON backups, and are removed by “forget everything.” Research run outputs live in `data/runs/`.

User-confirmed official domains establish which sources may support a verified deadline claim; a search result does not certify itself as official. Unknown or conflicting dates remain visible as candidates. Research and notification permissions are independent: quiet hours and delivery budgets still apply. Disable research to cancel its active work. A memory-only reset also advances the discovery start time, so retained old chats are not immediately re-imported. The Mac must be awake with Echo running for checks to execute.
