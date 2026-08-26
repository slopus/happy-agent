# Bots

Bots are persistent single-conversation assistants. This module owns each bot's immutable
username, dedicated folder and workspace identity, one root-agent identity, catalog order,
lifecycle, and avatar. The dedicated workspace uses the username as its immutable name; changing
the bot's human display name therefore does not version or rename the workspace.

On every inference, the module adds the owning bot's current display name, immutable username,
and stable bot ID to that bot agent's system instructions. It contributes nothing to ordinary
agents, and a rename reaches the bot on its next turn without changing its agent identity.

Bot routes are available regardless of `features.workspaces`. That flag continues to gate the
shared `/v0/workspaces` HTTP and model-tool surfaces, while bot creation, listing, lifecycle, and
agent messaging remain usable. When workspace routes are enabled, a bot's unlisted dedicated
workspace is addressable by ID for files, terminals, and the workspace proxy.
