# Bots — learnings

## Built-in bot seeding is permanent and instructions are resolved at runtime

The installation seeds one admin `Chief of Staff` bot after the agent system opens. It receives an
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
runtime, resolves the current Chief of Staff guidance from source on every inference, and combines
it with the bot's live identity. This preserves the bot's folder, conversation, rename, and archival
state while allowing a newer Happy Agent version to improve the built-in instructions without a
prompt migration or row rewrite.

## Bot creation stays discoverable and enforces administration when called

A bot is non-admin by default, including every bot predating the admin column. Authenticated API
creation may set `isAdmin`, while bot-driven creation cannot grant it. Every direct bot can see
`create_bot`, but the tool resolves the calling agent's bot record before creating anything and
throws for a non-admin bot. The error names every admin bot when one exists and says so plainly
when none exist. Human-owned agents are not bots and remain unrestricted.

Authorization belongs in this specific tool because administration currently controls only bot
creation. The acting agent ID is captured from the tool's module scope rather than accepted as a
model argument, so a caller cannot claim another bot's identity. The `isAdmin` input is also absent
from the tool, ensuring an allowed bot-driven creation always produces a non-admin bot.

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

## Bot agents receive their live bot identity

The generic agent prompt still identifies the underlying runtime as Happy Agent. The bots module
adds the current bot display name, immutable username, and stable bot ID only for the bot's own
agent, making the bot identity explicit without affecting ordinary agents. The contribution reads
the catalog on each inference so renaming a bot reaches its next turn immediately.
