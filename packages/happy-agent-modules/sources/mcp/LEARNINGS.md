# MCP module learnings

## Happy owns one MCP catalog and its live clients

Parsing MCP entries from general project or provider configuration without installing a production
client lifecycle left servers visible in configuration but unusable by models. MCP configuration
now comes only from `~/Happy/Config/mcp.toml`, and `McpModule` owns SDK clients, transports, child
processes, failures, and online reload. Provider-specific MCP files are deliberately ignored.

## Configuration edits reload through the same bounded path

Model-driven changes update one named server so unrelated records are preserved, then use the same
serialized reload path as an explicit reload. New connections are prepared concurrently and
swapped as one catalog before old clients close, preventing readers from observing a half-reloaded
set.
