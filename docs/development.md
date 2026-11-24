# Development

[Simplified Chinese](zh-CN/development.md) · [Product overview](../README.md)

## Requirements and source setup

- macOS for the menu-bar app, screen capture, notifications, and launchd integration.
- Node.js 22.13 or newer and npm.
- Xcode Command Line Tools (`swiftc`) to build the menu-bar app from source.

```bash
git clone https://github.com/Lazarus-coder/echo-assistant.git
cd echo-assistant
npm ci --omit=dev --ignore-scripts
```

For a foreground development instance:

```bash
ECHO_BIND=local npm start
```

This uses the checkout's `config.json` and `data/`, binds to loopback, and runs until stopped. Use the environment overrides below for a separate development profile. Startup maintenance runs inside the selected data directory.

To install a persistent source instance, run `./install.sh`. It installs locked dependencies, offers credential setup, registers `com.echo.chat` and `com.echo.menubar` with launchd, and builds the menu-bar app when available. These labels are shared with the packaged installation: running the installer or service controls can affect an existing instance. Rebuilding the app can require a new Screen Recording grant.

### Runtime configuration

| Setting | Purpose |
|---|---|
| `ECHO_DATA_DIR` | Override the runtime data directory; defaults to `data/` in this checkout. |
| `ECHO_CONFIG` | Override the config file; defaults to `config.json` in this checkout. |
| `ECHO_BIND` | New profiles listen on loopback. `all` selects LAN listening on restart. `local` forces loopback. |
| `ECHO_LANGUAGE` | Choose `en` or `zh-CN` for this terminal invocation or as the initial language of a new profile. The app saves subsequent changes through Settings. |
| `ECHO_PORT` | Override the configured port. |
| `ECHO_LOG_LEVEL` | Set `debug`, `info`, `warn`, or `error`. |

The setup wizard writes credentials to the data directory's `echo.env`, with mode `600`. Existing process environment values take precedence. Configure the default and utility models against your own compatible endpoint; image capabilities require suitable models. Search providers are selected independently. See [permissions](permissions.md) for model requests, screen modes, network exposure, and access controls.

Workspace tools and background research have separate permissions. Enabling interactive Shell or MCP tools does not grant those capabilities to background goals.

## Command-line controls

Run `./bin/echo` from the installation you intend to control. These commands target its running service; they are not an isolated test interface.

| Command | Action |
|---|---|
| `./bin/echo status` | Show process, health, and activity information. |
| `./bin/echo open` | Open the chat window. |
| `./bin/echo logs` | Follow service logs. |
| `./bin/echo up`, `down`, `restart` | Start, stop, or restart the installed service. |
| `./bin/echo diag` | Inspect latency, failures, tool results, goal outcomes, and storage. |
| `./bin/echo dream` | Run memory consolidation; may call the configured model. |
| `./bin/echo say` | Run a proactive decision; may call the model and deliver a notification. |
| `./bin/echo forget` | Inspect the forgetting log. |
| `./bin/echo auth on`, `./bin/echo passwd` | Enable password protection and set its password. |

New profiles listen on the Mac's loopback interface. To share Echo on your network, configure password protection and explicitly select `bind: "all"` in the config file or set `ECHO_BIND=all` before restart. If a password is required but has not been set yet, the service starts on loopback. After setting the password, restart to apply the requested LAN binding. Settings and `./bin/echo status` show the running listener. Workspace execution, approvals, and artifacts remain restricted to host connections.

## Tests

Run checks appropriate to the change after reading the isolation notes below. Regression suites use temporary fixtures and mock model/search responses rather than live paid services.

| Command | Coverage |
|---|---|
| `npm run test:regressions` | Full regression chain, including the suites below. |
| `npm run test:harness` | Workspace files, Shell, MCP, approvals, cancellation, persistence, APIs, and UI. |
| `npm run test:relationships` | Response preferences, person notes, API boundaries, and UI. |
| `npm run test:proactive` | Discovery, commitments, research, APIs, and proactive UI. |
| `node tests/server-regressions.mjs` | Malformed Host/request-target responses and continued service availability. |
| `node tests/storage-regressions.mjs` | Failed deletions, age/budget cleanup, retries, and referenced-upload protection. |

