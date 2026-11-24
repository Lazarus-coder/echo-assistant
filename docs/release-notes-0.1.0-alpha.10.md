# Echo 0.1.0-alpha.10

[Simplified Chinese](zh-CN/release-notes-0.1.0-alpha.10.md) · [Getting started](getting-started.md)

Choose **Language** at sign-in, during first-time setup, or in **Settings**. Your profile controls chat, mini-chat, the menu bar, model instructions, tool descriptions and new proactive suggestions. The assistant uses the selected language by default. You can still ask it to write in another language.

The switch works locally without using a model key. Your configured endpoint, keys, learned reminder preferences, past messages and saved evidence carry over. Built-in conversation titles follow the selected language. Titles you set in this version keep their exact text.

New profiles use English or Simplified Chinese according to the host's locale, with English as the fallback. Profiles created by earlier versions start in Simplified Chinese. Terminal tools accept a one-command override, for example `ECHO_LANGUAGE=en ./bin/echo status`.

This is a source and local macOS build. The public alpha.6 installer predates language selection.
