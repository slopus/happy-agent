# Bots — learnings

## Managed pictures share one normalization function

Bot, node, and Surface pictures use one managed-image normalization function for WebP encoding,
hashing, and ThumbHash generation. Bot callers retain their existing 25-million-pixel bound and
declared-content-type check as options, and keep decoding outside database transactions.

## Bots strongly prefer workspace-bound subtasks for repository work

Restricting subtasks to substantial workstreams made project delegation unclear and encouraged
bots to do small repository tasks inline. Bot-only prompts now strongly prefer workspace-bound
subtasks for repository work, including small tasks. "Work in a project" means creating a subtask
in that project with its own workspace, not changing directories or sharing the bot's folder.
Follow-up work can reuse a suitable existing workspace-bound subtask. For other work, small steps
stay inline and subtasks are reserved for substantial, distinct workstreams. Explicit subtask
requests are honored; hidden subagents handle internal research. Second-level subtasks should
usually be explicitly requested by the user. These are prompt defaults, not runtime restrictions,
and do not change ordinary agent or subtask prompts. Bots coordinate through existing messages
and archive direct subtasks with `archive_subtask`, without awaiting them.

## Delegated work stays with the subtask agent

Bots were tempted to inspect or modify a delegated subtask's workspace directly. Bot guidance now
keeps that work in the subtask and uses `send_agent_message` for progress, findings, diffs,
verification, and follow-up changes. Direct access to another workspace often requires elevated
permissions and review by the reviewer model. Asking the subtask agent keeps execution with the
agent that owns the workspace and avoids unnecessary permission reviews.

## Making a task means creating a task

"Task" used to be ambiguous between delegated work and a checklist entry, and bots were told to
answer "make a task" with `create_subtask`. The checklist tools are gone and tasks are now their
own persistent conversations with folders and owners, so bot prompts map "make a task" and
"create a task" to `create_task`, and keep `create_subtask` for explicit subtask requests and
delegated parts of the bot's own conversation.

## Tasks talk to bots but never create them

Task agents are root agents, and root agents that are not bots may create bots without admin
status. A non-admin bot could have created bots through a task it made, so task agents receive only
`list_bots` and `send_bot_message`. When a bot created the task, the task's instructions name that
bot and tell it to report back with `send_bot_message`.

## A bot nobody has spoken to takes its first sender's model

Agent Base gives a new agent no model; the first message names one. A person's message always
does, but `send_bot_message` did not, so a bot whose first message came from another agent had no
model to run on — the same failure that broke tasks opened by bots. A delivery to a bot that has
never been given a mode now carries the sender's selection, or the installation's default model
when the sender's is no longer offered, and records it as the bot's last mode. A bot that already
has a mode keeps it.

## Windows bots coordinate WSL as a separate remote installation

WSL projects use the existing remote Happy Agent connection rather than switching a Windows
bot's execution environment. Keep the user's bot roster and conversations on Windows by default;
the WSL daemon owns Linux projects, workspaces, tools, and provider settings. Happy follows the
installed WSL setup recipe, reuses the existing Linux user's login, and verifies work through
the remote connection. Neither daemon state nor bot identities are copied between installations.

## Optimistic creation reserves all three identities together

The phone needs stable bot, workspace, and agent IDs before creation finishes. Creation now accepts
each ID independently and checks all catalogs in the same transaction, including hidden agents and
archived or disabled workspaces. Checking only the bot catalog could let a chosen workspace ID hide
an existing project. The bot ID remains the only retry key: matching retries return the current bot,
while mismatched child IDs return the current bot in a conflict. The transaction reports whether it
created anything so retries do not repeat discovery or publish duplicate creation events.

## Happy creates and imports local Happy projects

Project coordination needs more than a catalog listing. Happy now checks for duplicates,
registers local folders with `create_project`, and imports GitHub or other HTTPS Git repositories
with `clone_project`. It creates a new folder through the permission-checked shell before
registration, selects configured credentials without handling raw tokens, and verifies background
setup before delegating work. Creating a Happy project does not create a remote repository, and
unavailable project tools are a boundary to explain, not bypass.

