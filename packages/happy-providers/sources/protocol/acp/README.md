# ACP protocol

Drives a foreign coding agent — unmodified Claude Code, Codex, Antigravity, or any other agent
with an [Agent Client Protocol](https://agentclientprotocol.com) server — as an ordinary
`BaseProvider`. The agents themselves are in [`vendors/foreignAgents`](../../vendors/foreignAgents/README.md). Agent Base keeps the durable transcript, queue, steering, permissions, and Happy's
own tools; the foreign agent keeps its own loop, prompts, native tools, and context.

```text
Agent Base ── run(context) ──▶ AcpSession ── ACP over stdio ──▶ adapter ──▶ foreign agent
     ▲                            │  ▲                                            │
     │   text / reasoning         │  │ MCP (loopback HTTP, random path + token)   │
     │   own tool calls (server)  │  └──────────── AcpToolBridgeServer ◀──────────┘
     │   Happy tool calls ◀───────┘                 Happy's tools, executed by Agent Base
```

## Who owns what

- **The foreign agent's own tools** (shell, edit, browser, its subagents) execute inside the
  agent. Each call is reported as a provider-owned server call (`server: true`) and settled inside
  the same response; Agent Base never executes it.
- **Happy's tools** reach the agent through an MCP server on loopback. When the agent calls one,
  the response ends with that call (`done: tool_call`); Agent Base executes it under the ordinary
  permission and tool loop, and the next `run` answers the still-open MCP request and keeps
  draining the same foreign prompt.
- **Session truth.** Happy's history is canonical for people and for every other provider. The
  foreign session is a cache of it. `acpSessionStore` records, per Happy agent, which ACP session
  continues the conversation and a fingerprint of the input prefix it has seen. A run whose
  prefix matches sends only new input, restoring the ACP session with `session/resume` or
  `session/load` after a restart. Anything else — compaction, a provider switch, an edited
  history, a lost session — opens a new ACP session and replays Happy's instructions and
  transcript into its first prompt.
- **Permission.** The agent's own permission is mapped onto its config options by the vendor
  profile, and the agent's own reviewer decides what it does without asking. Its
  `session/request_permission` asks are answered from the Happy mode: Read only refuses, Full
  access allows, and otherwise the turn environment's `askPermission` puts the action to the
  person, offering Allow for this session only when the agent offers `allow_always`. Stopping the
  turn withdraws the question and answers the agent `cancelled`. In Workspace write, an ask about a
  Happy tool (marked with `happy/bridgedCall` metadata) is allowed without asking when that tool
  has `autoReview: "never"` or its `shouldReviewInAutoMode` is false for the call. New sessions
  carry the never-reviewed Happy tool names in `happy/approvedTools` metadata so a first-party
  driver can approve them in advance.
- **Tool schemas.** The bridge drops string `pattern` keywords from the schemas it advertises:
  Antigravity validates them with Go's regex dialect and rejects its whole toolbox on one it
  cannot compile. Agent Base still validates every call against the full schema.
- **Compaction.** ACP has none. `compact` asks the agent for a handoff summary and the next run
  starts a new ACP session from it.

A consumer stops reading at `done`, so a session commits its record and settles its turn
before yielding the terminal event.

## Steering and stop

A foreign agent runs its own loop, and to Agent Base one foreign turn is a single long response.
Agent Base raises `SessionRunRequest.steered` when it accepts steering while that response is
streaming. The session then ends the response with `done: normal` so Agent Base can deliver the
steered input on the next run, and what happens to the running foreign turn depends on the
connection:

- **Steerable connections** (the first-party Claude and Codex drivers implement
  `AcpAgentConnection.steer`) keep the turn running. The next run hands the new input to the live
  turn and keeps draining it.
- **Plain ACP agents** have no mid-turn input, so steering interrupts: the turn is stopped exactly
  as below and the next run sends the steered input to the restored session.

Either way the client shows plain steering; there is no separate "stop and steer".

Stop means stopped. Agent Base stops a response by returning its iterator, so `run` returns an
iterable whose `return` aborts the turn at once, even while the agent is silent inside a long
command. The session sends `session/cancel`, records that the agent saw the stopped input, waits
briefly for the prompt to end, then ends every process group in the agent's tree; agents leave a
cancelled command running, and some run each command in a group of its own. The next run starts
a new agent process and restores the same foreign session, sending only what is new.

A prompt the agent's service refuses as too many requests before the agent says anything is sent
again after 3, 10 and 30 seconds, with a `retrying` event each time. Agents retry only for a
moment themselves, and bursts — several sessions on one account, or a restarted agent's first
request — clear within seconds. Only a prompt the agent has reported nothing on is resent, a
stop ends the wait as a cancellation, and steering ends it without resending: the agent never took
the refused prompt, so the next run sends it once, together with the steering. A 429 that names a
quota, usage, weekly or session limit, or a reset hours away, is not retried.

## Connections and models

`AcpProvider` talks to an `AcpAgentConnection`. By default that is a spawned ACP server
(`impl/acpConnectionSpawn.ts`); a vendor can supply `connect` instead and drive the agent through
its own typed API, presenting it as the same ACP surface. `acpDiscoverModels` opens a throwaway
session and reads the agent's model selector, so the catalog lists the models the installed agent
actually offers. A profile option may name an ACP `category` instead of an exact ID, for agents
that call their model selector something else.

## Files

- `AcpProvider.ts` — the provider and the profile contract a vendor fills in.
- `AcpSession.ts` — one Happy conversation inside one foreign session.
- `AcpConnection.ts` — the connection contract shared by spawned adapters and typed drivers.
- `acpDiscoverModels.ts` — reads an agent's live model selector.
- `impl/acpConnectionSpawn.ts` — process start and the ACP handshake.
- `impl/processTree.ts` — ends every process group in an agent's tree on stop.
- `impl/acpConfigOptions.ts` — reads select config options, including their `_meta`.
- `impl/AcpToolBridgeServer.ts` — the MCP bridge for Happy's tools.
- `impl/acpResponseEvents.ts` — ACP `session/update` → Happy session events.
- `impl/acpPromptFromMessages.ts` — Happy messages → ACP prompts, including replay.
- `impl/acpSessionStore.ts` — the durable join between a Happy agent and its ACP session.
- `impl/acpCompactWithAgent.ts` — summary-based compaction.
