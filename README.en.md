# Echo · a private chat window that runs on your own Mac

Echo is a local-first personal assistant: it talks to your own model API (any OpenAI-compatible endpoint), stays resident on your Mac, remembers you in layers, **forgets on purpose**, speaks up when it's worth it, and can glance at your screen — locally.

Design goals: **light, controllable, explainable.** Zero npm dependencies (Node built-ins + one locally compiled Swift menu-bar app). Everything lives in `data/` as plain text you can read, back up, or delete.

> 中文完整版：[README.md](README.md) · Landscape & design trade-offs (with sources): [docs/landscape.md](docs/landscape.md) · Self-improvement log: [docs/rsi-log.md](docs/rsi-log.md)

---

## What makes it different

Echo borrows the good parts of existing work — Letta/MemGPT's memory blocks and sleep-time rewriting, Mem0's extract-then-reconcile writes, Zep's entity graph retrieval, screenpipe's local-first context — and spends its effort on a few things that are rare in the field:

1. **Forgetting is a first-class, explainable feature.**
   Strength = importance × usage gain × exponential decay. Being retrieved strengthens a fact (spaced-repetition style); unused facts *fade* (not deleted — revivable); over capacity, the weakest are evicted. Every fade and deletion is written to `memory/forgetting.md` with the reason and the numbers behind it. You can protect, revive, or explicitly forget anything.
   *"We are not what we remember, but what we forget."*

2. **Proactivity is a measurable closed loop.**
   Thompson-sampling bandit picks *which kind* of nudge to send (reward = you engaged; a 6-hour silence settles as 0), thresholds adapt per kind, a deterministic EV ranking picks *which follow-up* to raise, and gates (quiet hours, daily budget, minimum gap, back-off after being ignored) decide *whether* to speak. Engagement rate is visible in the self-report. In offline replay it beats a fixed rotation by 31–51%.

3. **Screen awareness as "understand now, don't archive".**
   The menu-bar app captures periodically, runs **on-device OCR** (Apple Vision) and sends *text only* — screenshots are deleted right after analysis, the working set has a TTL, and disk budgets are hard. That is a deliberate alternative to "record everything into a searchable history".

4. **Zero dependencies, fully auditable state.**
   0 npm packages, no vector DB, no database. Memory is `MEMORY.md` + `observations.jsonl`; open any file and see exactly what it knows and why.

5. **Budgeting and resilience as engineering, not afterthoughts.**
   Disk budgets for screenshots and images (prune oldest past 80% of budget; never delete images still referenced by recent chats), a search-engine **circuit breaker** (cooldowns instead of hammering), a **model fallback chain**, context budgeting with rolling digests, and a `metrics.jsonl` self-report (P50/P95 latency, tool success rates, top failures, engagement rate).

6. **A frozen evaluator and an RSI discipline.**
   60 assertions in `tests/selftest.mjs` run inside an isolated sandbox (own data dir + config), covering security invariants (SSRF/CSRF/XSS), memory/forgetting math, storage budgets, decision algorithms and live end-to-end paths. Iterations are logged in `docs/rsi-log.md`; the score sheet is only ever tightened, never loosened.

Honest limitations are documented too: no embedding/vector retrieval, the entity graph has no bi-temporal validity, the bandit has no context features, screen awareness samples rather than streams.

---

## Quick start

```bash
./install.sh          # one-shot: credentials, password (optional), launchd services, menu-bar build
./bin/echo status     # process / health / LAN URL / memory & proactivity overview
./bin/echo open       # open the chat window
./bin/echo selftest   # run the frozen evaluator in an isolated sandbox
```

After install, Echo starts at login, restarts when it crashes, and shows up in the menu bar.

| Command | What it does |
|---|---|
| `./bin/echo up / down / restart` | start / stop / restart the service |
| `./bin/echo logs` | tail logs |
| `./bin/echo dream` | run memory consolidation + forgetting now |
| `./bin/echo say` | ask it once whether to proactively speak |
| `./bin/echo diag` | self-report: latency, failures, tool success, storage, memory, graph |
| `./bin/echo forget` | show what has faded/been forgotten and why |
| `./bin/echo remember <text>` | write a fact into L1 memory |
| `./bin/echo auth on\|off` | require a password or not (off by default; loopback-only for management) |
| `./bin/echo search <query>` | test the search chain and engine health |
| `./bin/echo mcp` | reload MCP servers |
| `./bin/echo selftest --live` | full suite including real chat/search/vision/image calls |

Phone access: open `http://<mac-lan-ip>:8787` on the same Wi-Fi (no login by default) → "Add to Home Screen" for an app-like window. Turn on `./bin/echo auth on` on untrusted networks.

---

## Architecture

### Layered memory (L0 → L3)

