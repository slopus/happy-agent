# Config module learnings

## Generated runtime configuration owns runtime state

Treating `runtime.toml` as user-authored and placing daemon mutations in a sidecar state file was
wrong. The daemon always generates `runtime.toml`, rewrites known values canonically, and persists
runtime settings there atomically. Comments and unknown fields do not need preservation.

Provider runtime state uses `auto_enable` for automatic scan enablement and `enabled` for an
explicit override. Provider tables merge field-by-field across configuration layers so writing
those runtime fields cannot erase credentials, endpoints, or model filters configured globally.
