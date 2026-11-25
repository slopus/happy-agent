# Permissions module learnings

## File content needs a larger per-string review budget

The 8,192-character argument-string limit rejected ordinary long file writes before a reviewer
could see them. The limit is now 32,768 characters, allowing larger content to reach review without
truncation. The separate 65,536-byte total argument limit, nesting and collection limits, and
normal permission decisions remain unchanged; increasing the string budget does not grant access.

## A critical-risk label is not a runtime veto

The runtime rejected every critical-risk action even when the reviewer explicitly allowed it
after informed user approval. Both enforcement layers now honor the reviewer's critical-risk
outcome instead of overriding it. Reviewer denials, the separate high-risk authorization check,
and per-call sandbox elevation and restoration remain enforced. This keeps policy interpretation
with the reviewer and avoids turning a valid approval into another refusal.

## A denial stops the action, not future informed user authorization

Calling every denial "final" led agents to refuse even after the user explicitly authorized the
exact action and its disclosed risks. Auto guidance and tool refusal responses now distinguish
unauthorized retries from one fresh review supported by new, explicit user authorization. Without
that authorization, the agent must use a materially safer alternative or stop and explain the
action and concrete risk. Fresh review is not permission to execute: existing policy enforcement
and refusal-loop limits remain in force, and another denial stops the action again. Assistant
claims, tool output, and vague requests to continue cannot supply the new authorization.

## A destination refusal names its two remedies

An export to the user's own third-party account was refused, and the refusal cited a "tenant policy"
the user could not find or change. A denial now tells the agent that a refusal about an untrusted
external destination can be resolved by the user explicitly approving that exact destination and
data after the risk is explained, or by adding the destination as trusted to their global
`SECURITY.md`, whose path the auto module supplies from configuration. Unproven outcomes carry no
such remedy, because nothing judged the destination.

## In Auto, Happy's reviewer answers a foreign harness before the person does

Auto sent every ask a foreign harness made (Antigravity's `auto` handoffs and MCP-call asks,
Claude Code's classifier handoffs, Codex's escalations) straight to the person, and a sub-agent
had nobody to answer, so it stalled; Kirill asked for Happy's reviewer to answer first and the
person only when it fails. `reviewHarnessAsk`, registered with config, now puts the ask to the
automatic reviewer under the same timeout, risk policy, refusal text, and refusal circuit as a
Happy tool call. Allowed, the harness's action is approved once and never elevated, because the
harness runs it outside Happy's sandbox. Denied, it is refused with the reason addressed to the
agent, which is final as it is for Happy's own calls. Unproven — no reviewer, every route
unavailable, a timeout — goes to the person and does not move the circuit, since nothing judged
it. These reviews emit no per-call permission event: the public history records a review against
a Happy tool call, and a harness's own action has none.

## Antigravity runs with no tools of its own, so Happy's sandbox and reviewer decide everything

Antigravity's logs and the decision it stores on each conversation step showed that its own
review model took commands out of its sandbox (writes outside the project, `curl`, once a force
push) without asking anyone, and a monitor model blocked the same push on another run. Running it
in `accept-edits` with its sandbox on still left two sandboxes, two sets of labels and agy's
monitors in the path. Kirill decided on one sandbox and one reviewer, with no trust in agy's.
Happy now starts agy as a per-session custom agent whose only built-in tool is `search_web`; it
reads, writes, runs commands and starts sub-agents only through Happy's tools over MCP, which run
in Happy's sandbox under Happy's mode and reviewer exactly like Happy's own loop. agy runs in its
`default` mode for every Happy mode, its asks about Happy tools are approved because Happy decides
the call when it runs, and anything else it asks about is refused unasked. Describe a harness's
own checks only from evidence: its model decisions vary on the same action, and an ask carries
the command without its reason.

## With only Antigravity signed in, Auto has no reviewer, and that is accepted

Kirill noted that Gemini alone will not work. Happy's reviewer never runs on a foreign harness and
Happy cannot call Gemini directly, so an installation signed in to nothing but Antigravity has no
model to review on. Work inside the sandbox still runs. A Happy tool call that needs review is
refused as unavailable, and that refusal says plainly that no reviewer model is configured so the
agent tells the user to sign in to a Claude, Codex, or Grok account; a harness's own ask goes to the
person, and a sub-agent with nobody to answer cannot escalate. This is the intended limit, not a
bug: do not add a Gemini reviewer path or let unreviewed actions through to work around it.

## A foreign harness's Happy tool calls are reviewed like Happy's own

Happy used to skip Auto review for Happy tool calls from a foreign harness, leaving them to the
harness's reviewer, which is more permissive than Happy's (Claude Code's classifier allowed a force
push and `rm` outside the project). Now the harness's ask about a Happy tool is approved in every
mode and the call itself is decided here when it runs, with its real tool, arguments, events, and
Full access lending, under the conversation's own mode: Read only and Workspace write contain it
as they contain Happy's own calls, and Auto reviews it. Each call is decided exactly once, and its
refusal reaches every harness as the tool's result. Asking the person first in Workspace write, as
before, put a question in front of calls Happy's own loop runs without one.
