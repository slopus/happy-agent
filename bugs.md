# Bugs

## Codex turn fails after a successful tool call

Observed on July 20, 2026.

Codex completed an `exec_command` call successfully and rendered its output,
including two large single-line JSON responses followed by the expected overlay
log matches. Instead of continuing the turn, Happy Agent then displayed:

```text
Error Codex error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 2c64043a-ad02-4fc3-8abc-9418cef802e7 in your message.
```

The tool call itself had succeeded: it invoked and dismissed the overlay, then
confirmed `windowServerOnScreen=true`. The failure occurred while Codex was
resuming after that tool result. The result contained long, wrapped JSON lines;
that is relevant reproduction context, but it has not been established as the
cause.

Expected behavior: a successful tool result remains in the transcript and the
agent continues the same turn, even when the result is large or contains very
long lines. A later inference failure must not make the successful tool action
look failed or lose the resumable turn state.

## Subagents are offered a question tool they cannot use

Observed in three Claude Sonnet 4.6 subagent runs on July 20, 2026.

Each child launched successfully and began its audit, then ended with the same
runtime error:

```text
Only the primary session can ask the user a question.
```

The current `v0.0.32` source still includes `AskUserQuestion` or
`request_user_input` in provider tool catalogs used by subagents, while the
session layer rejects every subagent call to that tool. This makes a tool that
cannot succeed appear available to the model and can discard otherwise useful
delegated work when the model selects it.

Expected behavior: do not advertise interactive question tools to subagents,
or route a subagent's question through the primary session without failing the
child run.
