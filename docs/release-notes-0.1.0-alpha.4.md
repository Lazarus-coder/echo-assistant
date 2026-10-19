# Echo v0.1.0-alpha.4 — less interruption

A small release that exists because of one piece of feedback: *"it asks for permission again every time, and the interruptions are too much."* Both halves were real bugs, and both are fixed.

## Download

| File | What it is |
|---|---|
| **Echo-0.1.0-alpha.4-macos.dmg** | **macOS installer** — universal binary (Apple Silicon + Intel), macOS 13+; `Echo.app` + double-click installer + uninstaller + README (中文/EN) |
| Echo-0.1.0-alpha.4-macos.zip | same payload as a zip, if you prefer |
| echo-assistant-0.1.0-alpha.4.tar.gz | source tarball (any platform, needs Node ≥ 20) |
| SHA256SUMS / SHA256SUMS-macos | checksums — `shasum -a 256 -c SHA256SUMS-macos` |

---

## What was wrong, and what changed

### 1. The same bubble kept coming back

When a bubble auto-faded after 12 seconds it stayed in the server's *pending* queue, so the next poll (every 20 seconds) floated it again — the same card, over and over. Now:

- auto-fade marks the bubble **`expired`** — it never reappears, and it does **not** count toward the "you kept ignoring me" back-off (you didn't reject it, you just didn't look);
- `/api/companion/pending` accepts `since=<timestamp>`, and the menu-bar app only asks for bubbles **created after it started** — so restarting Echo no longer resurrects old cards.

### 2. macOS kept asking for Screen Recording

Screen Recording is granted **per app identity**. The menu-bar app was running from a path that got rebuilt during development, and an unsigned binary that changes is — as far as macOS is concerned — a different app. Fixes:

- the app now installs to a **fixed path** (`~/Library/Application Support/Echo/Echo.app`) with a fixed bundle id, **ad-hoc signed** by the installer and by the packaging script;
- `./install.sh` **skips rebuilding the binary** when an installed app is present (rebuilding is what triggers the re-prompt; the docs now say so plainly);
- Echo **never initiates a permission dialog**: without the grant it skips captures, logs that fact, and shows a single ⚠️ item in the menu — nothing pops up until you click it.

### 3. Quiet by default

Screen awareness and companion mode are both **off** in this release's defaults (they had been switched on during testing). Turn either on from *Settings* or the menu-bar menu when you actually want it.

## Verification

- **Offline suite: 98/98** — including three new lifecycle checks: an expired bubble is not re-presented, expiry does not feed the dismiss back-off, and `pending?since=` filters correctly.
- **Live suite: 104/104** (`--live`).
- The DMG is verified by its own build script: mount → install into a temporary `HOME` → run the evaluator from the installed copy → assert `echo.env` is mode 600.

Read the longer story in [docs/permissions.md](https://github.com/Lazarus-coder/echo-assistant/blob/main/docs/permissions.md) (§2b–2c) and the iteration log ([docs/rsi-log.md](https://github.com/Lazarus-coder/echo-assistant/blob/main/docs/rsi-log.md)).

Everything else is unchanged from alpha.3: companion mode, prompt polish (⌘⇧P), layered memory with explainable forgetting, proactive bandit loop, BYOK onboarding, pluggable search. Interfaces and data formats may still change during alpha — back up `data/` before upgrading.