| Layer | Holds | Lifecycle | Used for |
|---|---|---|---|
| **L0 working set** | screen-activity digests from the last ~90 min | auto-expiring, capped at 400 rows | knowing "what you're doing right now" for chat + proactivity |
| **L1 facts** | stable facts extracted from chat and screen | strength decay, fades when unused | retrieval, and raw material for long-term memory |
| **L2 core** | `data/memory/MEMORY.md` | rewritten by Dream | injected into every turn; you can edit it by hand |
| **L3 archive & graph** | Dream snapshots, forgetting log, entity graph | retained for audit | auditability, entity recall |

### Forgetting engine

- Half-life grows with importance; retrieval hits strengthen (log-scaled);
- Below threshold and older than a minimum age → **fade** (excluded from retrieval, kept on file);
- Exceeding capacity → evict weakest first;
- Every fade/deletion logs *what*, *why*, and *the numbers* to `memory/forgetting.md`;
- Protections, revival, and user-driven "forget this" are first-class actions (API + UI).

### Dream (sleep-time consolidation)

Scheduled while you're idle (plus a manual button): rewrites core memory, reconciles facts (ADD/UPDATE/DELETE), explicitly forgets stale items with reasons, revives wrongly-faded ones, produces follow-up ledger entries and nudge topics, refreshes the entity graph, and writes an audit snapshot.

### Proactivity

Decision layer as described above; message types `follow_up / suggest / guide / ask / brief`; proactive messages land in a persistent **main conversation** that survives model switches; macOS notifications; per-kind engagement posteriors shown in the UI.

### Screen awareness (off is a first-class state)

Capture happens in the Swift menu-bar app; OCR is on-device; images never leave the machine by default; capture is skipped when the screen is locked or the keyboard/mouse has been idle. The app-block list defaults to **empty** — it's your machine, you decide (set it in Settings or `config.json`). Screenshots are deleted right after analysis and are covered by disk budgets either way; if the model judges content sensitive, only "handling sensitive information" is recorded and no facts are written.

### Multimodal support on this gateway

| Capability | Implementation | Measured |
|---|---|---|
| Scrape search | 360/Bing in parallel (full browser headers) + circuit breaker | 0.5–2.5s when healthy; throttled engines cool down and hand over |
| Hosted search | Responses `web_search` with `tool_choice:"required"` + thinking off | **3–8s** with sources (without forcing the tool call it "fake-searches" in 0.6s) |
| MCP | Hand-rolled stdio/HTTP JSON-RPC client; Aliyun-hosted MCP via Responses `tools:[{type:'mcp'}]` | plug in any server in `config.json` |
| Vision input | paste / drag / upload, client-side downscale | verified (reads colors correctly) |
| Image generation | `image_gen` tool + a "draw" button; results **saved locally** (OSS URLs expire) | qwen-image-3.0-pro / wan2.7-image |
| Video / ASR / TTS | not exposed on this gateway (measured `url error` / empty body / InternalError) | reserved in config |

---

## Data & disk

```
data/
  echo.env              credentials (0600, never logged or sent to the model)
  auth.json             scrypt-hashed password + sessions (only when auth is on)
  local.token           loopback-only token for the menu-bar app and CLI
  conversations/*.json  conversations (messages, tool traces, usage, digest)
  memory/               MEMORY.md · observations.jsonl · working.jsonl · graph.json
                        forgetting.md · engines.json · dreams/ (audit snapshots)
  uploads/              images you send and images generated
  metrics.jsonl         self-report data
  logs/
```

Storage is budgeted (`config.json → storage`, also editable in the UI): screenshots 200MB / 3 days, generated images 300MB / 60 days, pruning oldest-first past 80% of budget, **never deleting images referenced by conversations from the last 45 days**. Maintenance runs every 6 hours and at boot.

## Security

- **Password off by default** (local personal use). Write operations still require a custom request header, which a hostile web page cannot forge — that's what protects your API quota from cross-site calls to localhost;
- `./bin/echo auth on` enables the password flow (HttpOnly + SameSite=Strict sessions; first-time setup is loopback-only);
- `web_fetch` blocks loopback/RFC1918/link-local/cloud-metadata/ULA targets while allowing the fake-IP range local proxies use;
- Model output is escaped through a whitelist renderer: no `<script>`, event attributes, or `javascript:` URLs survive;
- Management endpoints (menu bar / CLI) accept only loopback requests carrying `x-echo-local`.

## Self-improvement

`tests/selftest.mjs` is a *frozen* evaluator: assertions target design invariants, not implementation details, and the suite runs in an isolated sandbox (its own data dir and config). Four offline tracks plus live and decision-algorithm tracks, 60 checks total. Iteration history — hypotheses, changes, scores, verdicts, lessons — is in [docs/rsi-log.md](docs/rsi-log.md).

## Repo layout

```
server.mjs          HTTP server: auth, SSE, routes, schedulers
lib/                chat · context (budget/digest) · memory (layers/forgetting) · graph
                    screen · dream · proactive · agency (bandit/ledger) · search · media
                    mcp · storage (budgets) · metrics · upstream · native · tools
public/             single-page front end (no build step, no deps)
menubar/            Swift menu-bar app source
tests/selftest.mjs  frozen evaluator (isolated sandbox)
bin/echo            CLI        install.sh    launcher + launchd registration
```