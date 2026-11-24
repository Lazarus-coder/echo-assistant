# Echo 0.1.0-alpha.9 · local Mac candidate

On the host Mac, connect a folder in **Workspace**. Choose **Read-only plan** in chat to locate a symbol, read its callers and discuss an implementation. Source search returns paths, line numbers and excerpts. If a scan reaches a limit, narrow it to a subdirectory or file. Long source files and command logs can be read one page at a time, with a continuation position on each partial page.

Switch the same conversation to **Work** to use the editing and command permissions you enabled. Open **View steps and results** on the reply to inspect recorded edits, before/after snapshots, commands and exit codes. A failed check followed by the same successful check can resolve that failure. The run retains both attempts.

Echo uses the endpoint, credential and model you configure. The official DeepSeek Chat Completions route can continue thinking-mode tool calls across rounds. Workspace execution needs a model that supports streamed function calls. Shell and MCP operations require individual approval.

This Mac candidate targets Apple Silicon and Intel on macOS 13 or newer and requires Node.js 22.13 or newer. The public download is alpha.6. [Setup instructions](getting-started.md)
