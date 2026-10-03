# Security and privacy

This is a trusted single-user app, served on loopback. Remote access is supported only through private Tailscale Serve with an exact HTTPS origin and an allowlisted proxy identity on every API request. Every allowed user has full access to the single local workspace; tenant isolation and public hosting are unsupported. Review the README's data boundaries and safe setup before connecting projects or credentials.

Never include real databases, `.env` files, personal paths, task requests/results, session transcripts, auth tokens, or private screenshots in a public issue. Reproduce with synthetic fixtures instead. If a deployed repository offers GitHub private vulnerability reporting, use it for sensitive reports; otherwise contact its maintainer privately using their published channel. This source template intentionally contains no personal maintainer contact information.

Supported release: 0.1.x. Provider CLI flags and permissions can change; verify official documentation and update adapters/tests together. App-level approvals cover registry removal, task archival, and chat clearing. Worker implementation changes require a separate human-controlled official CLI session and are outside this web app.

The privacy checker is heuristic and inspects the current index, not complete Git history. A passing result does not prove the absence of private data. Review all publication content, keep runtime data out of version control, and rotate any exposed credential promptly.