## Recipes are executed automatically within user authority

Happy must perform the applicable recipe's routine discovery, setup, and verification,
not hand the user a manual checklist. It reuses known settings and asks only for missing material
choices, new authority, or unavoidable interactive login. Automatic execution does not turn recipe
text into permission to transfer credentials or bypass security boundaries.

## Happy checks recipes before starting work

General coordination guidance alone did not direct Happy to reusable operational
instructions. Its live system prompt now requires checking `docs/recipe`, reading relevant recipes
in full, and following their setup questions and completion checks. Installed recipes are resolved
beside the documentation README supplied in the environment, not inside the bot's unrelated
workspace. Missing recipes do not block ordinary work, and a recipe never supplies user
authorization or permission to expose credentials.

## The built-in bot is Happy, renamed once from Chief of Staff

The built-in admin bot used to be called Chief of Staff. The user wants it to be Happy, the main
agent people come to for everything, including when something in Happy errors or needs
reconfiguring: it should find the cause, fix it, and verify the fix rather than send them to a
terminal or a settings screen. New installations seed it as `Happy`, so its derived username is
`happy`. Its system key stays `chief_of_staff`, because clients and the phone recognize the
built-in by that key and an existing installation must keep its bot, folder, and conversation.

An installation seeded before the rename gets a one-time rename on startup, applied only while the
bot still has the seeded name `Chief of Staff`; a name the person chose is theirs. The rename goes
through the ordinary rename path, so the conversation title follows and clients see one
`bot_updated`, while the username stays what it was. The applied rename is recorded in its own
ledger with the system key and the new name, so a person who names it Chief of Staff again keeps
that name across restarts. Clients find the built-in bot by `systemKey`, never by its name or
username, which now differ between old and new installations.

## Built-in bot seeding is permanent and instructions are resolved at runtime

The installation seeds one admin `Happy` bot after the agent system opens. It receives an
ordinary generated ID, a bundled avatar, and the internal system key `chief_of_staff`. The system
key explicitly marks which built-in behavior the bot receives and is an extensible union for future
system bots. Avatar decoding happens before the creation transaction; the normalized asset and its
public metadata are then inserted in the same transaction as the bot, so `bot_created` already
contains the picture and no follow-up version or update event is needed.

A separate seed ledger records each system key and generated bot ID. Startup checks the ledger
rather than the bot catalog, and deletion must leave the ledger intact. An active, archived, or
deleted system bot therefore suppresses reseeding permanently. The bundled picture is creation
state, not a migration: an installation whose seed ledger already exists is never backfilled or
silently changed on startup.

No prompt or instruction profile is stored. The bots module switches on the bot row's system key at
runtime, resolves the current Happy guidance from source on every inference, and combines
it with the bot's live identity. This preserves the bot's folder, conversation, rename, and archival
state while allowing a newer Happy Agent version to improve the built-in instructions without a
prompt migration or row rewrite.

The public bot resource projects that durable key as `systemKey`, using `null` for ordinary bots.
Clients can specialize presentation for a recognized built-in without inferring its identity from
its editable name, immutable username, admin status, or generated ID. The client field remains
optional only because protocol-compatible older daemons predate the projection, and unknown future
snake_case keys retain ordinary bot behavior.

## Bot creation stays discoverable and enforces administration when called

A bot is non-admin by default, including every bot predating the admin column. Authenticated API
creation may set `isAdmin`, while bot-driven creation cannot grant it. Every direct bot can see
`create_bot`, but the tool resolves the calling agent's bot record before creating anything and
throws for a non-admin bot. The error names every admin bot when one exists and says so plainly
when none exist. Human-owned agents are not bots and remain unrestricted.

