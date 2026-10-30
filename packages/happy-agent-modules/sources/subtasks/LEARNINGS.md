# Subtasks learnings

## User interaction is independent of parent management

Treating every parent-managed agent as a hidden, read-only subagent prevents a person from
participating in delegated work. Subtasks explicitly retain their parent while allowing user
messages and archival. Ordinary subagents keep their existing restrictions. Depth is limited to
two subtask levels below a bot or task, not two children, so one subtask may coordinate several
projects.

## Tasks are subtask roots beside bots

Tasks, persistent conversations with their own folders, were asked to have subtasks. Rather than
introduce a second delegation mechanism, an active task is now a root exactly like an active bot:
it may create subtasks two levels deep, archive its direct subtasks, and receives the same
coordinator guidance. Bots still create subtasks directly, so existing subtask trees and the
public API are unchanged.

## Coordinators create and archive; existing messaging handles interaction

Subtasks use `create_subtask` and `archive_subtask`, never a wait tool or a create/archive
multiplexer. Follow-ups use existing agent messaging. Only the direct coordinating bot or subtask
may archive through the tool; users retain the agent API. Archival marks only the selected agent,
stops its running descendants, and preserves history. Metadata, cancellation, and
durable compute-cleanup intent commit together; cleanup starts after commit. User archival through `POST /v0/agents/:id/archive` takes the same path: the
route commits only `archivedAt` and lets this module's hook abort and record cleanup in that
transaction. It previously aborted and disposed compute before persisting archival, so a
disposal failure could leave a stopped subtask still active. A workspace identifies its resident subtask, whose parent identifies the coordinator.
Sharing the parent's filesystem does not add a second workspace association.

## A workspace-bound subtask and its workspace archive together

Archiving a subtask used to leave its workspace active, and archiving the workspace left an
unarchived subtask whose checkout was gone. People asked for the two to move together. Both sides
are now one durable decision in one transaction. This module's archive hook archives the workspace
named by `subtaskWorkspaceId`, but only when that workspace still names this agent as
`subtaskAgentId`, through `WorkspacesModule.archive` and so through descendants, cancellation, the
service-cleanup barrier, and the keep settings. A transactional `begin_archive` listener marks the
resident subtask archived for every workspace archival, including descendants and project archival.
Each side skips when the other is already decided, so repetition is harmless and they never loop.
A shared-filesystem subtask names no workspace and never archives the folder it shares.

## Archival is final for a subtask

Restoring a subtask once brought back a conversation whose workspace could be gone. People decided
that subtask archival is final, for both forms: the restoration hook, which every path that clears
`archivedAt` passes through, refuses it and the API answers `409`. Ordinary root agents and bots
remain restorable.

## Delegated work stays in its subtask

Coordinators were tempted to inspect or modify delegated work directly in another workspace.
Bot and subtask instructions, together with the creation tool's guidance, now direct coordinators
to ask the subtask agent for progress, findings, diffs, verification, and follow-up changes through
`send_agent_message`. Subtasks keep their assigned work in their own workspace and report back
through messaging. Direct access to another workspace often requires elevated permissions and
review by the reviewer model, so messaging avoids unnecessary permission reviews and preserves
ownership of the work.

## Subtasks are substantial workstreams, not small steps

Broadly preferring interactive delegation encouraged unnecessary task splitting and nesting.
Compact prompts now reserve subtasks for substantial, distinct workstreams, such as changes across
projects, while small steps stay inline and hidden subagents handle internal research. Explicit
subtask requests are honored within eligibility and depth limits. Second-level subtasks should
usually be explicitly requested by the user. These are prompt defaults, not new runtime restrictions.

## Coordinators can switch a subtask's model

