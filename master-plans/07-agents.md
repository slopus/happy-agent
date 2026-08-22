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

There is one deliberate exception. An agent may create a workspace and then
create an agent rooted in that other workspace while retaining Agent Base
ancestry. That agent is a user-visible root of the new workspace, even though
its `parentAgentId` records that another agent manages it. The parent must be in
a different workspace. It appears in the new workspace's agent list, is marked
as user-visible and managed by another agent, and does not accept messages from
the user. Ordinary subagents remain hidden exactly as before.

User visibility, management by another agent, and whether the user may send a
message are separate explicit facts. A UI must not infer one from another or
from list membership.

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
- Ordinary subagents remain absent from project and workspace agent lists. A
  managed root whose parent belongs to another workspace is visible in its own
  workspace, reports that it is user-visible and agent-managed, and reports
  that the user cannot send it messages.
