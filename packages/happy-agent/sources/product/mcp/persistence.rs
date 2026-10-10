//! Every statement MCP runs against the database, each inside the caller's transaction. The live
//! connection catalog stays authoritative; storage holds only the bounded server index.

mod migrations;
mod server_index;

pub(super) use migrations::MIGRATIONS;
#[cfg(test)]
pub(super) use server_index::query_server_index;
pub(super) use server_index::replace_server_index;
