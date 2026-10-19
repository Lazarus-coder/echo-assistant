<div align="center">

# Echo

> We are not what we remember, but what we forget.

![Local-first](https://img.shields.io/badge/local--first-yes-2f6f57?style=flat-square)
![Zero dependencies](https://img.shields.io/badge/npm%20dependencies-0-2f6f57?style=flat-square)
![BYOK](https://img.shields.io/badge/BYOK-own%20API%20key-2f6f57?style=flat-square)
![macOS](https://img.shields.io/badge/macOS-Homebrew%20Node%20%E2%89%A520-2f6f57?style=flat-square)
![Status](https://img.shields.io/badge/status-alpha-orange?style=flat-square)

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#why-echo">Why Echo</a> ·
  <a href="#memory--forgetting">Memory</a> ·
  <a href="#search-providers">Search</a> ·
  <a href="#first-run-byok-onboarding">Onboarding</a> ·
  <a href="#permissions">Permissions</a> ·
  <a href="docs/landscape.md">Landscape</a> ·
  <a href="docs/rsi-log.md">Self-improvement log</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center"><em>A private chat window that lives on your Mac.<br />
Your own model endpoint (BYOK), layered memory that <b>forgets on purpose</b>,
an assistant that speaks up only when it matters, and screen awareness that never leaves the machine.</em></p>

</div>

---

Echo is a local-first personal assistant. It talks to any OpenAI-compatible endpoint you point it at, stays resident via `launchd`, keeps its menu-bar icon in your status bar, and stores everything it knows as plain files under `data/` that you can read, back up, or delete.

Built with **zero npm dependencies**: Node built-ins on the server, one page of vanilla JS in the browser, and a small Swift menu-bar app compiled locally.

> 中文版：[README.zh-CN.md](README.zh-CN.md) · Design trade-offs vs. existing work (with sources): [docs/landscape.md](docs/landscape.md) · Permissions & residency: [docs/permissions.md](docs/permissions.md)

<a id="why-echo"></a>
## Why Echo

Echo borrows the good parts of existing work — Letta/MemGPT's memory blocks and sleep-time rewriting, Mem0's extract-then-reconcile writes, Zep's entity graphs, screenpipe's local-first context — and spends its effort on a few things that are rare in the field.

**1. Forgetting is a first-class, explainable feature.**
Strength = importance × usage gain × exponential decay. Being retrieved strengthens a fact (spaced repetition); unused facts *fade* — not deleted, revivable; over capacity the weakest are evicted first. Every fade and deletion is written to `memory/forgetting.md` with the reason and the numbers behind it. You can protect, revive, or explicitly forget anything, and the assistant can explain what it dropped and why.

**2. Proactivity is a measurable closed loop.**
Thompson-sampling bandit picks *which kind* of nudge to send (reward = you engaged; a six-hour silence settles as 0), thresholds adapt per kind, a deterministic EV ranking picks *which follow-up* to raise, and gates (quiet hours, daily budget, minimum gap, back-off after being ignored) decide *whether* to speak at all. Engagement rate is visible in the self-report; offline replay beats a fixed rotation by 60–80%.

**3. Screen awareness means "understand now", not "record everything".**
The menu-bar app captures on an interval and runs **on-device OCR** (Apple Vision). By default only the extracted *text* is sent to your model — the image never leaves the machine, the temporary file is deleted right after analysis, and the working set expires. Locked screen, idle keyboard, and anything on your block-list are skipped entirely.

**4. Zero dependencies, fully auditable state.**
No vector database, no orchestration framework, no Docker. Memory is `MEMORY.md` plus `observations.jsonl`; forgetting is a markdown log. Open any file and see exactly what it knows and why.

**5. Budgeting and resilience are engineering, not afterthoughts.**
Disk budgets for screenshots and images (prune oldest past 80% of budget; never delete images still referenced by recent chats), a **circuit breaker** for search engines (cool down instead of hammering), a **model fallback chain**, context budgeting with rolling digests, and a `metrics.jsonl` self-report (P50/P95 latency, tool success rates, engagement rate).

**6. A frozen evaluator.**
60+ assertions in `tests/selftest.mjs` run in an isolated sandbox (its own data dir and config), covering security invariants (SSRF/CSRF/XSS), memory & forgetting math, storage budgets, decision algorithms, BYOK/onboarding, and live end-to-end paths. The score sheet is only ever tightened — iterations are logged in [docs/rsi-log.md](docs/rsi-log.md).

<a id="quick-start"></a>
## Quick start

```bash
git clone https://github.com/Lazarus-coder/echo-assistant.git && cd echo-assistant
./install.sh          # credentials + launchd services + menu-bar build
./bin/echo status     # process / health / LAN URL / memory & proactivity
./bin/echo open       # open the chat window
```

On first launch the app walks you through **BYOK setup** (endpoint → key → models → memory profile → search chain → permissions). You can also skip it and configure `data/echo.env` yourself.

Requirements: macOS and Node ≥ 20. `swiftc` (Xcode Command Line Tools) is only needed for the menu-bar icon.

| Command | What it does |
|---|---|
| `./bin/echo up / down / restart` | start / stop / restart the service |
| `./bin/echo logs` | tail logs |
| `./bin/echo dream` | run memory consolidation + forgetting now |
| `./bin/echo say` | ask it once whether to proactively speak |
| `./bin/echo diag` | self-report: latency, failures, tool success, storage, memory, graph |
| `./bin/echo forget` | show what has faded or been forgotten, and why |
| `./bin/echo remember <text>` | write a fact into memory |
| `./bin/echo auth on\|off` | require a password or not (off by default) |
| `./bin/echo search <query>` | test the search chain and engine health |
| `./bin/echo selftest [--live]` | run the frozen evaluator (sandboxed; `--live` calls the model) |

Phone access: open `http://<mac-lan-ip>:8787` on the same Wi-Fi (no login by default) → “Add to Home Screen”. Turn on `./bin/echo auth on` on untrusted networks.

<a id="memory--forgetting"></a>
## Memory & forgetting

| Layer | Holds | Lifecycle | Used for |
|---|---|---|---|
| **L0 working set** | screen-activity digests from the last ~90 min | auto-expiring, capped | knowing what you are doing *right now* |
| **L1 facts** | stable facts extracted from chat and screen | strength decay, fades when unused | retrieval, raw material for long-term memory |
| **L2 core** | `data/memory/MEMORY.md` | rewritten by Dream | injected into every turn; hand-editable |
| **L3 archive & graph** | Dream snapshots, forgetting log, entity graph | retained for audit | auditability, entity recall |

**Dream** runs while you are idle (or on demand): rewrites core memory, reconciles facts (ADD/UPDATE/DELETE), explicitly forgets stale items with reasons, revives wrongly-faded ones, produces a follow-up ledger and nudge topics, refreshes the entity graph, and writes an audit snapshot.

Memory profiles (chosen in onboarding, changeable later): `off` (no memory at all), `light` (facts only, no Dream / no proactivity / no screen), `standard` (facts + Dream + proactivity), `deep` (standard + screen awareness).

<a id="search-providers"></a>
## Search providers (pluggable)

Search is a chain you configure, not a hard-coded engine. Selected providers are tried in order; a failure (rate limit, missing key) hands off to the next one. Providers that need a key read it from an environment variable in `data/echo.env` — keys never enter `config.json` or git.

| Provider | Needs | Notes |
|---|---|---|
| `none` | — | explicitly offline |
| `scrape` | — | zero-config scraping of CN engines; fastest, can be rate-limited (circuit breaker cools it down) |
| `gateway` | — | reuses your model endpoint's hosted search (Responses API `web_search`, 3–8 s, returns sources) |
| `tavily` | `TAVILY_API_KEY` | LLM-oriented search API with answer synthesis |
| `brave` | `BRAVE_API_KEY` | independent index, privacy-friendly |
| `bocha` | `BOCHA_API_KEY` | strong Chinese results |
| `searxng` | `SEARXNG_URL` | your own instance (recommended if you self-host) |
| `custom` | — | any HTTP endpoint returning `{results:[{title,url,snippet}]}`; method/headers/body template configurable |

The default chain is `scrape → gateway` (both keyless). The first-run wizard and *Settings → 联网搜索* edit the same chain.

<a id="first-run-byok-onboarding"></a>
## First-run BYOK onboarding

Six steps, each one decision:

1. **Endpoint** — pick a preset (OpenAI, Aliyun Bailian, DeepSeek, Moonshot, OpenRouter, Ollama, custom) or paste a base URL, then *Test & fetch models*.
2. **Models** — default model, background/utility model, optional image model (leave empty to disable the image tool).
3. **Memory profile** — off / light / standard / deep, with a one-line explanation of each.
4. **Search chain** — tick providers, add instance URLs or keys where required.
5. **Permissions** — residency check, `swiftc`, bind address, optional password, screen-recording test.
6. **Done** — writes keys to `data/echo.env` (mode 600) and choices to `config.json`, then you can chat.

Re-runnable any time from *Settings → 引导与权限*.

<a id="permissions"></a>
## Permissions & residency

Full guide (screen recording, notifications, launchd, network exposure, files on disk): [docs/permissions.md](docs/permissions.md).

Short version: **off by default** — no password, no screen capture, no notifications. `./install.sh` registers two launchd agents (`com.echo.chat`, `com.echo.menubar`) so it starts at login and survives crashes. Screen awareness needs macOS Screen Recording consent, granted from the menu-bar icon.

## Data & disk

```
data/
  echo.env              keys (0600, never in git, never sent to the model)
  conversations/*.json  messages, tool traces, usage, rolling digest
  memory/               MEMORY.md · observations.jsonl · working.jsonl · graph.json
                        forgetting.md · engines.json · dreams/ (audit)
  uploads/              images you send and images generated
  metrics.jsonl         self-report data
```

Budgets are enforced (`config.json → storage`, editable in the UI): screenshots 200 MB / 3 days, generated images 300 MB / 60 days, pruning oldest-first past 80% of budget, never deleting images referenced by recent conversations. Maintenance runs every six hours and at boot. *Settings → 隐私兜底* has a one-click “forget everything”.

## Self-improvement

Echo does not rewrite its own code. It ships the conservative half of that idea: a **frozen evaluator** (`tests/selftest.mjs`, sandboxed, assertions against design invariants rather than implementation details), a public iteration log with hypotheses, scores, verdicts, and lessons ([docs/rsi-log.md](docs/rsi-log.md)), and a rule that the score sheet is only ever tightened.

## Repo layout

```
server.mjs          HTTP server: routing, SSE, schedulers, auth, onboarding
lib/                chat · context (budget/digest) · memory (layers/forgetting) · graph
                    screen · dream · proactive · agency (bandit/ledger) · providers
                    search · media · mcp · storage · metrics · tools
public/             single-page front end (no build step, no deps)
menubar/            Swift menu-bar app source
tests/selftest.mjs  frozen evaluator (isolated sandbox)
bin/echo            CLI        install.sh    launcher + launchd registration
docs/               landscape · rsi-log · permissions · release notes
```

## License

No license file yet — all rights reserved by default. Open an issue if you want to reuse it and we will pick one (MIT/Apache-2.0 are the usual candidates).