# Getting started

[Simplified Chinese](zh-CN/getting-started.md) · [Product overview](../README.md)

## Before you install

Echo is an alpha app for macOS 13 or newer, with packages for Apple Silicon and Intel. Install **Node.js 22.13 or newer** first; the app's runtime dependencies are bundled in the macOS package, but Node itself is not. Have a compatible model endpoint and API key ready, or enter them later in the setup wizard.

Download from the [v0.1.0-alpha.6 release](https://github.com/Lazarus-coder/echo-assistant/releases/tag/v0.1.0-alpha.6) and read its notes. This is a prerelease. The current repository may include changes that are not in that package.

## Install and connect

In alpha.10, choose your language on the sign-in or setup screen. You can change it later under **Settings → Language**. Existing profiles start in Simplified Chinese. New profiles use the system language when supported, with English as the fallback.

1. Open the DMG or unpack the ZIP, then run **Install Echo.command**.
2. Follow the installer and open the chat window. Enter your endpoint, API key, default model, and utility model in the wizard. Image features need a model that supports them.

   In the current source, enter a known chat model ID to finish setup without a provider request. **Test connection and list models** optionally reads the provider’s model catalog. A chat reply verifies generation with the selected model. Memory extraction and research use your utility model, falling back to your default model. Echo uses your default model to word a proactive chat reminder.

   If your installation uses a named key variable, set its name in `config.json` and its value in the environment or setup wizard. Switching a model endpoint in setup or through the settings API requires the key for the new destination.
3. Choose a memory level. Background research, workspace tools, screen awareness, and companion mode have their own controls. Selecting the deep memory profile enables screen awareness, which also needs macOS Screen Recording permission.

The installer places Echo and its data under `~/Library/Application Support/Echo` and registers the service and menu-bar app to start at login. The app uses ad-hoc signing rather than an Apple Developer ID signature; do not expect a notarized distribution. macOS may require you to approve opening it. Use the downloaded release's installation instructions and verify its origin before opening it.

## Choose your access and data settings

- **Network access.** Fresh profiles from alpha.8 onward use loopback. For phone access, set a password and enable authentication, then set `"bind": "all"` in `config.json` and restart. The public alpha.6 installer defaults to LAN access without a password. [Network controls](permissions.md#5-network-exposure)
- **Model and search:** content used in answers goes to the endpoint you choose; search queries go to the configured search provider. Review their data terms and usage charges. Local record storage does not mean every request stays on your device.
- **Research:** enable it in **Proactive assistance**, choose sources per goal, and review the results. Research and notification controls are independent. Checks pause when the Mac sleeps or Echo stops.
- **Follow-ups.** In the public alpha.6 package, open **Proactive assistance** to create a goal, set its date and choose its sources. With the current source, try “Track my proposal until Friday” in chat. Check the saved date, then ask “Show me the proposal draft.” You can read the draft and its sources with proactive messages off. If the draft asks a question, open it in **Proactive assistance**, enter your answer and choose **Answer and continue preparation**. Your answer stays beside the original question. The goal shows when the next draft is ready.
- **Recall in a reply.** In the current source, expand **Memory retrieved for this reply** under a chat reply to see the facts retrieved for that turn. The list shows facts that are still active and match the original text. Choose **Manage memory** to open your memory settings.
- **Tools:** workspace file access must be enabled. Shell and MCP calls need approval and can act with the privileges of your account or the configured server. Stop does not undo a completed action.

The app does not automatically import your browser, email, or calendar. Screen context is optional; on-device OCR is the default, while image mode can send screenshots to your chosen model.

For a goal saved by an earlier checkout, open its editor and check **Prepare future updates**. Choose **Near the deadline** for a date, or **On source changes or approaching deadlines** for a date and sources. Existing goals keep their saved choice because some users explicitly selected manual preparation.

## Confirm setup or find help

Open the chat window from the Echo menu-bar icon. Save your provider and model in the setup wizard, then send a short message. An open window confirms that the interface is available; a successful reply also checks your configured model connection.

If the window does not open or replies fail, open Terminal in `~/Library/Application Support/Echo` and run `./bin/echo status` for service information or `./bin/echo logs` to follow the logs. Stop following logs with Ctrl+C. When [reporting an issue](https://github.com/Lazarus-coder/echo-assistant/issues), include the Echo version, macOS version, steps to reproduce, and a relevant error with credentials and personal content removed.

If alpha.6 reports a healthy service but opening chat returns HTTP 500 under the default installation path, the space in `Application Support` can prevent it from finding the page. The current source fixes path handling. Check for a legacy profile before switching builds.

## Upgrade or remove

**Upgrading an installation under Application Support.** Some older builds wrote the active profile to a second folder whose name contains the literal characters `%20`. If the service log reports a legacy profile, stop Echo and back up both `~/Library/Application Support/Echo` and `~/Library/Application%20Support/Echo`. Restore the intended `config.json` and `data/` together under the real installation path, checking both copies of `data/echo.env` for the credentials you intend to keep. Keep the other profile as a separately named backup, then restart. Echo checks for this ambiguity before serving chat. Source launches can also select an existing profile with explicit `ECHO_CONFIG` and `ECHO_DATA_DIR` paths.

Back up the installation's `data/` directory before upgrading. Conversation exports do not include separate command outputs and file snapshots in `data/runs/`; include that directory when those records matter. Alpha interfaces and data formats can change.

To remove the installation, first back up any data you want to keep, then use **Uninstall Echo.command** from the release package. Confirming uninstallation deletes the app and its data, including memories and conversations; cancelling leaves the installation in place. Deleting local records does not retract data already sent to a provider. For source installation and service commands, use the [developer guide](development.md).
