# Bots

Bots are persistent single-conversation assistants. This module owns each bot's immutable
username, dedicated folder and workspace identity, one root-agent identity, catalog order,
lifecycle, administrator status, and avatar. The dedicated workspace uses the username as its immutable name; changing
the bot's human display name therefore does not version or rename the workspace.

Every bot is non-admin unless its authenticated API creator explicitly sets `isAdmin`. The
`create_bot` tool remains visible to every direct bot, but rejects calls from non-admin bots with
an explanation that names the admin bots on the installation when any exist. The tool does not
expose `isAdmin` in its input, so an admin bot can create only non-admin bots. Human-owned root
agents remain unrestricted.

`set_bot_avatar` and `set_bot_name` default to the acting bot, and any bot may also pass its own
`botId`. Active admin bots may pass any bot's ID, including an archived bot's; another bot naming
someone else is refused with the admin bots listed, as `create_bot` does, and an ID naming no bot is
explained. Images must always come from the acting bot's own folder. Authorization is rechecked in
the write transaction. `set_bot_avatar` writes exactly what the avatar route writes, and
`set_bot_name` goes through the same rename as `PATCH /v0/bots/:botId`: the same name rules, the
conversation title follows, automatic naming ends, and the username stays. Both publish
`bot_updated` and advance the version. `list_bots` shows whether each bot has an avatar and accepts
optional `hasAvatar` to filter the roster (`false` finds bots without pictures).

On first startup, the module creates one admin bot named `Happy` with an ordinary generated ID,
the bundled avatar, and the internal system key `chief_of_staff`. The bot row,
normalized avatar asset, agent, workspace, folder, and creation event are one initial creation, so
clients never observe a newly seeded Happy bot without its picture. A separate seed ledger
records that this system bot was created and deliberately survives deletion, so neither archival
nor deletion causes startup to replace it or backfill a picture. No instruction is stored in the
database. The bots module uses the system key to inject the current source guidance on every
inference, so an upgrade updates its built-in instructions while preserving its identity and
conversation. Future built-in bots receive their own system keys and seed-ledger entries through
the same path.
The bot was named `Chief of Staff` before it became Happy, and the system key keeps that history.
When the seed ledger already exists, startup renames the bot to `Happy` once, only while it still
has the old seeded name, through the ordinary rename path. A rename ledger records that it ran, so
a person's later choice of name, including `Chief of Staff`, is never overwritten.
`chiefOfStaff(ctx)` returns the Happy bot by that key, whatever it is named now, so other
modules can address it; the exported bots module sends it access requests.

A bot's one agent is born with its conversation title set to the bot's display name, and renaming
the bot renames the conversation with it: a bot is one continuous chat, so its session is called
whatever the bot is called rather than waiting for a generated title. A titled agent is never
renamed by automatic naming, so bots keep that name. The title change advances the agent's own
version and arrives as an `agent.updated` event, separately from the bot's version.

A client may create a bot without supplying a name. The daemon supplies `New Bot` internally;
there is no public naming flag. That bot is usable immediately; its first
accepted user message starts detached naming work while its real turn continues. The naming prompt
asks for a one-to-three-word person, role, or character identity based on the likely ongoing
function, rather than a task title. The result renames both the bot and its conversation. Explicitly
named bots, built-ins, and bots renamed while inference is running are never overwritten.

Creation also accepts optional bot, workspace, and agent IDs. All three are reserved together and
checked against the bot, project, workspace, and agent catalogs, including archived records.
Repeating the bot ID returns its current state; supplied child IDs must match the stored ones.
`createWithResult` reports whether the transaction created the bot so an API retry does not repeat
discovery or publish creation again. Folder failure rolls the entire creation back.

On every inference, the module adds the owning bot's current display name, immutable username,
and stable bot ID to that bot agent's system instructions. It contributes nothing to ordinary
agents, and a rename reaches the bot on its next turn without changing its agent identity.

Every agent offered the bot tools is told to mention a bot as `[name](happy://agents/<agentId>)`
with the bot's agent ID, never its bot ID, and `create_bot` and `list_bots` give that exact link.
Clients show the bot's live name as the link text.

Bot routes are available regardless of `features.workspaces`. That flag continues to gate the
shared `/v0/workspaces` HTTP and model-tool surfaces, while bot creation, listing, lifecycle, and
agent messaging remain usable. When workspace routes are enabled, a bot's unlisted dedicated
workspace is addressable by ID for files, terminals, and the workspace proxy.

## Bot settings

Each bot carries the owner's settings, stored by the bot settings module against the bot's agent:
a secret allowlist, whether its agents keep the installation's reach or stay inside the bot's own
tree, and whether they run on the host or in a Docker image. They govern the bot's agent and every
agent working under it, and each owning module enforces its part.

Active admin bots are offered `get_bot_settings` and `update_bot_settings`, both taking `botId`;
the catalog checks admin status again in `settingsForAgent` and `updateSettingsForAgent`.
`update_bot_settings` takes `previous`, exactly what `get_bot_settings` returned, plus only the
fields to change, and applies the change only while `previous` is still stored, otherwise it
raises `BotConflictError` with the current value. The tool needs Auto or Full access. In Auto, a
change that only narrows is not reviewed; one that widens is, and the review names each widening.
`updateSettings` is the owner's direct path and merges a patch into whatever is stored.

A bot kept inside its own tree is offered neither the roster tools nor the bot reference
instructions, its tasks lose them too, and `sendMessage` refuses it. It keeps `set_bot_avatar`.

## Tasks

Bots create tasks through the tasks module's `create_task`; bot and task identities are reserved
against each other. A task's agent gets `list_bots` and `send_bot_message` but not `create_bot` or
`set_bot_avatar`, and when a bot created the task its instructions name that bot as the one to
report to.

## Permanent deletion

`purge(ctx, botId)` deletes an archived bot for good, for an admin's permanent deletion: its
folder, then its row and picture in one transaction that publishes `bot_deleted`. Its agent is the
caller's to erase first. The built-in seed ledger stays, so a deleted built-in bot is not seeded
again.

## Runners

While runners are configured, a new bot's folder is created on the default runner, recorded as the
bot's `runnerId`, and its agent runs there. The Happy bot waits for the default runner to
connect for the first time before it is seeded, because its folder has nowhere else to go.
