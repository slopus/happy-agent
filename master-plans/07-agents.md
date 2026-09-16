# Master plan 7: Agents

## Big picture

Agents never die. It must always be possible to send an additional message to
an agent and try to talk to it again. This holds for subagents too: a subagent
never stops for good — after it finishes a task, its parent can send it a
follow-up and the subagent resumes with its context.

This was true at some point, and it was the right behavior. It is almost
certainly not true right now: agents currently cannot send a follow-up message
to a subagent they launched. That is a regression against this plan, not a
design decision.

## Identity

Agents recognize each other by Agent ID. The ID is unguessable, so the user has
to share these IDs with Rig by hand to connect two agents. That said, Rig can,
of course, look into its own database and find the IDs itself when it wants to
— which does happen from time to time.

## Subagents

Subagents are spawned and driven by another agent rather than by a person in a
UI. Ordinarily they are not human-visible and do not occur in a project or
workspace's agent list.

The API creates only user-controlled root agents. It does not accept a
`parentAgentId` creation option or create read-only managed workspace roots.
Parent-managed, user-visible delegation belongs to subtasks instead.

User visibility, management by another agent, and whether the user may send a
message are separate explicit facts. A UI must not infer one from another or
from list membership.

## Subtasks

A subtask is a parent-managed agent that the user can see and interact with.
It is distinct from an ordinary hidden subagent. Every API agent reports a
`subtask` boolean, optional for compatibility with older daemons, and uses the
ordinary parent-agent relationship for its coordinator.

Only a bot or another subtask may create a subtask. There are at most two
subtask levels below a bot: bot, main subtask, internal subtask. This limits
depth, not the number of siblings; a main subtask may coordinate several
workspace subtasks for different projects.

A subtask may share its parent's filesystem or run in its own ordinary project
workspace. That workspace identifies its resident subtask agent; the agent's
parent identifies its coordinator. A bot may create a workspace-bound subtask
directly, and that subtask may create a shared-filesystem subtask.

Add one creation tool, `create_subtask`. Messaging uses the existing agent
messaging tools, archival uses the existing agent API, and there is no waiting
for a subtask. Shared-filesystem subtasks are visible through parent activity;
workspace-bound subtasks also appear in their workspace's agent series.
Subtasks are the exception to the managed-agent restriction on user messages;
ordinary subagents keep their current behavior.

## Model

Agents always have a fixed model. This is not very convenient when the model
changes, or when the effort changes, and so on. Changing the model of an
existing agent can probably be allowed, but using it that way is discouraged —
even though for people it is, of course, much more convenient to switch between
models.

## What done looks like

- Any agent, including a finished subagent, accepts a follow-up message and
  continues with its full context.
- Agents can reach each other by unguessable Agent ID, shared by the user by
  hand — with Rig able to find the IDs in its own database when needed.
- Ordinary subagents remain absent from project and workspace agent lists.
  Neither the client nor the daemon exposes managed-root creation through the
  agent API; ordinary API-created agents have no parent.
- Subtasks remain parent-managed while accepting user interaction, retain their
  identity and workspace association, and enforce the two-level bot-rooted
  hierarchy without limiting sibling count to two.
