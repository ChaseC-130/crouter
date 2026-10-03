# Provider adapters and limits

The app uses official local clients with their own saved authentication. It never exports account cookies, reads token files, injects API keys, or logs raw account responses. JEV remains only the project/intent classifier.

| Provider            | Worker integration                                                                     | Session persistence                                            | Subscription limits                                                       |
| ------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Codex               | Official `codex exec`, read-only sandbox                                               | `thread.started` ID; resume that exact ID                      | Official `codex app-server` `account/rateLimits/read`                     |
| Claude Code         | Official print-mode CLI, read tools only                                               | CLI `session_id`; `--resume`                                   | Unavailable through the verified integration; link to provider usage page |
| Grok Build          | Official `grok agent stdio` ACP, read-only sandbox and restricted tools                | ACP `session/new` ID; `session/load` when supported            | Unavailable through the verified integration; use Grok Settings → Usage   |
| Gemini CLI          | Official stream-JSON CLI, plan mode + macOS filesystem barrier                         | `init.session_id`; `--resume` exact ID                         | Unavailable; CLI token statistics differ from subscription allowance      |
| Antigravity (`agy`) | Official Google stream-JSON CLI, plan mode + macOS filesystem barrier                  | `conversation_id`; `--conversation` exact ID                   | Unavailable through this adapter; use official CLI `/usage`               |
| Muse Code           | Official `muse exec --json`, write/shell/web tools disabled + macOS filesystem barrier | UUID bound through `--session-id`; same ID on subsequent turns | Unavailable; check official provider account                              |

**ChatGPT means Codex** here; it is the existing Codex subscription/CLI integration, not a separate browser or cookie integration. No unofficial subscription API or cookie export is used.

## Gemini, Antigravity, and Muse

Use existing saved logins through the official CLIs: interactive `gemini` (Google login), interactive `agy` (Antigravity login), or `muse login`. The server does not log in on your behalf or inject provider API keys. Optional trusted executable overrides are `GEMINI_BIN`, `AGY_BIN`, and `MUSE_BIN`. These three web adapters currently require **macOS and `/usr/bin/sandbox-exec`**; they refuse to run on unsupported systems. The core Codex/Claude/Grok integrations support macOS/Linux.

The additional process sandbox denies filesystem writes globally, except provider-owned authentication/session storage, a private per-run temporary directory, and necessary device descriptors. It explicitly denies project writes and rejects projects overlapping those writable locations. This protects repository files even if an injected prompt or local customization requests a write. The profile does not isolate file reads or network access; use sanitized projects and a dedicated account/container for confidentiality. Provider hooks/settings remain a separate trust boundary. No unsandboxed fallback is offered.

Gemini uses `--approval-mode plan`, disables extensions, consumes the bounded worker request on stdin, and parses only assistant text and the terminal result. Antigravity's plan mode adds planning instructions and is **not itself a security write barrier**; the external process sandbox is required. Its JSON stdin protocol emits `init` and terminal `result` records. Muse uses a private regular prompt file (stdin is not a supported prompt-file path), `--disable-write`, `--disable-shell`, `--disable-web-tools`, `--no-foreign-personal-context`, `untrusted` approvals, and a disabled automatic approval judge. It disables the CLI wrapper's auto-update during workers. Muse's version-1 session envelope is parsed; child task/tool output is excluded. Temporary request files are removed after the process finishes.

See the official [Gemini headless interface](https://geminicli.com/docs/cli/headless/), [Gemini plan configuration](https://geminicli.com/docs/reference/configuration/), [Antigravity headless protocol](https://www.antigravity.google/docs/cli/headless/), [Antigravity execution modes](https://antigravity.google/docs/cli/modes), [Muse CLI documentation](https://dev.meta.ai/docs/muse-code/permissions), and [Muse session protocol](https://meta-models.github.io/muse-code-sdk/next/). Verify CLI versions/flags before upgrades; unsupported protocols fail rather than being guessed.

## Grok

Install the official Grok Build CLI following [xAI's setup](https://docs.x.ai/build/overview), then run `grok login` in your own terminal. Optionally set `GROK_BIN` to its trusted executable. The adapter uses ACP's advertised `cached_token` authentication method, and fails if it is unavailable. It never chooses `xai.api_key`. It persists the returned session ID before prompting. If the installed CLI cannot load sessions, continuation fails instead of opening an unrelated thread.

The process starts with `--sandbox read-only`, `--tools Read,Grep`, `dontAsk`, explicit denials for Bash/Edit/MCP, disabled web search, no subagents, and an independent agent instead of a shared leader. The client advertises no filesystem or terminal tools and denies all ACP permission requests. See [official ACP scripting](https://docs.x.ai/build/cli/headless-scripting), [permissions](https://docs.x.ai/build/features/permissions), and [sandbox profiles](https://docs.x.ai/build/features/sandbox). Grok's current macOS child-network sandbox has documented limitations; project confidentiality still requires a dedicated account/container when stronger isolation matters. Use only trusted project and user customizations; provider-managed hooks/settings remain a separate trust boundary.

## Quota display

Open **Setup & connections** to read limits. Refresh runs a short-lived official Codex app-server process, initializes its documented protocol, requests account limits, validates quota windows, and shuts down. It does not start model inference, reset limits, buy credits, initiate login, or read account email/token data. API-key-only or unsupported logins can return no subscription windows.

Prefer `rateLimitsByLimitId` over the legacy single bucket. `usedPercent` is consumption; remaining is `100 - usedPercent`, clamped to 0–100. Reset timestamps are seconds since the Unix epoch. Missing/null windows remain unavailable rather than becoming 0%. A timestamp/source is shown with real data. Demo usage is explicitly synthetic. No quota response is committed or saved as project knowledge.

See [Codex account limits](https://learn.chatgpt.com/docs/app-server). Provider API organization limits, per-turn token counts, and estimated dollar costs are not the same as subscription allowance. Unsupported subscription metrics are deliberately left unavailable.

## Main conversation events

Every crouter worker success/failure appends a bounded assistant event identifying its project, provider, and task. These events appear in the contiguous chat after the next refresh, even if the user is looking at another project's dashboard or the tab was closed when the task finished. Project filters affect the task dashboard, not this global display. Events remain display history and are never sent back to JEV or another worker as memory.

The integration covers worker turns started by crouter. It does not scrape unrelated desktop/browser chats or assume that an externally resumed session changed task status. Interrupted server runs retain task/session state and require the recovery flow in the README.

## assistant-ui

The conversation uses [assistant-ui's MIT React primitives](https://github.com/assistant-ui/assistant-ui) and an [external-store runtime](https://www.assistant-ui.com/docs/runtimes/custom/external-store). SQLite remains the local display store; the external runtime maps current messages into UI state. New-message callbacks send only the current text to the stateless routing endpoint. No Assistant Cloud, hosted history, model gateway, telemetry integration, branching memory, or API-key backend is enabled.
