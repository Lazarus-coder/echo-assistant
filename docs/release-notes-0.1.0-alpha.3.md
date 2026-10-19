# Echo v0.1.0-alpha.3 — companion mode & prompt polish

## Download

| File | What it is |
|---|---|
| **Echo-0.1.0-alpha.3-macos.dmg** | **macOS installer** — universal binary (Apple Silicon + Intel), macOS 13+; `Echo.app` + double-click installer + uninstaller + README (中文/EN) |
| Echo-0.1.0-alpha.3-macos.zip | same payload as a zip, if you prefer |
| echo-assistant-0.1.0-alpha.3.tar.gz | source tarball (any platform, needs Node ≥ 20) |
| SHA256SUMS / SHA256SUMS-macos | checksums — `shasum -a 256 -c SHA256SUMS-macos` |

---

## What's new

### Companion mode (opt-in, off by default)

Proactive agency is about *timing*; companion mode is about *presence*. Turn it on and Echo watches along with you — capture frequency goes from minutes to **seconds** — and occasionally floats a **bubble** in the corner of your screen. Not a notification, not a window that steals focus: a small card that fades on its own unless you hover. Click it and a **small chat window** opens on that exact topic, with its own conversation you can keep talking in.

Scenarios, each with its own voice: **chatting** (reads the thread, judges tone/relationship, offers a copyable line) · **watching a film or video** (watches along as a friend — one feeling, one piece of trivia, no lecture) · **working** (one concrete suggestion: next step, easy-to-miss detail, number to double-check) · **writing code** (an API detail, an edge case, a shorter way).

Discipline that keeps it from becoming a nag:

- **Change detection first** — if the screen looks the same as the last frame, nothing is sent to the model at all. That is what makes watching every 20 seconds affordable and what stops it repeating itself.
- **Budget, gap, back-off** — bubbles per hour, a minimum gap between them, and three dismissals in a row silence it for a while.
- **Never steals focus** — bubbles expire on their own, hover pauses the timer, and the menu bar has an instant *pause 30 minutes*.
- **Same privacy posture as screen awareness** — on-device OCR, text only, screenshots deleted after analysis, block-list respected, opt-in only.

Bubbles carry their own reasoning: the card is one line, and the conversation it opens starts with *why* it thought that was worth saying. Opening and dismissing both feed the self-report.

### Prompt polish (⌘⇧P)

Type the half-sentence you actually have — "那个部署脚本老是超时，帮我看看" — and hit polish. A small chain-of-thought pass reads the conversation tail, the recalled facts that genuinely overlap your draft, and what you're doing right now, then guesses your intent, lists the gaps, and rewrites the request at a usable granularity. Modes: **expand / keep / tighten**. You see the intent, the gaps and the assumptions (all editable) and either replace your draft or send directly.

Your input is never silently rewritten, and it will not invent objects: if the draft is too vague it asks *you* what to look at instead of guessing from memory. A deterministic guard re-runs without memory if a memory-only name ever leaks into the text.

### Fixes

- **`pausedUntil` was compared as a string against a timestamp** — pausing companion mode (and the automatic back-off) did nothing at all. Now: a paused frame returns `skipped: paused`.
- **Throttled companion frames polluted the change-detection baseline** — a frame skipped for budget/gap used to become the comparison baseline, so the same screen (e.g. sitting in a chat window) was permanently judged "unchanged" and never got another chance. Only frames actually judged by the model update the baseline now.
- Multi-file Swift build (`main.swift`) and unbuffered stdout so launchd logs land in real time.
- Missing README anchors, plus repo metadata in English.

### Verification

- **Offline suite: 95/95** (`node tests/selftest.mjs` — sandboxed, own data dir + config)
- **Live suite: 104/104** (`--live`: real chat, search, vision, image generation, entity graph, event replay)
- New **J track (11 checks)** covers the companion pipeline end to end: change detection without a model call, budget, gap, per-scenario switches, dismiss back-off, pause, bubble→conversation, and metrics.
- The macOS package is verified by the build script itself: mount the DMG → install into a temporary `HOME` → run the evaluator **from the installed copy** → assert `echo.env` is mode 600.

### Known limitations (unchanged)

Screen Recording must be granted once from the menu-bar icon; scrape search can be rate-limited (circuit breaker cools down and hands off); video / ASR / TTS depend on your endpoint; retrieval is lexical plus an entity graph (no embeddings); the app is unsigned, so macOS asks once — right-click → Open, or strip the quarantine flag yourself. Interfaces and data formats may still change during alpha — back up `data/` before upgrading.