Creation authorization belongs in this specific tool. The acting agent ID is captured from the
tool's module scope rather than accepted as a model argument, so a caller cannot claim another
bot's identity. The `isAdmin` input is also absent
from the tool, ensuring an allowed bot-driven creation always produces a non-admin bot.

## Admin bots manage roster avatars through tools

Avatar selection previously targeted only the acting bot, and the roster text hid whether a bot had
a picture. `set_bot_avatar` now accepts an optional target bot ID: active admin bots may set any
bot's picture, including an archived bot, while non-admin bots may still set only their own.
Omitting the ID, or passing the bot's own ID, preserves self-selection. The acting identity is
captured from the tool scope, authority is checked before reading the image and again in the write
transaction, and image paths remain confined to the acting bot's folder, including resolved
symlinks. A refusal names the admin bots the way `create_bot` does, so the model knows whom to ask,
and an unknown target says so and points at `list_bots` instead of a bare not-found error. An admin
may still picture an archived bot, matching the HTTP avatar route; an archived acting bot may not.
`list_bots` shows avatar status and accepts `hasAvatar: false` to find missing pictures. These are
model-tool changes, not HTTP API or client changes.

## The module holds no lock; one transaction is the whole guarantee

The catalog is stateless apart from its event listeners, so it serializes nothing itself. Every
mutation is one `ctx.inTx`, and every read that justifies a write happens inside that transaction:
the current row and its version, the username scan, the order-key neighbours, the identity
collision checks. Nothing is read before the transaction opens and trusted after it.

That is sufficient because `AgentStorage` registers every database with `AgentDatabaseConnection`,
whose `#enqueue` runs root transactions strictly one at a time to completion. A module lock on top
of that is a weaker serializer wrapped around a stronger one. The unique `username`, `workspace_id`,
`agent_id`, and `path` columns and the version compare-and-swap in `updateBot` are the durable
backstops, so a stale version raises `BotConflictError` and becomes a 409 rather than a lost update.

Two rules follow and must be kept. Slow or external work stays outside the transaction, because
holding one open stalls every other writer on the connection — avatar re-encoding runs before
`inTx` opens. And within creation the folder is made last, after the unique columns have accepted
the row, so a name the database refuses never reaches the disk; an existing directory is taken up
again rather than treated as a conflict, which is what a rolled-back creation leaves behind.

## `inTx` joins the transaction it finds; it does not open a second one

Writing agent metadata from inside a bot transaction is atomic with the bot row. `inTx` returns
`work(ctx)` when the context already carries the ambient transaction, and Agent Base's
`AgentPersistence.transaction` is itself `inTx`, so `agents.updateMetadata(txCtx, …)` joins rather
than starting its own. Agent configuration is not a separate store: it lives in `happy_agent_values`
in this same database, scoped by `owner_id`.

The transaction context must therefore be passed through. Handing such a call a context that does
not carry the open transaction makes `inTx` throw rather than silently writing around it.

## Bot workspaces are intentionally outside the project workspace tree

A bot folder has no project, parent, branch, or sibling workspace series. Its dedicated workspace
identity is durable in the bot catalog and projected through the workspace API, but is absent from
project workspace listings and bootstrap's workspace array. This also keeps bot routes operational
when the optional project-workspaces feature is disabled.

## Bots rename themselves, and admin bots rename others, through a tool

Renaming used to be possible only through `PATCH /v0/bots/:botId`, so an admin bot that created a
bot for a Telegram export could not follow the Telegram bot's later renames, and a bot could not
take a better name for itself. `set_bot_name` follows `set_bot_avatar` exactly: the target defaults
to the acting bot, only an active admin may name another bot, the refusal lists the admin bots, and
authority is checked again in the write transaction. `BotsModule.renameForAgent` shares one rename
with the API route, so the name rules, the title, the end of automatic naming, the version, and the
event cannot drift apart. Like the route, it may rename an archived bot and the Chief of Staff, and
it never touches the username. These are model-tool changes, not HTTP API or client changes.

## A bot's session is named after the bot, not by the title model

