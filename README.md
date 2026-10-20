<div align="center">

# Echo

> We are not what we remember, but what we forget.

![BYOK](https://img.shields.io/badge/BYOK-any%20endpoint%2C%20your%20key-2f6f57?style=flat-square)
![Personal agent](https://img.shields.io/badge/personal%20agent-local--first-2f6f57?style=flat-square)
![Proactive agency](https://img.shields.io/badge/proactive%20agency-measured%20loop-2f6f57?style=flat-square)
![MCP SDK](https://img.shields.io/badge/tools-official%20MCP%20SDK-2f6f57?style=flat-square)
![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)

<p align="center">
  <a href="#positioning">Positioning</a> ·
  <a href="#byok">BYOK</a> ·
  <a href="#proactive-agency">Proactive agency</a> ·
  <a href="#the-chat-window">Chat window</a> ·
  <a href="#workspace-harness">Workspace</a> ·
  <a href="#companion-mode-opt-in">Companion</a> ·
  <a href="#memory--forgetting">Memory</a> ·
  <a href="#quick-start">Install</a> ·
  <a href="#permissions">Permissions</a> ·
  <a href="#roadmap">Roadmap</a> ·
  <a href="docs/landscape.md">Landscape</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center"><em>A personal agent that lives on your Mac.<br />
<b>You bring the model</b> — any OpenAI-compatible endpoint, your key, your data, local files.<br />
<b>It has agency</b> — it decides what to remember, what to forget, when to speak up, and when to stay quiet.</em></p>

</div>

---

<a id="positioning"></a>
## Positioning

Most assistants wait. You type, they answer. Echo is built around the opposite bet: a **BYOK personal agent with proactive agency** — it runs continuously on your machine, keeps a memory it is allowed to lose, and initiates contact when it has something worth saying.

| | |
|---|---|
| **BYOK, not "our cloud"** | Any OpenAI-compatible endpoint (OpenAI · Aliyun Bailian · DeepSeek · Moonshot · OpenRouter · Ollama · your own). Keys live in `data/echo.env` (mode 600) — never in config, never in git, never logged. Swap providers without touching the app. |
| **Agency, not autocomplete** | It consolidates memory while you sleep, **forgets on purpose**, prepares work for goals you adopt, and decides when to surface it — learning from explicit outcomes. |
| **Local-first, not hosted** | Standard Node file/process APIs and the official MCP SDK, no vector database, no Echo account. Memory and execution records are plain files under `data/`: read them, back them up, delete them. |
| **One person, one Mac** | Single-user by design: a menu-bar icon, a chat window, a LAN URL for your phone. No multi-tenant anything. |

What it is **not**: a chat wrapper with a prettier skin, a cloud memory service, or a multi-agent framework. If you want a hosted assistant with team features, Echo is the wrong tool on purpose.

<a id="byok"></a>
## BYOK — bring your own everything

### The model

Point Echo at any OpenAI-compatible endpoint; the first-run wizard offers presets and then **tests the connection and discovers your model list** (`GET /models`). You pick a default model, a background/utility model (titles, memory extraction, Dream), and optionally an image model (leave it empty and the image tool simply doesn't exist).

Capabilities follow your endpoint, not a promise:

| Capability | Needs | Echo's behavior |
|---|---|---|
| chat / streaming / tool calls | the basic API | core loop |
| vision (paste/drag/upload) | a vision-capable model | images downscaled client-side before upload |
| image generation | an image model id | `image_gen` tool + a draw button; results **saved locally** (remote URLs expire) |
| hosted web search | an endpoint implementing the Responses API | the `gateway` search provider, no extra subscription |
| voice / video | an endpoint exposing `/audio`, video APIs | wired when available; discovered as missing otherwise |

If the endpoint doesn't offer something, the tool is hidden rather than failing at call time — and the model-fallback chain switches models instead of dropping your turn.

### Search (pluggable, your key or none)

Search is a **chain you configure**, tried in order; a failure (rate limit, missing key) hands off to the next provider. Keys are read from environment variables in `data/echo.env`.

| Provider | Needs | Notes |
|---|---|---|
| `none` | — | explicitly offline |
| `scrape` | — | zero-config scraping; fastest, can be rate-limited (circuit breaker cools it down) |
| `gateway` | — | your endpoint's hosted search (Responses `web_search`, 3–8 s, returns sources) |
| `tavily` · `brave` · `bocha` | API key | LLM-oriented / independent index / strong CN results |
| `searxng` | instance URL | your own aggregator |
| `custom` | — | any HTTP endpoint returning `{results:[{title,url,snippet}]}` |

<a id="the-chat-window"></a>
## The chat window

Streaming answers with the thinking fold · visible tool steps and source chips · edit-and-resend · regenerate · per-conversation model choice · image paste/drag/upload · a draw button wired to your image model · conversation pin/export · token accounting · dark/light · phone-sized layout.

**Prompt polish (⌘⇧P).** Type the half-sentence you actually have — “那个部署脚本老是超时，帮我看看” — and hit polish. It runs a small chain-of-thought pass that reads the conversation tail, the recalled facts that genuinely overlap your draft, and what you are doing right now, then: guesses your intent, lists the gaps, and rewrites the request at a usable granularity. You see the intent, the gaps and the assumptions it made (all editable), pick a mode — **expand / keep / tighten** — and either replace your draft or send it directly. Your input is never silently rewritten, and it will not invent objects: if the draft is too vague (“帮我看看 ”), it asks *you* what to look at instead of guessing from memory. A deterministic guard re-runs without memory if a memory-only name ever leaks into the text.

<a id="workspace-harness"></a>
## Workspace harness

Open **工作区** on the Mac running Echo, choose an existing project directory, and enable the capabilities you want. Reading, file editing, and Shell access are separate controls; workspace tools start disabled. Then describe the task in chat, for example: “Inspect this project, fix the failing check, and verify the change.”

- **Read and edit actual files.** Directory listings and text reads are paginated. Edits require the hash from a recent read, reject ambiguous replacements, and preserve before/after snapshots. File tools reject traversal, symlinks, and Echo's private data paths.
- **Run commands with review.** Every Shell call displays the exact command, working directory, and arguments before execution. Stdout/stderr stream into the conversation and are saved as downloadable files. `read_output` lets the model page through saved logs. Exit codes, failures, timeouts, and truncation stay visible.
- **Use standard tools.** The existing OpenAI-compatible tool loop now uses the [official MCP SDK](https://ts.sdk.modelcontextprotocol.io/client) for stdio and Streamable HTTP servers. Configured MCP calls receive the same individual approvals and durable records; server annotations do not grant permission. Configure servers under `mcpServers`, then reload MCP in Settings. Subprocesses receive a small environment allowlist; pass required MCP credentials explicitly through that server's `env`.
- **Bound and inspect each run.** The default is 12 tool rounds, at most 32 calls, a 60-second Shell timeout, and 2 MiB of combined command output. A final model response summarizes the actual results when the tool budget runs out. Stop cancels model/tool work and terminates the local command process group. Changing workspace permissions cancels active runs. Restarted runs are marked interrupted and are never automatically replayed.

The **工作区 → 本对话的执行记录** panel shows inputs, outcomes, approvals, changes, and output downloads. Records live in `data/runs/` until “forget everything” clears them; the conversation JSON export does not include the separate output files, so back up that directory when needed. No one-click rollback is implied: snapshots support reviewing and manually restoring a change.

Shell is **trusted host execution, not an OS sandbox**: its working directory does not prevent commands from accessing other files or the network. Approve only commands and MCP servers you trust. Workspace configuration, execution, approvals, and artifact downloads are available only from the host machine; LAN chat has no local execution tools. File contents and tool results used in a conversation go to your configured model provider. Remote MCP cancellation is cooperative and cannot undo an operation already completed.

Background goal preparation keeps its existing read-only scope; enabling this harness does not grant unattended goals Shell or file-write access.

<a id="proactive-agency"></a>
## Proactive agency

Echo can notice an unfinished need, research it, and wait for an appropriate moment to surface useful work. Open **主动服务** and explicitly enable background research to discover needs from new chats. Research permission and notification permission are separate.

1. **Durable commitments.** Create a goal or adopt a user message or Dream suggestion. Define the success criteria, next action, blocker, and optional deadline. Goals can be paused, resumed, completed with evidence, or cancelled. Dream suggestions remain candidates until you adopt them; a generated draft never marks a goal done.
2. **Scoped research.** Opted-in goals can search public sources, read pages/PDFs, use explicitly attached documents, and read selected folders inside the enabled workspace. Research uses the existing persisted harness with a read-only tool allowlist, bounded calls/time, and no Shell, MCP, or external writes. Discovery is limited to 20 model calls daily; preparation is limited to two attempts per goal and five overall in a rolling 24 hours. Legacy goals retain the single-call drafting path. New inferred cases carry the actual user-message reference, unresolved identity questions, and a seven-day expiry; adopt one to follow it indefinitely.
3. **Explicit outcomes.** Mark a result accepted, helpful in completing the goal, irrelevant, incorrect, or badly timed. Correcting feedback replaces the prior vote. Acceptance and completion count as one useful intervention; bad timing pauses interruptions for 30 minutes without changing the usefulness estimate. Silence and unrelated conversation stay unknown.
4. **Shared attention limits.** Proactive messages and companion bubbles share a daily budget and minimum gap, in addition to their channel limits. Quiet hours, fresh meeting/deep-work context, and recent chat activity defer delivery. Preparation can continue while delivery is disabled. Results remain available in the panel; queued messages expire and unchanged evidence is deduplicated. Screen context is only used when enabled and recent; absence of chat activity does not establish that the device is idle.
5. **Verified, durable follow-up.** Deadline and source watches can run together. Research checks quoted dates against the institution/program/cycle/category and user-confirmed official domains; conflicting or unsupported claims stay uncertain. Date-only sources never imply a precise time or timezone. Watches keep successful-check time, retry state, and deadline milestones; relevant source text is compared to avoid footer-only alerts. Explicit, task-specific completion in new chat can close the matching goal and stop its reminders.

This first version reads new Echo chats, shared public pages/PDFs, attached text documents, and explicitly selected workspace folders. It does not automatically ingest your browser, email, or calendar. Local checks pause while the Mac sleeps or Echo is stopped; startup, wake, and the periodic worker reconcile overdue work. Scanned PDFs without extractable text remain unreadable rather than producing invented evidence. Findings are source-supported, not a guarantee of factual correctness.

Goals, preparation results, and explicit outcomes persist locally and are included in the JSON backup. “Forget everything” also clears this work. Settings expose shared attention limits; the goal panel keeps source permissions and lifecycle controls together.

For ordinary proactive suggestions, a Thompson-sampling policy chooses a message type and an evidence-backed candidate, then the shared attention gate checks delivery. Its usefulness estimate changes only with explicit feedback. The offline bandit replay is a synthetic algorithm test; it does not measure real productivity gains. Actual completion and explicit outcome counts are available in diagnostics.

Dream still consolidates memory and proposes follow-up candidates. It does not silently turn those candidates into commitments.

## Companion mode (opt-in)

Proactive agency is about *timing*; companion mode is about *presence*. Turn it on and Echo watches along with you — capture frequency jumps from minutes to seconds — and occasionally floats a **bubble** in the corner of your screen. Not a notification, not a window that steals focus: a small card that fades away on its own unless you hover. Click it and a **small chat window** opens, focused on that exact topic, with a dedicated conversation you can keep chatting in.

Scenarios it is built for (each with its own voice):

| You are… | It does |
|---|---|
| **chatting with someone** (WeChat, Slack, mail) | offers wording help when useful; avoids guessing feelings, motives, or relationship closeness from the screen |
| **watching something** (a film, a video) | watches along as a friend — one feeling, one piece of trivia, one quip; never a lecture, never a question |
| **working** (docs, spreadsheets) | one concrete suggestion: the next step, the easy-to-miss detail, the number to double-check |
| **writing code** | speaks only when it can actually help: an API detail, an edge case, a shorter way |

The discipline that keeps it from becoming a nag:

- **Change detection first.** If the screen looks the same as the last frame, nothing is sent to the model at all — that is what makes watching every 20 seconds affordable, and what stops it repeating itself.
- **Budget, gap, back-off.** Bubbles per hour, a minimum gap between them, and if you dismiss three in a row it silences itself for a while (and says so in the log).
- **Never steals focus, never blocks.** Bubbles expire on their own; hover pauses the timer; the menu bar has an instant *pause 30 minutes*.
- **Same privacy defaults as screen awareness**: on-device OCR, text only, screenshots deleted after analysis, block-list respected, and it is **off by default**.

Bubbles carry their own reasoning: the card says one line, and the conversation it opens starts with *why* it thought that was worth saying. Opened and dismissed bubbles both feed the self-report (`./bin/echo diag`), so you can see whether the companionship is actually welcome.

<a id="memory--forgetting"></a>
## Memory & forgetting

| Layer | Holds | Lifecycle | Used for |
|---|---|---|---|
| **L0 working set** | screen-activity digests, last ~90 min | auto-expiring, capped | knowing what you are doing *right now* |
| **L1 facts** | stable facts from chat + screen | strength decay, fades when unused | retrieval, raw material for L2 |
| **L2 core** | `data/memory/MEMORY.md` | rewritten by Dream | injected every turn; hand-editable |
| **L3 archive & graph** | Dream snapshots, forgetting log, entity graph | retained for audit | auditability, entity recall |

Strength = importance × usage gain × exponential decay. Being retrieved strengthens a fact; unused facts *fade* (kept, revivable — not deleted); over capacity the weakest are evicted first; **every fade and deletion is written to `memory/forgetting.md` with its reason**. You can protect, revive, or explicitly forget anything. Memory profiles (`off · light · standard · deep`) choose how much of this runs at all.

**Quiet relationship awareness.** Expand **Memory → 相处方式** to choose a subtle (default), warm, or direct tone and whether you prefer listening or practical help. You can optionally set a preferred name, communication boundaries, and notes about up to 12 people. Notes are manually maintained: Echo uses at most three matching people when you mention them, or when a short follow-up refers to the immediately preceding user message. Current requests take priority over saved preferences.

Emotional sensitivity uses the current exchange, with brief acknowledgment only when helpful. It adds no mood scores, emotional profiles, check-ins, or notification triggers. Existing proactive messages may adapt their wording to your response preferences; they do not receive these person notes. Memory extraction and consolidation are instructed to preserve attribution and avoid turning temporary feelings or guesses about people into lasting facts.

Saved preferences and matching notes are sent to your configured model only when personalization and memory injection are enabled. Disabling either, or deleting a person, affects subsequent model requests without interrupting tools already running. Deletion does not erase prior conversations or data already sent to a provider. The records live in `data/state.json`, are included in JSON backups, and are removed by “forget everything”. Automated tests use a local mock provider; tone and inference quality still depend on your chosen model.

<a id="quick-start"></a>
## Install

**macOS installer (recommended, universal binary — Apple Silicon + Intel):** grab `Echo-0.1.0-alpha.6-macos.dmg` from [Releases](https://github.com/Lazarus-coder/echo-assistant/releases), open it, double-click **Install Echo.command**. It installs `Echo.app` + the service into `~/Library/Application Support/Echo`, registers launchd, and asks for your endpoint/key (skippable — the wizard covers it). Uninstall with the bundled `Uninstall Echo.command`.

**From source** (macOS, Node ≥ 22.13):

```bash
git clone https://github.com/Lazarus-coder/echo-assistant.git && cd echo-assistant
./install.sh          # locked npm dependencies + credentials + launchd + menu-bar build
./bin/echo status     # process / health / LAN URL / memory & proactivity
./bin/echo open       # open the chat window
```

| Command | What it does |
|---|---|
| `./bin/echo up / down / restart` | start / stop / restart the service |
| `./bin/echo logs` | tail logs |
| `./bin/echo dream` | consolidate memory + run forgetting now |
| `./bin/echo say` | ask it once whether to proactively speak |
| `./bin/echo diag` | self-report: latency, failures, tool success, **explicit outcomes and completed goals**, storage |
| `./bin/echo forget` | what has faded or been forgotten, and why |
| `./bin/echo auth on\|off` | require a password or not (off by default) |
| `./bin/echo selftest [--live]` | frozen evaluator (sandboxed; `--live` calls the model) |

Phone access: open `http://<mac-lan-ip>:8787` on the same Wi-Fi → “Add to Home Screen”. Turn on `./bin/echo auth on` on untrusted networks.

For development, run `npm ci --omit=dev --ignore-scripts`, then `npm start`. Source installs require Node 22.13+ and npm for the current PDF.js parser. `npm run test:harness` exercises files, Shell, MCP, approvals, persistence, APIs, and UI with temporary data and local mock servers; `npm run test:regressions` also covers proactive research and the existing product.

The HTTP and storage regression checks can also run separately:

```bash
node tests/server-regressions.mjs
node tests/storage-regressions.mjs
```

The server check verifies that Host or request-target values that fail URL parsing receive HTTP 400, then confirms the same process still serves health checks and normal routes. The storage check covers failed deletions, retries between age and budget cleanup, and protection of recently referenced uploads. Both use temporary data and configuration, with no live model calls.

**Test isolation:** the server check mocks the shared `/tmp/echo-capture` directory. Existing API suites in the full regression command still invoke startup cleanup there; `ECHO_DATA_DIR` and `ECHO_CONFIG` do not redirect it. To preserve an installed instance's temporary captures, use a test-only preload that mocks this directory in the spawned test servers as well.

<a id="permissions"></a>
## Permissions & residency

Full guide: [docs/permissions.md](docs/permissions.md). Short version: **everything is off by default** — no password, no screen capture, no notifications. The installer registers two launchd agents (`com.echo.chat`, `com.echo.menubar`); screen awareness (the input to proactive decisions) needs one macOS Screen Recording grant, offered from the menu-bar icon.

## Data & disk

```
data/
  echo.env              keys (0600) — never in config, never in git
  conversations/*.json  messages, tool traces, usage, rolling digest
  runs/*/               run.json + per-step command output and edit snapshots
  memory/               MEMORY.md · observations.jsonl · working.jsonl · graph.json
                        forgetting.md · engines.json · dreams/ (audit)
  uploads/              images you send and images generated
  metrics.jsonl         self-report (latency, failures, explicit outcomes)
```

Budgets are enforced (`config.json → storage`): screenshots 200 MB / 3 days, generated images 300 MB / 60 days, pruning oldest-first past 80 %, never deleting images referenced by recent conversations. Maintenance runs every six hours and at boot; *Settings → 隐私兜底* has a one-click “forget everything”.

Cleanup reports count only successful deletions as freed space. Files that cannot be deleted remain in the remaining-size totals, and cleanup continues with other eligible files.

## Self-improvement

How the product got shaped — every phase, the decision, and what was rejected — is kept in [docs/product-journey.md](docs/product-journey.md); it is required to be updated with every release (the packager refuses to build if it lags behind the version).

Echo does not rewrite its own code. It ships the conservative half of that idea: a **frozen evaluator** (`tests/selftest.mjs`, sandboxed, 69 offline + 79 live assertions against design invariants), a public iteration log with hypotheses, scores and lessons ([docs/rsi-log.md](docs/rsi-log.md)), and a rule that the score sheet is only ever tightened.

<a id="roadmap"></a>
## Roadmap

Echo is alpha. The direction is a personal agent that can *act*, under the same discipline it applies to memory: budgeted, explainable, reversible.

### Computer use (planned)

Most of the scaffolding exists — the menu-bar app captures and OCRs on-device, the loop calls tools, every action already lands in an audit trail. Computer use extends that from understanding to acting (a `computer_use` tool: click, type, scroll, switch apps).

Constraints it will ship under (draft; opt-in, never default):

- **The model proposes, the app performs.** Execution lives in the menu-bar app (Accessibility API + `CGEvent`) behind its own permission grant — the model never holds your input devices.
- **Per-action confirmation** for anything destructive; allow-lists for apps and action types; "ask every time / once per app / auto" ladder.
- **Audit per action** (what, where, which app, before/after snapshot hash) in the same readable, deletable style as `forgetting.md`.
- **Kill switch + hard budgets** (actions/minute, actions/day) using the same circuit-breaker thinking as search.
- **Dry-run mode** that narrates the plan before you grant write access.
- **Or plug a computer-use MCP server** — MCP support already exists, and the same confirmation, audit and budget rules apply to whatever it exposes.

### Also planned

Optional **embeddings-backed retrieval** (today: lexical BM25 + entity graph, zero dependencies, an index you can turn on rather than a new requirement) · **bi-temporal validity** for entity-graph edges, so "used to be true" facts can expire · **voice in/out** when your endpoint exposes OpenAI-compatible `/audio`.

### Explicitly not planned

Multi-user hosting, cloud sync of memory, telemetry, anything requiring an account. One person, one machine, plain files you can delete.

## Repo layout

```
server.mjs          HTTP server: routing, SSE, schedulers, auth, onboarding
lib/                chat · context (budget/digest) · memory (layers/forgetting) · graph
                    screen · dream · proactive · agency (bandit/ledger) · providers
                    search · media · mcp (official SDK) · harness · workspace
                    storage · metrics · tools
public/             single-page front end (no build step, no deps)
menubar/            Swift menu-bar app (source + icon generator)
tests/selftest.mjs  frozen evaluator (isolated sandbox)
bin/echo            CLI        install.sh / scripts/macos  installers & DMG
docs/               landscape · rsi-log · permissions · release notes
```

## License

No license file yet — all rights reserved by default. Open an issue if you want to reuse it and we will pick one (MIT/Apache-2.0 are the usual candidates).
