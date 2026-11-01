# Bot settings — learnings

## Stories is an opt-in bot setting

Each bot's Stories switch defaults off and lives in these settings, rather than depending on
the last sender's personal preference. The bot's own agent checks it once when tools are
assembled. Personal Stories settings still decide who can see the bot's stories. Bot PATCH
uses the same edit authority as rename and publishes the normal versioned bot update.

## Settings live in a leaf module keyed by the bot's agent

Secrets, compute, history, collaboration, projects, workspaces, tasks, subtasks, and scheduling all
enforce a part of a bot's settings, and most of them are built before the bots catalog, which
depends on several of them. None of them can take `BotsModule` as a constructor dependency. The
settings therefore live in this module, which needs nothing but the agent collection, and are
keyed by the bot's own agent ID rather than its bot ID. Every enforcing module takes this module
and asks it; the bots catalog decides who may change settings and calls `write`.

## Governance follows the tree, and adopted roots keep their tree

A descendant is governed by whatever governs the root of its tree, so subtasks, collaborators,
workflow agents, and exported-bot conversations need nothing copied to them. Tasks are root agents,
so a bot could have escaped its settings by opening a task and working through it. A task created
by an agent is now linked, in its creation transaction, to the root of its creator's tree, and that
link is never moved. A chain of links is followed to its end, so a task opened by such a task stays
with the same bot.

## Reach only narrows the installation setting

`features.cross_workspace` stays the installation's switch. A bot's `crossWorkspace: false`
narrows it for that bot's agents; `true` leaves it as it is and never turns it on. Inside the bot's
own tree agents still reach one another by ID, and direct parent and child messaging is always
allowed. The restriction is on what the bot's agents reach: an agent the bot does not govern may
still message into the bot.

## The allowlist bounds every grant, not only the agent's own

Secrets reach a command from project, workspace, and agent attachments, and the agent's own
attachments were never the only path. Filtering only the tools would have left inherited project
and workspace grants usable, so command resolution now filters the default selection by the
allowlist and refuses an explicit selection outside it, wherever the secret was attached. A bot
with any allowlist cannot create secrets, since a new secret is outside every allowlist.

## Unreadable restrictions fail closed

A stored row that does not parse, or ancestry with a cycle or past the depth bound, throws instead
of reading as "no restriction". A corrupt restriction must stop work, not silently lift itself.

## The update tool names what it replaces

Auto review decides from the tool's arguments before anything runs, so it cannot read the stored
settings to tell narrowing from widening. `update_bot_settings` therefore takes `previous`, the
settings it replaces, and the catalog applies the change only while `previous` is still stored.
A change that only narrows skips review; one that widens is reviewed with each widening named.
The tool requires Auto or Full access because it changes agents outside the current workspace,
which no restricted mode can contain, and an unreviewed widening in Workspace write would bypass
the review entirely. Only active admin bots are offered it, and the catalog checks again.

## Compute is chosen when a machine is built

A running machine is never moved between the host and a container, so the compute setting is read
only while `ComputeModule` builds an agent's machine. New agents get the new compute at once;
running agents get it after a restart. A workspace that already runs in Docker keeps its own image,
because its setup depends on it. Docker machines refuse attached secrets, so a bot that needs
secrets in commands has to stay on the host for now.
