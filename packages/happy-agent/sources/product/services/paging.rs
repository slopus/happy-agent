//! Opaque catalog positions are bound to one workspace and stopped selection.
use crate::product::schemas::Schemas;
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
const INVALID: &str = "The service page cursor does not match this workspace and selection.";
pub(super) fn read(
    schemas: &Schemas,
    workspace: &str,
    stopped: bool,
    encoded: Option<&str>,
) -> Result<Option<u64>> {
    let Some(encoded) = encoded else {
        return Ok(None);
    };
    ensure!(
        schemas.valid("serviceEncodedCursor", &json!(encoded))?,
        "{INVALID}"
    );
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| anyhow::anyhow!(INVALID))?;
    ensure!(URL_SAFE_NO_PAD.encode(&decoded) == encoded, "{INVALID}");
    let cursor: Value = serde_json::from_slice(&decoded).map_err(|_| anyhow::anyhow!(INVALID))?;
    ensure!(
        schemas.valid("servicePagePosition", &cursor)?
            && cursor["workspaceId"] == workspace
            && cursor["includeStopped"] == stopped,
        "{INVALID}"
    );
    Ok(cursor["before"].as_u64())
}
pub(super) fn write(
    schemas: &Schemas,
    workspace: &str,
    stopped: bool,
    before: Option<u64>,
) -> Result<Option<String>> {
    let Some(before) = before else {
        return Ok(None);
    };
    let cursor = json!({"v":1,"workspaceId":workspace,"includeStopped":stopped,"before":before});
    ensure!(schemas.valid("servicePagePosition", &cursor)?, "{INVALID}");
    let encoded = URL_SAFE_NO_PAD.encode(cursor.to_string());
    ensure!(
        schemas.valid("serviceEncodedCursor", &json!(encoded))?,
        "{INVALID}"
    );
    Ok(Some(encoded))
}
