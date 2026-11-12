# Retired chat UI migrations

Only the immutable `001-chat-ui` migration remains here. Runtime registers it without tools,
hooks, action handling, component catalogs, or capability advertising so existing installations
retain their migration ledger. Historical tool calls remain ordinary tool calls; their legacy
presentation payloads are opaque data in History.

```text
runtime → migration ledger
history → ordinary saved tool calls
```

Chat onboarding is deferred. Future UI may use settings widgets exposed by top-level tools
similar to MCP apps, or general Card, Button, Text, and Column primitives like json-render,
A2UI, or ChatGPT's intelligent UI. Structured user-input questions and normal media
presentations remain independent features.
