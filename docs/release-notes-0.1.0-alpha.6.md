# Echo v0.1.0-alpha.6 — proactive research, and a quieter kind of awareness

Two lines of work land in this release: Echo can now **research things it noticed you need** — read-only, budgeted, cancellable — and it can hold **a restrained sense of who you're talking to**. Plus the product now keeps a written record of *why* it is shaped the way it is.

## Download

| File | What it is |
|---|---|
| **Echo-0.1.0-alpha.6-macos.dmg** | **macOS installer** — universal binary (Apple Silicon + Intel), macOS 13+; `Echo.app` + installer + uninstaller + README. **Runtime dependencies are bundled** (MCP SDK + PDF.js) — installing works offline |
| Echo-0.1.0-alpha.6-macos.zip | same payload as a zip, if you prefer |
| echo-assistant-0.1.0-alpha.6.tar.gz | source tarball (any platform, **Node ≥ 22.13** + npm; `./install.sh` runs `npm ci` for you) |
| SHA256SUMS / SHA256SUMS-macos | checksums — `shasum -a 256 -c SHA256SUMS-macos` |

---

## What's new

### Noticing a need, then studying it — under supervision

- **Discovery** (`lib/discovery.mjs`): background research is a separate switch you turn on explicitly. Echo finds candidate goals in *new* conversations, always citing the real user message, records what's missing (institution / programme / cycle / category / stage), de-duplicates, and keeps inferred cases for a **seven-day** confirmation window. An explicit completion message can close the matching goal and stop its reminders. Discovery is capped at 20 model calls per day; preparation at two attempts per goal and five per rolling 24 hours.
- **Research reuses the existing harness** (`lib/research.mjs`): searches, web pages, PDFs, explicitly attached documents and selected folders inside the enabled workspace — with a **read-only tool allowlist**, bounded calls and time, and **no background Shell, MCP, or external writes**. Runs keep their records, evidence, budgets and cancellation like any other run.
- **Deadlines are checked item by item** (`lib/deadlines.mjs`): the quoted source text, the identity it applies to, the full date, when it was checked, and any conflict are all kept. Only member-confirmed official domains may support a "verified" date, and a date-only source never implies a precise time or timezone.
- **Durable follow-up**: date and source watches run together, failures retry, successful checks update the watch, footer-only changes are filtered out, milestones distinguish approaching / due-today / overdue, and stale evidence is withheld instead of being delivered.

### A restrained sense of relationships

Expand **Memory → 相处方式** to pick a tone (subtle by default, warm, direct) and whether you prefer listening or practical help. You may optionally keep a preferred name, communication boundaries and short notes for **up to 12 people**, hand-maintained. Echo uses at most three matching people when you mention them, or when a short follow-up refers to the immediately preceding message; current requests always outrank saved preferences.

What it deliberately does **not** do: no emotion profiles, no mood reminders, no psychological inference from your screen. `lib/relationships.mjs` stores only what you wrote.

### Isolation, where untrusted input arrives

`lib/pdf.mjs` parses PDFs **in a worker thread** with the viewer and scripting layer off, capped at 5 MB / 40 pages / 15 seconds per document, so a malformed file can't stall the service. (Scanned PDFs without a text layer are reported as unreadable rather than guessed at.)

### The product now explains itself

[docs/product-journey.md](https://github.com/Lazarus-coder/echo-assistant/blob/main/docs/product-journey.md) records every phase of shaping this product from the very first request to now: what was decided, why, what was rejected — plus ten principles that carried across phases, and the open gaps. It is **required to be updated with every release**: the packager refuses to build when its `覆盖版本` line lags behind `package.json`.

## Requirements changed

**Node ≥ 22.13** (was 20) — required by the PDF.js parser. `./install.sh` and the DMG installer both check it and explain what to do. Runtime dependencies are now `@modelcontextprotocol/sdk` + `pdfjs-dist`, both pinned in `package-lock.json` and **bundled inside the DMG** (46 MB) so a drag-install still needs no network.

## Verification

- **Frozen evaluator: 98/98** (`node tests/selftest.mjs`) — unchanged design invariants, nothing loosened
- **Regression suites: all green** (`npm run test:regressions`), now including relationships (×4), discovery, commitment-research, research (×2) and proactive UI — **65 new checks** in the proactive area alone
- **Packaging**: source tarball → `npm ci` → evaluator passes inside it; DMG mounted → installed into a temporary `HOME` → evaluator passes **from the installed copy** → `echo.env` asserted mode 600 → bundled MCP dependency present
- Every asset re-downloaded from this page and checksum-verified before this note was published

## Known limitations (kept honest)

Research quality and miss rate have **not** been evaluated against real usage — no productivity claim is made. Nothing connects automatically to your browser, mail or calendar, and nothing is checked while the Mac is asleep. Approvals remain the safety net for anything that writes or runs; read them. Screen Recording is still granted once per app identity — install from the DMG rather than rebuilding to avoid being asked again. Interfaces and data formats may still change during alpha — back up `data/` before upgrading.