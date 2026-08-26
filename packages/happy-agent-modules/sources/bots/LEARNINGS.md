# Bots — learnings

## Bot workspaces are intentionally outside the project workspace tree

A bot folder has no project, parent, branch, or sibling workspace series. Its dedicated workspace
identity is durable in the bot catalog and projected through the workspace API, but is absent from
project workspace listings and bootstrap's workspace array. This also keeps bot routes operational
when the optional project-workspaces feature is disabled.

## Bot agents receive their live bot identity

The generic agent prompt still identifies the underlying runtime as Happy Agent. The bots module
adds the current bot display name, immutable username, and stable bot ID only for the bot's own
agent, making the bot identity explicit without affecting ordinary agents. The contribution reads
the catalog on each inference so renaming a bot reaches its next turn immediately.
