# Bot catalog learnings

Bot, dedicated workspace and ordinary root agent identities must be distinct and
reserved together. The bot ID alone deduplicates creation; a retry returns the
current catalog row and refuses mismatched supplied child identities. Every read
that justifies creation uses the caller's transaction. The unique catalog columns
accept the row before the folder is created, so folder failure rolls back the
agent, catalog and notifications together. An existing directory can be adopted
after a rolled-back creation.

The Chief of Staff uses an ordinary generated identity and the durable
`chief_of_staff` system key. Its separate permanent seed ledger survives archival
and removal of its catalog row. Startup never recreates a seeded coordinator or
backfills its original avatar. Avatar decoding happens before creation, and the
normalized bytes and metadata commit with the first catalog row. Current system
instructions are read from the module on every inference, rather than persisted
as a prompt profile.

Omitting a name creates an immediately usable placeholder. Only its first accepted
text-bearing user message claims the original naming-attempt key. The claim
commits before bounded optional naming starts. A manual rename, including the same
placeholder name, permanently settles eligibility; a delayed result checks that
flag again in its write transaction. Bot and conversation names change together.
Username, folder and dedicated workspace remain immutable, and rename does not
advance the workspace version.

Bot tools capture the acting agent from their scope. Creation checks that bot's
administration flag and cannot grant administration to a new bot. Avatar tools
check active status and authority before reading the image and again when writing
it. Image paths resolve inside the acting bot's own folder. An active admin may
update another bot's picture, including an archived bot. Common tools and their
permission policies apply identically to every inference provider.

Bot workspaces are durable identities in this catalog, outside the project
workspace tree. They appear through their bot and direct workspace lookup, rather
than project or workspace listings. Archival retains the folder and history.
Bot event publication uses the original typed event after commit; the API owns
the public bot, agent and dedicated workspace projections.

Bot instructions prefer project workspace subtasks for repository work, including
small tasks. A request to make a task means a user-visible subtask unless the
person explicitly asks for a checklist. Delegated work remains with that subtask's
agent and is coordinated through messages. Windows bots use a separate remote
installation for WSL work. Recipe guidance is executed within existing user
authority and never supplies authorization by itself.
