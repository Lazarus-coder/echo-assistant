# Echo 0.1.0-alpha.8 · local Mac candidate

Open **Proactive assistance → Preview candidates** to see up to three reminders Echo is considering, including why each is ready or being held. Previewing is local and requires no model call. You can mute an optional topic there or from a delivered reminder, and restore it from either place. In companion mini-chat, the mute applies to the kind of screen cue named on the bubble. A user-requested draft still follows the normal delivery rules.

The wizard connects to your own endpoint and accepts a manual model ID if the provider omits its model list. A custom key variable must contain the key for that connection. Background wording and gateway search use the configured endpoint and models. A fresh profile listens on this Mac. Explicit LAN settings survive upgrades.

Returning to a screen Echo already commented on can skip the wording request. New evidence on that screen remains eligible. Old bubbles expire, duplicate dismissals count once, and opening a bubble twice returns the same conversation. Native capture uses the selected profile's private temporary directory. When the model flags a capture as sensitive, Echo masks its text before saving or displaying the event. Manual capture reports permission failures and expires after two minutes if the menu-bar app is unavailable.

The local package targets macOS 13 or newer and requires Node.js 22.13 or newer. The public download at the time was alpha.6. [Download alpha.10](https://github.com/Lazarus-coder/echo-assistant/releases/tag/v0.1.0-alpha.10). [Setup and upgrade instructions](getting-started.md)
