# External platform integrations

Before writing or fixing code that depends on a third-party platform's exact behavior
(Slack API, Stripe, GitHub, etc. - anything where a wrong assumption fails silently
or only shows up in production), use WebSearch to verify against official docs first.
Do this proactively during planning, not reactively after a bug is reported.

- Prefer official docs over blog posts/Stack Overflow; if results conflict, say so
  rather than silently picking one.
- If a fix or feature turns out to depend on undocumented/ambiguous platform
  behavior, verify with a small isolated repro before wiring it into the real
  code (as was done for Slack's `response_url` targeting behavior in this repo).
