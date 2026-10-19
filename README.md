<div align="center">

# Echo

> We are not what we remember, but what we forget.

![BYOK](https://img.shields.io/badge/BYOK-any%20endpoint%2C%20your%20key-2f6f57?style=flat-square)
![Personal agent](https://img.shields.io/badge/personal%20agent-local--first-2f6f57?style=flat-square)
![Proactive agency](https://img.shields.io/badge/proactive%20agency-measured%20loop-2f6f57?style=flat-square)
![Zero dependencies](https://img.shields.io/badge/npm%20dependencies-0-2f6f57?style=flat-square)
![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)

<p align="center">
  <a href="#positioning">Positioning</a> ·
  <a href="#byok">BYOK</a> ·
  <a href="#proactive-agency">Proactive agency</a> ·
  <a href="#the-chat-window">Chat window</a> ·
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
| **Agency, not autocomplete** | It consolidates memory while you sleep, **forgets on purpose**, ranks its own follow-up ledger, and decides whether to interrupt you — with a reward signal from your actual replies. |
| **Local-first, not hosted** | Zero npm dependencies, no vector database, no account. Everything it knows is plain files under `data/`: read them, back them up, delete them. |
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

<a id="proactive-agency"></a>
## Proactive agency

This is the part that makes Echo an agent rather than a window. It is built as a **measurable closed loop**, not a prompt that says "be proactive".

```
observe ─▶ decide ─▶ speak ─▶ settle ─▶ learn
  │          │         │        │         │
L0 screen  bandit +  main   6 h without  posteriors &
activity,  ledger +  conver- a reply is  thresholds
memory,    gates     sation  reward 0    update per
ledger                                   kind
```

**Observe.** Before deciding anything, it assembles context: recent screen activity (on-device OCR digests, ~90-minute working set), the recalled facts that matter now, the follow-up ledger with due dates, and the tail of your main conversation. It knows whether you are deep in an editor, in a meeting, or idle.

**Decide.** Three mechanisms, each doing one job:

| Mechanism | What it decides | How |
|---|---|---|
| **Thompson-sampling bandit** | *which kind* of nudge | Beta posteriors per kind (`follow_up · suggest · guide · ask · brief`); sample and pick the highest |
| **Ledger EV ranking** | *which follow-up* to raise | deterministic score: due proximity × confidence − times-already-raised − staleness |
| **Gates** | *whether* to speak at all | quiet hours, per-day budget, minimum gap, back-off that doubles when you've been ignoring it, and "don't interrupt while the user is typing" |

**Speak.** Proactive messages land in a persistent **main conversation** that survives model switches — so continuity is with *you*, not with a particular model. Notifications are optional; the menu-bar icon shows an unread dot.

**Settle & learn.** A nudge that gets a reply is reward 1; one that sits unanswered for six hours settles as 0. That reward updates the posterior for that kind **and** raises its confidence threshold if it keeps failing. Kinds that work get tried more; kinds that annoy get quieter — automatically, and visibly (posteriors and thresholds are on the screen, not buried).

**You stay in charge.** Budgets, quiet hours, minimum gap, confidence threshold, and per-kind thresholds are all editable; the message actions *有用 / 没用* feed the loop immediately, and *多说一点 / 少说一点* tighten or loosen everything at once. Screen awareness — the strongest signal it has — is **off by default** and only the `deep` memory profile turns it on.

Measured, not asserted: in an offline replay (2000 rounds, fixed per-kind reply probabilities, real bandit code) the adaptive policy collects **60–80 %** more replies than a fixed rotation. That is a simulation, and it is labeled as one — the honest metric is the "engaged" rate in your own self-report (`./bin/echo diag`), which starts telling the truth after a few days of real use.

### Agency shows up elsewhere too

Proactive messaging is the visible half. The same decision-making runs in the background:

- **Dream** (sleep-time consolidation): rewrites core memory, reconciles facts, and *decides what to forget* — each fade with a written reason and the numbers behind it.
- **Follow-up ledger**: maintains what you said you'd do, what's due, what it already raised, what you quietly dropped.
- **Ledger → conversation**: overdue items surface as concrete messages ("you said this was due tomorrow — day-based or topic-based wrap-up?") instead of generic reminders.

<a id="memory--forgetting"></a>
## Memory & forgetting

| Layer | Holds | Lifecycle | Used for |
|---|---|---|---|
| **L0 working set** | screen-activity digests, last ~90 min | auto-expiring, capped | knowing what you are doing *right now* |
| **L1 facts** | stable facts from chat + screen | strength decay, fades when unused | retrieval, raw material for L2 |
| **L2 core** | `data/memory/MEMORY.md` | rewritten by Dream | injected every turn; hand-editable |
| **L3 archive & graph** | Dream snapshots, forgetting log, entity graph | retained for audit | auditability, entity recall |

Strength = importance × usage gain × exponential decay. Being retrieved strengthens a fact; unused facts *fade* (kept, revivable — not deleted); over capacity the weakest are evicted first; **every fade and deletion is written to `memory/forgetting.md` with its reason**. You can protect, revive, or explicitly forget anything. Memory profiles (`off · light · standard · deep`) choose how much of this runs at all.

<a id="quick-start"></a>
## Install

**macOS installer (recommended, universal binary — Apple Silicon + Intel):** grab `Echo-0.1.0-alpha.2-macos.dmg` from [Releases](https://github.com/Lazarus-coder/echo-assistant/releases), open it, double-click **Install Echo.command**. It installs `Echo.app` + the service into `~/Library/Application Support/Echo`, registers launchd, and asks for your endpoint/key (skippable — the wizard covers it). Uninstall with the bundled `Uninstall Echo.command`.

**From source** (macOS, Node ≥ 20):

```bash
git clone https://github.com/Lazarus-coder/echo-assistant.git && cd echo-assistant
./install.sh          # credentials + launchd services + menu-bar build
./bin/echo status     # process / health / LAN URL / memory & proactivity
./bin/echo open       # open the chat window
```

| Command | What it does |
|---|---|
| `./bin/echo up / down / restart` | start / stop / restart the service |
| `./bin/echo logs` | tail logs |
| `./bin/echo dream` | consolidate memory + run forgetting now |
| `./bin/echo say` | ask it once whether to proactively speak |
| `./bin/echo diag` | self-report: latency, failures, tool success, **engagement rate**, storage |
| `./bin/echo forget` | what has faded or been forgotten, and why |
| `./bin/echo auth on\|off` | require a password or not (off by default) |
| `./bin/echo selftest [--live]` | frozen evaluator (sandboxed; `--live` calls the model) |

Phone access: open `http://<mac-lan-ip>:8787` on the same Wi-Fi → “Add to Home Screen”. Turn on `./bin/echo auth on` on untrusted networks.

<a id="permissions"></a>
## Permissions & residency

Full guide: [docs/permissions.md](docs/permissions.md). Short version: **everything is off by default** — no password, no screen capture, no notifications. The installer registers two launchd agents (`com.echo.chat`, `com.echo.menubar`); screen awareness (the input to proactive decisions) needs one macOS Screen Recording grant, offered from the menu-bar icon.

## Data & disk

```
data/
  echo.env              keys (0600) — never in config, never in git
  conversations/*.json  messages, tool traces, usage, rolling digest
  memory/               MEMORY.md · observations.jsonl · working.jsonl · graph.json
                        forgetting.md · engines.json · dreams/ (audit)
  uploads/              images you send and images generated
  metrics.jsonl         self-report (latency, failures, engagement)
```

Budgets are enforced (`config.json → storage`): screenshots 200 MB / 3 days, generated images 300 MB / 60 days, pruning oldest-first past 80 %, never deleting images referenced by recent conversations. Maintenance runs every six hours and at boot; *Settings → 隐私兜底* has a one-click “forget everything”.

## Self-improvement

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
                    search · media · mcp · storage · metrics · tools
public/             single-page front end (no build step, no deps)
menubar/            Swift menu-bar app (source + icon generator)
tests/selftest.mjs  frozen evaluator (isolated sandbox)
bin/echo            CLI        install.sh / scripts/macos  installers & DMG
docs/               landscape · rsi-log · permissions · release notes
```

## License

No license file yet — all rights reserved by default. Open an issue if you want to reuse it and we will pick one (MIT/Apache-2.0 are the usual candidates).