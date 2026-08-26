# Config module learnings

## Generated runtime configuration owns runtime state

Treating `runtime.toml` as user-authored and placing daemon mutations in a sidecar state file was
wrong. The daemon always generates `runtime.toml`, rewrites known values canonically, and persists
runtime settings there atomically. Comments and unknown fields do not need preservation.

Provider runtime state uses `auto_enable` for automatic scan enablement and `enabled` for an
explicit override. Provider tables merge field-by-field across configuration layers so writing
those runtime fields cannot erase credentials, endpoints, or model filters configured globally.

## Scripted providers own their complete catalog

A test-supplied inference override replaces both accounts and their model catalogs. Runtime state
may persist a scripted provider's compatibility protocol (for example, `gym` as `codex`), but that
must not add the protocol's curated production models to the scripted provider after a restart.
For every provider ID represented by scripted models, expose exactly those scripted routes.

## Gemini has a config key without a provider entry

Requiring `GEMINI_API_KEY` in the daemon environment was the only way to enable the Gemini media
and search tools, which made the key awkward to keep with the rest of the machine's settings. The
user `happy.toml` now accepts `[gemini] api_key`, and `ConfigModule.geminiApiKey` prefers that
configured value over the environment variable. Gemini stays out of `[providers.*]` because it
powers tools rather than chat models, and the section is a machine setting: a project `happy.toml`
cannot set it, since a repository must not choose which account this installation bills against.

## MCP has dedicated global and workspace sources

Combining MCP records into `happy.toml` made MCP look configured while provider and runtime wiring
could disagree about discovery. MCP now comes from dedicated files: `~/Happy/Config/mcp.toml` for
the user's catalog and root `mcp.toml` for a workspace catalog. Runtime, Codex, Claude, and other
provider MCP settings do not enter the Happy MCP catalog. The config module owns parsing, bounded
validation, the global path, and atomic global one-server updates, while the MCP module owns live
clients, workspace demand, sharing, and reconciliation.
