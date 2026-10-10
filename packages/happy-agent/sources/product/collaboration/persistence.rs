//! Original retired migration markers and the final removal of unused tables.
pub const MIGRATIONS: &[(&str, &str)] = &[
    ("001-collaboration", ""),
    ("002-drop-collaboration-receipts", ""),
    ("003-collaboration-run-state", ""),
    (
        "004-collaboration-storage-removed",
        "DROP TABLE IF EXISTS happy_collaboration_obligations;DROP TABLE IF EXISTS happy_collaboration_messages;DROP TABLE IF EXISTS happy_collaboration_agents;DROP TABLE IF EXISTS happy_collaboration_receipts;",
    ),
];
