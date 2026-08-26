# Bots — learnings

## Bot workspaces are intentionally outside the project workspace tree

A bot folder has no project, parent, branch, or sibling workspace series. Its dedicated workspace
identity is durable in the bot catalog and projected through the workspace API, but is absent from
project workspace listings and bootstrap's workspace array. This also keeps bot routes operational
when the optional project-workspaces feature is disabled.
