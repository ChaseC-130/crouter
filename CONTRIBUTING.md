# Contributing

Use Node 24, `npm ci`, and the synthetic demo documented in the README. Do not develop against private project content or commit account tokens, databases, real paths, screenshots containing private data, or provider session IDs.

Run `npm run check`, `npm run privacy:check`, and `npm run build` before sending a pull request. Keep meaningful behavioral tests for state transitions, isolation, approval enforcement, and provider event/CLI handling. Tests must not call a live provider or JEV.

JEV only chooses a project and intent. Do not add chat history or project knowledge to its payload. Task state belongs to bounded Markdown in the project, not global summaries or a growing memory file. Any new destructive action requires the same preview, expiry, single-use, and stale-state checks as existing approvals.

A new provider implements the command/event boundary in `lib/server/providers.ts`; it must use the official local CLI's authentication and preserve its session ID. Do not embed or export subscription credentials, or bypass CLI permissions. Document any platform/version limitation.

This project uses the MIT license. Contributors retain ownership of their contributions and license them under MIT.
