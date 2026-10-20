# Echo v0.1.0-alpha.5 — from talking to doing

Echo grew hands — carefully. This release adds a **controlled workspace execution layer**, a **run harness with human approvals**, **commitment tracking**, and moves MCP onto the **official SDK**. Dependencies now ship inside the DMG, so installing no longer requires fetching anything.

## Download

| File | What it is |
|---|---|
| **Echo-0.1.0-alpha.5-macos.dmg** | **macOS installer** — universal binary (Apple Silicon + Intel), macOS 13+; `Echo.app` + installer + uninstaller + README. **Includes locked runtime dependencies** — installing works offline |
| Echo-0.1.0-alpha.5-macos.zip | same payload as a zip, if you prefer |
| echo-assistant-0.1.0-alpha.5.tar.gz | source tarball (any platform, Node ≥ 20 + npm: `./install.sh` runs `npm ci` for you) |
| SHA256SUMS / SHA256SUMS-macos | checksums — `shasum -a 256 -c SHA256SUMS-macos` |

---

## What's new

### Workspace harness — doing, with permission

- **Workspace execution** (`lib/workspace.mjs`): file reads/writes and command runs scoped to a validated workspace root — path-escape checks, 1 MB read / 2 MB output caps, serialized writes, and abort propagation that reaches the child process.
- **Run orchestration** (`lib/harness.mjs`): every task becomes a run under `data/runs/<id>/run.json` with a real state machine (`completed / failed / cancelled / interrupted`). Anything that writes, runs, or leaves the machine goes through an **approval** — single-use, survives a failed attempt so you can retry with the error visible, and cannot be re-approved once the run is terminal. Restarting Echo never replays finished work; in-flight approvals expire cleanly as *interrupted*.
- **Cancellation end to end**: stopping a run propagates through search, the gateway's hosted search, image generation (before and during the asset download), web fetches (body and DNS), and local file writes — each with its own regression case. Cancelled work makes no further network requests and never leaves a partial file.

### Commitment tracking

`lib/commitments.mjs` reads conversations for things *you* said you would do — not the assistant's to-do list, yours — and keeps them with a background worker and an API. It is the same idea as the follow-up ledger in proactive mode, but first-class, inspectable, and editable.

### MCP on the official SDK

The hand-rolled JSON-RPC client is gone: `lib/mcp.mjs` now uses `@modelcontextprotocol/sdk` (stdio + Streamable HTTP, pinned to 1.32.1 via `package-lock.json`). That means standards-compliant transports, but it also means the app has **one runtime dependency** — and this release treats that as a packaging problem, not the user's problem:

- `./install.sh` runs `npm ci --omit=dev --ignore-scripts` **before** touching the service, and refuses to proceed if the dependency install fails;
- the **DMG bundles `node_modules`** (16 MB dmg), so a drag-and-install works offline; the packaging script asserts the vendored dependency actually imports and that the installed copy contains it;
- the source tarball must contain `package-lock.json` — the packager now **refuses to publish without it**.

### Also

- `lib/attention.mjs`: quiet hours / local-date logic shared instead of duplicated across features.
- Front end and menu bar grew the surfaces for runs, approvals, artifacts, goals and commitments; mini window and menu-bar states kept in sync.

## Verification

- **Frozen evaluator: 98/98** (still the same 98 design invariants — the new work did not loosen a single one)
- **Regression suites: 12 files, all green** (`npm run test:regressions`) — frontend, backend, companion, commitments (API + logic), agency, workspace, MCP, harness ×3, cancellation
- **Packaging**: source tarball extracted → `npm ci` → evaluator passes inside it; DMG mounted → installed into a temporary `HOME` → evaluator passes **from the installed copy** → `echo.env` asserted mode 600 → vendored MCP dependency present
- Every asset re-downloaded from this page and checksum-verified

## Known limitations

Unchanged from alpha.4: Screen Recording is granted once per app identity (roads: install from the DMG, don't rebuild); scrape search can be rate-limited by its engines; video / ASR / TTS depend on your endpoint; retrieval is lexical plus an entity graph; the app is unsigned (macOS asks once — right-click → Open). Approvals are the safety net for the new execution features: read them before approving, especially anything that writes files or runs commands. Interfaces and data formats may still change during alpha — back up `data/` before upgrading.