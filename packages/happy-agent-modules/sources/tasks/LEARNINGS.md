# Tasks — learnings

## Tasks replaced the checklist tools

The `tasks` module used to be a per-agent checklist with `create_task`, `list_tasks`, `get_task`,
`update_task`, `complete_task`, and `remove_task`. People asked for it to be removed: "make a
task" should create a real conversation someone can open, not a list entry. The checklist tools,
schemas, events, and docs are gone. Its released migration key stays first so databases that
applied it still start, and a new migration drops its table.

## A task is a bot without an avatar, with an owner

People described tasks as "bots but not bots": no avatar, an owner who created them in team
chats, a dedicated folder each, otherwise like bots. The module therefore copies the bot
lifecycle (one root agent, immutable folder, dedicated workspace identity, versioned archival
and restoration, messaging) and leaves out avatars, administration, and system keys.

Steve then asked why task workspaces, files, terminals, creation, and rename were missing:
"just like bots". A task's workspace is now a real workspace of kind `task` that every folder
route serves (files, terminals, Git) while its lifecycle routes refuse, exactly as for a bot.
People create tasks through `POST /v0/tasks` like bots, owning them in team mode and joining at
the top of their list, and anyone may rename one. An unnamed task is `New Task` and names itself
once from its first text-bearing message — a person's, or the creating agent's opening text with
its sender line removed. A rename, even to the same name, ends automatic naming, and wins over a
naming request that is still running. Tasks created before naming existed keep their names as
chosen.

## New naming jobs survive a failed request; existing names are left alone

A one-shot attempt flag was committed before detached inference, so a temporary provider failure
left a task called `New Task` permanently. New first-message naming now commits a Durable Functions
job with that flag. The job persists its three-attempt budget before each provider request, waits
one then five seconds between failures, and resumes after a restart. After the budget is spent it
uses a short, cleaned excerpt of the same first message. The task and its conversation title change
together, only while the task is active and its name remains unconfigured. Eligibility reads and
database writes are outside the provider-error retry boundary.

The user explicitly asked to leave existing names alone: no startup scan, backfill, or clearing of
old attempt flags. Later messages never start another job. Stem Cells controls Prioritizing, not
ordinary task naming; turning it off does not disable this path.

## A conversation an agent opens runs on that agent's model

A bot's `create_task` with opening text failed on its first turn with "A model is required for
Codex inference." Agent Base gives a new agent no model; the first message names one, and a
person's message always does. The opening text and `send_task_message` carried none, so a task
an agent spoke to first had nothing to run on. Now any delivery to a task that has never been
given a mode carries the sender's provider, model, effort, and service tier — or the
installation's default model when the sender's is no longer offered — with Agent Base's default
permission mode, stamps it on the message, and records it as the task's last mode, as the API does
for a person's message. A task that already has a mode keeps it, so an agent's later message never
overrides a person's choice. Tasks created before the fix have no mode and are repaired by their
next agent message; a person's message repairs them as always. Nothing is migrated.

## Task order belongs to each person, not to the catalog

Steve asked for tasks to be reorderable per user, for anyone to join a task and see it in their
list, and for both a global and a per-user list. A single catalog order, as bots have, would let
one person's drag move everyone's list. Order now lives on a membership row per task and person;
reordering touches only the caller's row, and the task's own version does not move. The owner
joins at creation so their new task appears without a separate step, and a fresh membership goes
to the top, where new work is expected. The global list has no order of its own and is shown
oldest first. A standalone installation is one person, so it uses one fixed member key rather
than inventing a user ID.

## Leaving a task is not archiving it

Steve asked that closing a task in the sidebar mean leaving it, with archiving a separate,
deliberate action. Leaving only removes the caller's membership: the task stays active even when
its owner or its last member leaves, and archiving leaves every membership in place. People may
archive a task through the API when they own it or own the team, and the standalone person may
archive every task; everyone else gets a refusal. The API tells each caller whether they may with
`canArchive`, which is computed per request and never sent in events that reach every member.

## Automatic participation respects explicit leaves

Default task participation must not undo a leave. Tasks now retains a per-person exclusion even
when the person leaves before joining, and an explicit join clears it. Automatic joins skip those
exclusions and existing memberships, preserving list order across restarts and preference changes.
Catalog events reserve their post-commit notification before transactional membership listeners
run, so clients receive task creation or restoration before the resulting automatic joins.

## Ownership follows the human the agent is working for

A bot creates tasks on someone's behalf, and in a team chat that someone changes from message to
message. The owner is the latest identified human sender in consumption order, not the latest
accepted message, so a message waiting in the queue cannot claim a task created for an earlier
request. Agent messages never move it; an unidentified human clears it rather than leaving the
previous person as owner. Standalone installations record no owner.

