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
