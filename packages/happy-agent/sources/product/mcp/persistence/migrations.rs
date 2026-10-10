//! A released migration never changes; every later schema change is a new one.

pub(in crate::product::mcp) const MIGRATIONS: &[(&str, &str)] = &[(
    "001-mcp-server-index",
    "CREATE TABLE IF NOT EXISTS mcp_module_index (
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        fingerprint TEXT,
        status TEXT NOT NULL,
        tool_count INTEGER NOT NULL,
        error_message TEXT,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (agent_id, name)
    )",
)];
