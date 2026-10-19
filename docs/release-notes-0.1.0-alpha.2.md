## What's new in alpha.2 — modular, BYOK-first

Alpha.1 worked, but it showed its author's fingerprints: a vendor gateway baked in as the default, a hard-coded search stack, and no guided setup. Alpha.2 moves all of that into configuration and a first-run wizard, so the same code runs on anyone's endpoint and anyone's search service.

### Bring your own everything

- **No vendor default.** `upstream.baseUrl` starts empty; keys live only in `data/echo.env` (mode 600) and `config.json` records *which environment variable to read*, never a secret.
- **Six-step onboarding:** endpoint preset (OpenAI · Aliyun Bailian · DeepSeek · Moonshot · OpenRouter · Ollama · custom) → *test & fetch models* → default / utility / image model → memory profile → search chain → permissions (residency, `swiftc`, bind, optional password, screen-recording test).
- Re-runnable from *Settings → 引导与权限*; skippable entirely if you prefer editing `data/echo.env` yourself.

### Search is a chain you configure

`none · scrape · gateway · tavily · brave · bocha · searxng · custom` — ticked providers are tried in order, and a failure hands off to the next one. Keys come from environment variables named in the provider catalog. The circuit breaker (cool-down after a captcha or repeated failures) is visible in the self-report and in `./bin/echo search`.

### Memory has profiles

`off` (stateless) · `light` (facts only) · `standard` (facts + Dream + proactivity) · `deep` (standard + screen awareness). Choosing a profile writes the concrete knobs, so "profile" and "values" can never disagree.

### Permissions are documented and checkable

`GET /api/permissions` reports endpoint status, launchd residency, `swiftc`, bind address and data directory; `POST /api/permissions/screen-test` actually attempts a capture to tell you whether Screen Recording is granted. Full guide: [docs/permissions.md](docs/permissions.md).

### Fixes

- Choosing a memory profile had no effect (the preset patch was merged into the wrong section).
- Stored API keys could not be cleared (`writeEnvValues` skipped empty values; `""` now means *delete*).
- `install.sh` no longer defaults to a specific vendor gateway.
- Settings PATCH responses crashed when the onboarding state helper was referenced from module scope.

### Verification

`tests/selftest.mjs` grew a new track (**H — modularity & onboarding**, 17 checks): provider-catalog completeness, "no vendor default" invariant, onboarding writes keys to `echo.env` with 0600 and nothing secret into `config.json`, profile expansion, `none` actually removing the web tools, and `image_gen` disappearing when no image model is configured. Offline suite: **69/69**.

### Install

```bash
tar -xzf echo-assistant-0.1.0-alpha.2.tar.gz
cd echo-assistant-0.1.0-alpha.2 && ./install.sh
```

Then open `http://127.0.0.1:8787` and follow the wizard. Verify the download with:

```bash
shasum -a 256 -c SHA256SUMS
```

### Known limitations (unchanged)

Screen Recording must be granted once from the menu-bar icon; `scrape` search can be rate-limited by its engines (it cools down and hands off); video / ASR / TTS depend on your endpoint exposing them; retrieval is lexical plus an entity graph (no embeddings); interfaces and data formats may still change during alpha — back up `data/` before upgrading.