//! Every statement MCP runs against the database, each inside the caller's transaction. The live
//! connection catalog stays authoritative; storage holds only the bounded server index and the
//! workspace changes MCP still owes.

mod migrations;
mod server_index;
mod workspace_intents;

pub(super) use migrations::MIGRATIONS;
#[cfg(test)]
pub(super) use server_index::query_server_index;
pub(super) use server_index::replace_server_index;
pub(super) use workspace_intents::{query_next_workspace_intent, record_workspace_intent, settle_workspace_intent};