The module keeps this in its own per-agent store instead of reading Team's, because modules may
not reach into another module's store, and depending on `TeamModule` would close a cycle through
`ProfileModule` and `BotsModule`. The model sees the owner's user ID, which Team's sender
notifications already pair with the person's name.

## Tasks are roots of subtasks; existing subtasks are unchanged

People said tasks can have subtasks. Subtasks already had the right shape: user-visible,
parent-managed, sharing a folder or in a project workspace, two levels deep. A task is now a
second kind of root beside a bot, with the same depth limit and coordinator guidance, and bots
keep creating subtasks directly. Making subtasks exist only under tasks would have contradicted
the agents master plan, which says bots create subtasks; the API specification now names tasks as
a second subtask root.

## A task must not widen what its creating bot may do

Bot tools are offered to every root agent, and `create_bot` is unrestricted for human-owned
roots. Task agents are roots too, so a non-admin bot could have created bots through a task it
created. `BotsModule` takes this module and gives task agents only `list_bots` and
`send_bot_message`. The dependency points that way so the tasks module never needs to know bots;
it records the creating agent's ID, and the bots module names the creating bot to the task.

## A task is mentioned by its agent ID

Kirill asked for tasks to be clickable in chat. A Happy link names the conversation a client
opens, so a task is mentioned as `[name](happy://agents/<agentId>)` with its agent ID, never its
task ID, which no route opens as a conversation. `create_task` and `list_tasks` hand back the exact
link,
and the agents offered the task tools are told to use it, so a model never has to work out
which of the two IDs goes in it.

## A task stays governed by the bot that opened it

Tasks are root agents, so working through a task would have escaped the opening bot's settings.
A task created by an agent is linked to its creator's tree in the creation transaction, and the bot
settings module treats it as part of that tree from then on. A bot kept inside its own tree is also
not offered the task tools, since tasks belong outside any one tree.

## Native task model selection seeds idle drafts and stamps opening text

Tasks previously ran on whatever model the creating agent was running on, with no way to choose a
model at creation time. An idle task recorded no model at all until a message was sent; a working
hypothesis is that Desktop's composer fell back to its default model (such as GPT-6.1 Sol) because
neither stored mode nor draft was populated in agent metadata on creation. Verification of Desktop
model picker, draft, and team-mode behavior belongs to a separate Desktop workstream coordinated by
Chief, which owns Desktop tests and fixes.

On the daemon side, `create_task` now accepts optional `model`, `effort`, `harness`, `provider`, and
`serviceTier`, resolved through `CollaborationModule.selectAgentModel` identically to `create_agent`
and `create_subtask`. When created with opening text, the chosen mode is stamped directly onto the
opening message and persisted as `lastMode`. When created idle, `lastMode` stays unset until an
accepted message arrives; the explicit creation choice is stored as internal `initialMode` metadata,
and an empty-text composer draft is seeded atomically in agent metadata on standalone installations
or in `TeamModule` per-user draft storage for the task owner on team installations. When the first
accepted message arrives, it records its actual mode to `lastMode` and clears `initialMode`; the
first agent-role delivery does not clear the creation draft (only user draft saves mutate draft
storage). If an
agent sends the first message to an idle task whose explicitly chosen model, effort, or service tier
is no longer available, delivery fails with an actionable error rather than silently mixing modes.

## A message to a task carries the mutation of the run that sent it

A message an agent sent a task, including the task's opening message, carried no `mutationId`,
so the task's run echoed nothing although the sending run answered a client's mutation. The
message now carries that run's mutation, read from History when it is sent.

## A message to a task says what it is

A message an agent sent a task showed only "Message from <agent>" until opened.
`send_task_message` now requires the same 2–8 word `explanation` as `send_agent_message`, stamped
as `senderAgentExplanation` beside the sender, and a named task's opening message uses the task's
name. An unnamed task's opening message has none; `sendMessage` keeps it optional for direct
callers.

## Joining at the top must not grow keys

Every new task joins its member's list one key before the first task. The shared key helper took the
midpoint below that key, so each join added a digit every three joins; after about 190 tasks the key
passed the 64-character bound, and the next join, or `POST /v0/spaces/stem-cells`, failed with "Task
storage contains an invalid membership". A key at an open end of a list now steps one unit past its
neighbour, so a list taking work at the top grows keys with the logarithm of its length.
`006-task-order-keys-renumbered` gives a list that already holds a key past half the bound fresh,
short keys in its existing order; nothing else changes, and only those lists are read.

## A task an agent opens never runs wider than that agent

`create_task` and an agent's first message to a never-run task always gave the task Auto, so a
Read only agent could start Auto work through a task, and a mode a person chose at creation was
ignored. Both now use the mode chosen at creation, or else Auto, narrowed to the creating or
sending agent's mode. A task is a person's own root rather than the agent's child, so a Full
access agent does not pass Full access on; the person picks the mode once they open it.