The HTTP parsing and cleanup-accounting fixes in current source were added after the published v0.1.0-alpha.6 packages. These checks describe the current checkout, not a claim that the published package contains those fixes.

### Test isolation

Set `ECHO_DATA_DIR` and `ECHO_CONFIG` on each test server. The menu-bar app uses the same data directory for its local token, logs shortcut and capture spool. Both screen capture and the permission probe write temporary JPEGs under `spool/` with directory permissions of `0700`. Successful captures remove their JPEG after local processing. Startup, scheduled and manual maintenance clear recognized capture files older than one hour in this profile.

The offline evaluator, `npm run selftest`, uses a temporary profile and writes its report to the untracked `tests/last-report.json`. `npm run selftest:live` reads the checkout's configuration and credentials and calls the configured model and search services.

Use the current command output for pass/fail counts. Historical release notes and development logs describe their own revisions, not today's test coverage.

## Data and execution records

```text
data/
  echo.env              Provider credentials
  conversations/        Messages, tool traces, usage, and conversation summaries
  memory/               Core memory, facts, working context, graph, and forgetting log
  state.json            Goals, follow-up state, and response preferences
  research/documents/   Explicitly attached research documents
  runs/                 Execution records, command output, and edit snapshots
  screenshots/          Existing screen images covered by storage cleanup
  spool/                Temporary native captures and permission probes
  uploads/              Uploaded and generated images
  logs/                 Service logs
  metrics.jsonl         Runtime and outcome metrics
```

Back up the data directory before upgrades. Conversation JSON exports do not include the separate run artifacts; copy `runs/` when preserving them. File snapshots support inspection and manual restoration, not automatic rollback. Stopping a run cannot undo completed operations.

Memory combines recent working context, retrievable facts, a consolidated core, and archived records. Memory levels control how much of this is active. Storage maintenance applies configurable age and size budgets while protecting uploads referenced by recently updated conversations. Cleanup reports count only successful deletions and retain failed files in the remaining occupancy.

## Preview the product site

The product site is separate from the chat application in `public/`. Its entry pages are [Simplified Chinese](../site/index.html) and [English](../site/en.html). GitHub displays these as source files; a repository link does not imply that a hosted site has been published.

From the repository root, serve only the site directory:

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory site
```

Open [the Chinese page](http://127.0.0.1:4173/) or [the English page](http://127.0.0.1:4173/en.html), then stop the preview with Ctrl+C. This static preview does not start Echo, load its data, or register a service. Python is used only for this optional preview.

## Repository map

| Path | Responsibility |
|---|---|
| `server.mjs` | HTTP routes, streaming, authentication, and schedulers. |
| `lib/` | Model connections, memory, research, tools, permissions, and storage. |
| `public/` | The chat application's frontend. |
| `site/` | The public-facing product site. |
| `menubar/` | The Swift menu-bar app and companion overlay. |
| `tests/` | Regression suites and the offline/live evaluator. |
| `bin/echo` | CLI for an installed instance. |
| `install.sh`, `scripts/macos/` | Source and macOS installation flows. |
| `scripts/package.sh` | Source archive creation and optional verification. |
| `docs/` | Permission details, release notes, and development history. |

## Packaging

`npm run package` produces a source archive from tracked files at `HEAD`. The script requires a clean working tree by default, checks that [product-journey.md](product-journey.md) covers the package version, and verifies version consistency and the dependency lock file. Package verification extracts the archive, installs dependencies and runs the offline evaluator in a temporary profile. `npm run package -- --no-verify` produces an unverified archive.

Keep release notes tied to the revision being packaged. Document actual validation and remaining limitations without reusing historical test totals. Packaging, signing, and publishing are separate actions.