Steve asked that tasks be able to change the provider and model of their subtasks, which until then
were fixed by `create_subtask`. `switch_subtask_model` lets the direct coordinator (bot, task, or
subtask) switch an active direct subtask, with the same choices and validation as creation. It
reuses the person-facing switch rather than adding one: Agent Base switches models only on a
consumed message, and the API's mode is the mode of the last submitted message, so the tool sends
a short coordinator message carrying the new model. A working subtask switches after its current
step; an idle one wakes and answers briefly, and that report doubles as proof the new model works.
Siblings, parents, grandchildren, ordinary collaborators, and archived subtasks are refused. The
guidance asks coordinators to switch only when a model is failing or wrong for the work, because
master plan 7 discourages changing an existing agent's model.

## Coordinators archive done subtasks at once

Kirill: subtasks "tend to explode and never cleaned out". Every coordinator (bot, task, or
subtask) is now told to archive a subtask with `archive_subtask` in the turn it reports back once
its work has landed or there was nothing to land, to have it push an unlanded diff to a branch
first, and not to keep idle subtasks "in case", since history stays readable and branches stay in
Git. This is prompt guidance only; nothing archives automatically.

## People arrange sibling subtasks themselves

Users wanted to drag subtasks into their own order in the sidebar, but `subtasks` was fixed newest
first. Each subtask now carries a `subtaskOrderKey` among its siblings. It is separate from the
workspace-series `orderKey`, because siblings can span workspaces and shared-filesystem subtasks
have no series entry. New subtasks are keyed before every sibling, archived ones included, so the
default stays newest first. A reorder keys unkeyed or tied siblings in their current order first,
so the result is exact. The parent then records `subtasksOrderedAt`, which publishes its complete
new list.

## Titles are short sidebar labels

Subtask session titles were too long for the sidebar. The creation tool now asks for 2–3 words,
with 4 at most and only as a last resort, and directs task details into the message text. This is
loose prompt guidance, not a runtime word-count limit or automatic truncation. Tightening it to
"1–3 words naming the subject" for the Spaces sidebar was reverted, because the tool description
reaches every person, including those who never opened that sidebar.

## Conversation subtasks have no opening task

A bot exported to Telegram needed one subtask per person, holding that person's conversation
with the bot. `create` always sends an opening task and reports to the coordinator, which fits delegated
work but not a chat someone else drives. `createConversation` creates a shared-filesystem subtask
under the same eligibility, depth, and sibling-order rules, with no opening task and no automatic
report to its coordinator. The caller's metadata, such as the exported bot flag and the first mode, is
stored beside the subtask's own fields, which always win. The calling module delivers every
message itself. The subtask is marked `subtaskConversation`, and its instructions say it holds a
conversation for its parent instead of telling it to report its progress there, which would have
sent every chat to the bot.

## A restricted bot's subtasks share its folder

A workspace-bound subtask opens a workspace in a project, which a bot kept inside its own tree may
not reach. Such a request is refused with an input error before any workspace is made. Subtasks
that share the bot's folder, and exported-bot conversations, are the bot's own work and are not
gated, so `#assertCanCreate` itself stays independent of reach.

## A module that speaks for its subtask can silence its reports

Prioritizing, the sidebar's organiser, is an ordinary subtask of Happy, but each of its turns
reported a one-line reply into Happy's chat beside the sidebar's own batch note, so Happy's chat
got narration and duplicates. `create` takes `unreported`, which stores the same "do not report to
the creator" collaboration flag `createConversation` uses; the subtask is otherwise identical, and
the calling module writes the one message its coordinator should see.

## A subtask runs in its coordinator's permission mode

Subtasks always started in Auto. `create_subtask` now settles the mode from the coordinator's
persistent mode, with the same `read_only` and `full_mode` rules as `create_agent`, when the tool runs,
and records it with the durable start: the start runs later on a context that names no agent, so
it cannot read the coordinator's mode itself. A start recorded before modes were kept uses the
product default. Module-owned subtasks (Voice, Prioritizing) and exported-bot conversations keep
their own modes. A person may still pick any mode in a subtask's own conversation.
