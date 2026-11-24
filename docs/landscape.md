# Personal agent designs and what Echo adopted

## Coding in a personal conversation · alpha.9

| Reference | Decision for Echo |
|---|---|
| Codex discovers project guidance in scoped `AGENTS.md` files. [OpenAI Docs](https://developers.openai.com/codex/guides/agents-md/) | Prompt Echo to consult project instructions when working on a repository. It reads them on demand through the same scoped file tools the user granted. |
| DeepSeek Harness gives the tool registry a scope and derives model history from recorded steps. [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md) | Restrict both tool discovery and dispatch for read-only conversations. Use the existing run record to show actual file changes, commands and outcomes. |
| DeepSeek specifies a separate reasoning field across chat-completion steps in thinking mode. [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode/) | Reconstruct per-round fields when continuing on the same official BYOK connection. Other endpoints receive the ordinary chat history. |
| Aider feeds test failures back into its coding workflow. [Linting and testing](https://aider.chat/docs/usage/lint-test.html) | Let Echo inspect a failed command, edit the file and run the same check with a fresh approval. Keep both exit codes and any unrelated failures in the run. |

## Previewing and steering a personal assistant · alpha.8

| Product behavior | Decision for Echo |
|---|---|
| Zulip lets someone mute and unmute a single topic and makes exceptions for direct mentions. [Topic notifications](https://zulip.com/help/mute-a-topic) | A person can silence an optional topic and still receive a draft they explicitly requested. Muting supplies no usefulness or timing vote. |
| Home Assistant shows whether an individual automation condition passes. [Testing automations](https://www.home-assistant.io/docs/automation/testing/) | Show the candidate's local rank alongside the reason it would be held, including during quiet hours. Opening the preview spends no interruption budget. |
| Hermes Agent's Curator can run a dry run and report what it would change. [Curator](https://hermes-agent.nousresearch.com/docs/user-guide/features/curator) | Use the same ranking function for the preview and for delivery. Reading the prediction leaves the queue, feedback, conversation and model connection alone. |

## Personal agents and proactive assistance · 2026-11-23

| Design | What informed Echo |
|---|---|
| Hermes Agent can use a scheduled job's local pre-check to skip an entire model turn. [Hermes scheduled tasks](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron) | A timer starts a local check. Echo only requests wording after one eligible trigger clears the local threshold. It can hold a previously attempted item and consider other material. |
| OpenClaw exposes active hours, foreground-work priority and empty-checklist skips on scheduled checks. [OpenClaw scheduling policies](https://docs.openclaw.ai/gateway/heartbeat) | Echo checks hard limits first and checks again at delivery. A draft the user requested can have higher priority than an inferred tip. Both must respect quiet hours. |
| ActivityWatch's AFK watcher uses observable device signals and documents cases where they misclassify activity. [ActivityWatch FAQ](https://docs.activitywatch.net/en/latest/faq.html) | Echo learns from the local times at which someone actually messages Echo. This is a habit of using this assistant. It gives limited evidence about when the person will welcome a suggestion. |

Each personal Echo profile learns which kinds of help and topics received explicit usefulness votes, and which delivery times received positive or negative timing votes. The user chooses the starting preset. Opening Echo late at night contributes a chat-time observation only when the user sends a message. Ignoring a suggestion supplies no vote.

## Five open-source agent designs revisited · 2026-11-23

We compared five projects against two moments in Echo. A draft asks a question and the user wants to answer it. A reply recalls something personal and the user wants to see what Echo retrieved. The table records what each project does and the product decision we took from it.

| Project | What a user or developer can do there | Decision for Echo |
|---|---|---|
| LangGraph | Pause a workflow with a question, then resume the same thread with the answer. [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | **Adopted.** Answer a question on the draft that asked it. Save the answer against that revision and queue a new draft with the same goal and permissions. |
| Khoj | Open the reference notes supplied for a chat response. [Chat and references](https://github.com/khoj-ai/khoj/blob/master/documentation/docs/features/chat.md) | **Adopted for personal facts.** Inspect the facts recalled for one reply. A fact's presence tells you what Echo retrieved. It cannot tell you which part of a model's answer depended on it. |
| Goose | Return to a saved session and distinguish work in progress, completed work and errors in the session list. [Session management](https://goose-docs.ai/docs/guides/sessions/session-management/) | **Keep the existing return brief.** Echo already links from the brief to a particular draft. Answering its question gives the user a way to continue from that same place. |
| Aider | List the files in chat and inspect the token cost of the current context. [In-chat commands](https://aider.chat/docs/usage/commands.html) | **Use ordinary chat controls.** Echo exposes recalled facts on the reply where the user needs them. File and token accounting would answer a different question. |
| Letta | Mark a memory block read-only to the agent, reserving changes for its external owner. [Memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks) | **Deferred.** Echo's protection control prevents a fact from fading. Giving a person exclusive editing authority would require a separate guarantee across every memory writer. |

[Original October survey (Simplified Chinese)](zh-CN/landscape.md)
