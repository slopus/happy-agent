# Monty Code Mode tools

This directory contains Code Mode's entire executable surface: the common `python` tool.

The tool accepts one bounded source string and uses the `@pydantic/monty` subprocess pool owned by
`MontyCodeModeEngine`. Every invocation checks out and closes a fresh session, restores and dumps the
calling agent's continuous interpreter state, runs with fixed memory and recursion limits plus the
parent-side request watchdog, and returns bounded captured output. There is deliberately no
cumulative interpreter duration limit because Monty restores that cumulative counter with the
session; the request watchdog remains the per-call hard stop. The tool passes no mounts, inputs,
external lookup, functions, or loose host objects into Python. Its OS callback provides the live
date and time, an empty environment, and filesystem operations backed by the exact compute already
owned by the agent. Every filesystem call receives the current permission mode, and buffers are
bounded before crossing into Monty. Network, shell, and every other host operation stay
unavailable. The definition is provider-neutral and is the only tool returned by the Monty engine.

The tool is durable because it writes its post-state and exact structured result to the per-agent
checkpoint before calling `AgentToolCall.commit`. Re-execution with the same stable call ID returns
that journaled result. The per-agent lock is held until commit succeeds or fails, so batched Python
calls cannot overtake that write-ahead ordering.
