# @ai2sapien/agent-runtime

Provider adapter for a local `codex app-server` process.

Implemented in Spike 0:

- stdio JSONL framing
- bidirectional request, response, notification, and server-request handling
- initialize/initialized handshake
- account status, ChatGPT browser/device login, logout, and rate limits
- thread start/resume
- turn start/interrupt
- approval response primitives
- request timeout and process-exit rejection

The adapter intentionally exposes only a small stable subset. Run `npm run generate:codex-schema` at the repository root to generate the exact protocol bindings for the locally installed Codex version before expanding the surface.
