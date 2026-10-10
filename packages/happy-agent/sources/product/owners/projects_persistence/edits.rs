//! Settings and image bytes participate in the project resource transaction.
use crate::product::{projects::AvatarAsset, runtime::Context};
use anyhow::Result;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

pub(in crate::product::projects) fn save_settings(
    ctx: &Context<'_>,
    id: &str,
    settings: &Value,
) -> Result<()> {
    ctx.database().execute("INSERT INTO happy_agent_module_project_settings(project_id,settings_json) VALUES(?1,?2) ON CONFLICT(project_id) DO UPDATE SET settings_json=excluded.settings_json",params![id,settings.to_string()])?;
    Ok(())
}

pub(in crate::product::projects) fn query_avatar(
    ctx: &Context<'_>,
    id: &str,
) -> Result<Option<AvatarAsset>> {
    Ok(ctx.database().query_row("SELECT image_bytes,content_type,content_hash,thumbhash,width,height FROM happy_agent_module_project_avatars WHERE project_id=?1",[id],|row| {
        let hash:String=row.get(2)?;
        Ok(AvatarAsset {bytes:row.get(0)?,metadata:json!({"contentType":row.get::<_,String>(1)?,"contentHash":hash,"etag":format!("\"{hash}\""),"thumbhash":row.get::<_,String>(3)?,"width":row.get::<_,i64>(4)?,"height":row.get::<_,i64>(5)?})})
    }).optional()?)
}

pub(in crate::product::projects) fn delete_avatar(ctx: &Context<'_>, id: &str) -> Result<()> {
    ctx.database().execute(
        "DELETE FROM happy_agent_module_project_avatars WHERE project_id=?1",
        [id],
    )?;
    Ok(())
}
