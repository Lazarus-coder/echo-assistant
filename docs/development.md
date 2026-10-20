# Development

This guide covers source setup, runtime controls, tests, and packaging. For the product overview and installer, start with [English](../README.md) or [中文](../README.zh-CN.md).

本文集中说明源码安装、命令行、测试隔离与内部结构。日常使用请先看 README；这里的服务命令可能影响已安装实例，测试前请阅读隔离说明。

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

This uses the checkout's `config.json` and `data/`, binds to loopback, and runs until stopped. It does not register a login service. Use a separate checkout and the environment overrides below when you need separate development data. Starting any server also runs storage maintenance, including the shared capture directory described under [test isolation](#test-isolation).

To install a persistent source instance, run `./install.sh`. It installs locked dependencies, offers credential setup, registers `com.echo.chat` and `com.echo.menubar` with launchd, and builds the menu-bar app when available. These labels are shared with the packaged installation: running the installer or service controls can affect an existing instance. Rebuilding the app can require a new Screen Recording grant.

### Runtime configuration

| Setting | Purpose |
|---|---|
| `ECHO_DATA_DIR` | Override the runtime data directory; defaults to `data/` in this checkout. |
| `ECHO_CONFIG` | Override the config file; defaults to `config.json` in this checkout. |
| `ECHO_BIND=local` | Listen only on loopback. |
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

The default configuration permits LAN chat without a password. Use loopback for development or configure authentication before exposing a shared instance. Workspace execution, approvals, and artifacts remain restricted to host connections.

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

`ECHO_DATA_DIR` and `ECHO_CONFIG` isolate data and configuration, but **do not redirect `/tmp/echo-capture`**. Server startup and maintenance sweep that shared directory. The dedicated server regression mocks it; several existing API suites still start servers that perform this cleanup.

Run the full suite in a disposable environment, or apply a test-only filesystem mock to every spawned server before it imports `server.mjs`. A preload on the parent test runner alone is insufficient when child processes replace their environment. The fixture in [server-regressions.mjs](../tests/server-regressions.mjs) shows the required ordering. Do not use a running user's captures as test data or restart their installed service to run tests.

The offline evaluator, `npm run selftest`, creates its own configuration and does not read real credentials. It still starts a server, so the shared-directory caveat applies. It also writes the untracked `tests/last-report.json`. `npm run selftest:live` explicitly reads the checkout's configuration and credentials and calls real model/search services. It is outside the offline regression workflow.

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
  screenshots/          Retained screen images, when enabled
  uploads/              Uploaded and generated images
  logs/                 Service logs
  metrics.jsonl         Runtime and outcome metrics
```

Back up the data directory before upgrades. Conversation JSON exports do not include the separate run artifacts; copy `runs/` when preserving them. File snapshots support inspection and manual restoration, not automatic rollback. Stopping a run cannot undo completed operations.

Memory combines recent working context, retrievable facts, a consolidated core, and archived records. Memory levels control how much of this is active. Storage maintenance applies configurable age and size budgets while protecting uploads referenced by recently updated conversations. Cleanup reports count only successful deletions and retain failed files in the remaining occupancy.

## Preview the product site

The product site is separate from the chat application in `public/`. Its entry pages are [中文](../site/index.html) and [English](../site/en.html). GitHub displays these as source files; a repository link does not imply that a hosted site has been published.

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

`npm run package` produces a source archive from tracked files at `HEAD`; it does not publish a release. The script requires a clean working tree by default, checks that [product-journey.md](product-journey.md) covers the package version, and verifies version consistency and the dependency lock file. Verification is on by default: it extracts the archive, installs dependencies, and runs the offline evaluator, so the shared capture-directory caveat still applies. `npm run package -- --no-verify` skips that execution check and produces an unverified archive.

Keep release notes tied to the revision being packaged. Document actual validation and remaining limitations without reusing historical test totals. Packaging, signing, and publishing are separate actions.