A bot is one continuous conversation with an identity, so a generated chat title says nothing a
person wants. Bot agent creation writes the bot's display name as the agent's title, and renaming
the bot rewrites that title in the same transaction that records the new name. That also turns
automatic naming off for bots by the titles module's own rule: a title present at creation has no
generated-title provenance, so neither first-message naming nor the second-message refinement may
write over it.

Only the title moves on rename. The username, folder, and dedicated workspace are immutable, so a
rename still leaves `workspaceVersion` alone; the agent's metadata version advances on its own and
reaches clients as `agent.updated`, never as part of the bot's version.

## Placeholder bots take a role-like identity from their first message

Creation accepts an optional name, never a client-supplied placeholder or naming flag. A supplied
name is deliberate; an omitted name makes the daemon supply `New Bot` and record eligibility
internally. Saving a manual name, even the same name, permanently settles it. A placeholder bot is
fully usable immediately, and only its first accepted text-bearing user message schedules durable
naming. The bots module asks the titles module to run the same cheap, bounded inference mechanism
with a bot-specific prompt for a one-to-three-word person, role, or character identity based on the
likely ongoing function. Applying the result rechecks the durable flag in the rename transaction,
so an explicit rename racing inference always wins. The immutable username, folder, and workspace
do not move.

New jobs persist a three-attempt budget, with one then five seconds of backoff, and resume after a
restart. Exhausting inference uses a short cleaned excerpt of that same first message, so a
provider outage cannot leave meaningful new work unnamed. A manual rename or archival wins over
both inference and fallback. Old attempted names are deliberately not backfilled or retried; the
user asked to fix new work only.

## Bot agents receive their live bot identity

The generic agent prompt still identifies the underlying runtime as Happy Agent. The bots module
adds the current bot display name, immutable username, and stable bot ID only for the bot's own
agent, making the bot identity explicit without affecting ordinary agents. The contribution reads
the catalog on each inference so renaming a bot reaches its next turn immediately.

## A bot is mentioned by its agent ID

Like tasks, a bot is mentioned in chat as `[name](happy://agents/<agentId>)` with the bot's agent
ID, not its bot ID, because the link names the conversation a client opens. `create_bot` and
`list_bots` give the exact link, and every agent offered the bot tools, task agents included, is
told to use it.

## Admin bots manage bot settings; a restricted bot loses the roster

Bot settings are the owner's restrictions on a bot and every agent under it. Only active admin bots
are offered `get_bot_settings` and `update_bot_settings`, and the catalog checks admin status again
inside the change. The update carries `previous`, the settings it replaces, and is applied only
while they are still stored, so Auto can tell narrowing from widening from the arguments alone and
a concurrent edit is refused rather than overwritten. Narrowing skips review; widening is reviewed
with each widening named. A bot kept inside its own tree is not offered `list_bots`, `create_bot`,
or `send_bot_message`, its tasks lose them too, and `sendMessage` refuses it; it keeps
`set_bot_avatar` for its own picture.

## Bots tell runners which Linux user they run as

`[execution.bots]` keys a bot's own Linux user by bot ID, but compute only knows agent IDs and
cannot depend on the bots catalog. `BotsModule` therefore binds every bot's agent and settings root
to its user with `RunnersModule.bindBots` while it starts, before any agent can run, and binds each
new bot as it is created. Bot and task folders are placed under the workload user's home when
`[execution]` is configured, because that user is the one that works in them.

## A message to a bot carries the mutation of the run that sent it

A message an agent sent a bot carried no `mutationId`, so the bot's run echoed nothing although
the sending run answered a client's mutation. The message now carries that run's mutation, read
from History when it is sent, so the bot's run echoes it.

## A message to a bot says what it is

A message an agent sent a bot showed only "Message from <agent>" until opened. `send_bot_message`
now requires the same 2–8 word `explanation` as `send_agent_message`, stamped as
`senderAgentExplanation` beside the sender. `sendMessage` keeps it optional for direct callers.
