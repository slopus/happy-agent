# Installation skill folders

The original shipped skill-folder tools belong to a separate feature from the global skill catalog. Only active admin bots see the fixed three-tool array, and each call verifies that authority again against the current durable bot record.

Configuration owns path resolution and the live user/runtime directory lists. Adding and removing folders use its atomic generated `runtime.toml` write; user-authored `happy.toml` directories remain user-owned. Adding an existing runtime folder and removing an absent one are idempotent. Directory validation follows symlinks, matching the original filesystem `stat`.

List is reloadable but not durable. Add and remove are durable because configuration writes are atomic and idempotent; the original feature has no database migration, durable function, or module-local recovery machinery. Their Auto policy discloses the installation-wide configuration write and requires Auto or Full access.
