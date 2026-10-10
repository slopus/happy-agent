//! Human edits use one guarded row write and the Source catalog event.
use super::{AvatarAsset, ProjectsModule, persistence};
use crate::product::{identity::now, runtime::Context};
use anyhow::{Context as _, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("The project version changed.")]
    Conflict(Value),
    #[error("{message}")]
    Invalid { code: &'static str, message: String },
    #[error("The project was not found.")]
    NotFound,
}

impl ProjectsModule {
    pub(super) fn required_version(
        &self,
        ctx: &Context<'_>,
        id: &str,
        expected: Option<u64>,
    ) -> Result<Value> {
        let before = self.get(ctx, id)?.ok_or(ProjectError::NotFound)?;
        if expected.is_some_and(|version| before["version"].as_u64() != Some(version)) {
            return Err(ProjectError::Conflict(before).into());
        }
        Ok(before)
    }

    pub fn rename(&self, ctx: &Context<'_>, id: &str, name: &str, expected: u64) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let input = json!({"projectId":id,"name":name,"expectedVersion":expected});
        ensure!(
            self.schemas.valid("ownerProjectRename", &input)?,
            "The project rename request is invalid."
        );
        let name = self
            .validate_name(name)
            .map_err(|error| ProjectError::Invalid {
                code: "invalid_request",
                message: error.to_string(),
            })?;
        let before = self.required_version(ctx, id, Some(expected))?;
        let mut after = before.clone();
        after["name"] = json!(name);
        after["nameSource"] = json!("user");
        let event = json!({"type":"project_renamed","previousName":before["name"]});
        self.write_event(ctx, &before, &mut after, event)?;
        Ok(after)
    }

    pub fn reorder(
        &self,
        ctx: &Context<'_>,
        id: &str,
        after_id: Option<&str>,
        expected: u64,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let input = json!({"projectId":id,"afterId":after_id,"expectedVersion":expected});
        ensure!(
            self.schemas.valid("ownerProjectReorder", &input)?,
            "The project reorder request is invalid."
        );
        let before = self.required_version(ctx, id, Some(expected))?;
        ensure!(
            after_id != Some(id),
            "A project cannot be placed after itself."
        );
        let mut ordered = Vec::new();
        let mut cursor = None;
        loop {
            let mut query = json!({"includeArchived":true});
            if let Some(cursor) = &cursor {
                query["cursor"] = json!(cursor);
            }
            let page = self.list_catalog_page(ctx, &query)?;
            ordered.extend(page["projects"].as_array().unwrap().iter().cloned());
            ensure!(
                ordered.len() <= 10000,
                "The project order exceeds its snapshot bound."
            );
            cursor = page["nextCursor"].as_str().map(str::to_owned);
            if cursor.is_none() {
                break;
            }
        }
        let current = ordered
            .iter()
            .position(|project| project["id"] == id)
            .context("The project is absent from its catalog.")?;
        let remaining = ordered
            .iter()
            .filter(|project| project["id"] != id)
            .collect::<Vec<_>>();
        let insertion = match after_id {
            None => 0,
            Some(after) => {
                remaining
                    .iter()
                    .position(|project| project["id"] == after)
                    .context("The project to place after was not found in the catalog.")?
                    + 1
            }
        };
        if current == insertion {
            return Ok(before);
        }
        let lower = insertion
            .checked_sub(1)
            .map(|index| remaining[index]["orderKey"].as_str().unwrap());
        let upper = remaining
            .get(insertion)
            .map(|project| project["orderKey"].as_str().unwrap());
        let mut after = before.clone();
        after["orderKey"] = json!(self.order_key_between(lower, upper)?);
        self.write_event(
            ctx,
            &before,
            &mut after,
            json!({"type":"project_reordered","previousOrderKey":before["orderKey"]}),
        )?;
        Ok(after)
    }

    pub fn order_key_between(&self, before: Option<&str>, after: Option<&str>) -> Result<String> {
        for key in [before, after].into_iter().flatten() {
            ensure!(
                self.schemas.valid("projectOrderKey", &json!(key))?,
                "The project order key is invalid."
            );
        }
        let lower = before.unwrap_or("");
        ensure!(
            after.is_none_or(|upper| lower < upper),
            "Project order keys are out of order."
        );
        let mut prefix = String::new();
        for index in 0..128 {
            let low = lower.as_bytes().get(index).copied().unwrap_or(b'0') - b'0';
            let high = after
                .and_then(|upper| upper.as_bytes().get(index).copied())
                .map(|digit| digit - b'0')
                .unwrap_or(10);
            if high.saturating_sub(low) > 1 {
                prefix.push(char::from(b'0' + low + (high - low) / 2));
                ensure!(prefix.len() <= 128, "Project order key space is exhausted.");
                return Ok(prefix);
            }
            prefix.push(char::from(b'0' + low));
            if high.saturating_sub(low) == 1 {
                for digit in lower
                    .as_bytes()
                    .iter()
                    .skip(index + 1)
                    .copied()
                    .chain(std::iter::once(b'0'))
                {
                    let digit = digit - b'0';
                    if digit < 9 {
                        prefix.push(char::from(b'0' + digit + (10 - digit) / 2));
                        ensure!(prefix.len() <= 128, "Project order key space is exhausted.");
                        return Ok(prefix);
                    }
                    prefix.push('9');
                    ensure!(prefix.len() < 128, "Project order key space is exhausted.");
                }
            }
        }
        anyhow::bail!("Project order key space is exhausted.")
    }

    pub fn update_settings(
        &self,
        ctx: &Context<'_>,
        id: &str,
        settings: &Value,
        expected: u64,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        ensure!(
            self.schemas.valid(
                "ownerProjectSettingsUpdate",
                &json!({"projectId":id,"settings":settings,"expectedVersion":expected})
            )?,
            "The project settings request is invalid."
        );
        let before = self.required_version(ctx, id, Some(expected))?;
        if self.read_settings(ctx, id)? == *settings {
            return Ok(before);
        }
        persistence::save_settings(ctx, id, settings)?;
        let mut after = before.clone();
        // The settings live beside the row, but their public resource advances once with them.
        self.store_event(
            ctx,
            &before,
            &mut after,
            json!({"type":"project_settings_updated","projectId":id,"settings":settings}),
        )?;
        Ok(after)
    }

    pub fn avatar_asset(&self, ctx: &Context<'_>, id: &str) -> Result<Option<AvatarAsset>> {
        self.runtime.assert_context(ctx)?;
        let project = self.get(ctx, id)?.ok_or(ProjectError::NotFound)?;
        if project.get("avatar").is_none() {
            return Ok(None);
        }
        let asset = persistence::query_avatar(ctx, id)?
            .context("Project avatar metadata points at missing image bytes.")?;
        ensure!(
            self.schemas
                .valid("ownerProjectAvatarAssetMetadata", &asset.metadata)?,
            "The stored project avatar metadata is invalid."
        );
        ensure!(
            !asset.bytes.is_empty() && asset.bytes.len() <= 8 * 1024 * 1024,
            "The stored project image exceeds its byte bound."
        );
        ensure!(
            format!("{:x}", Sha256::digest(&asset.bytes)) == asset.metadata["contentHash"],
            "The stored project avatar does not match its content hash."
        );
        ensure!(
            project["avatar"]["thumbhash"] == asset.metadata["thumbhash"],
            "The stored project avatar does not match the one asked for."
        );
        Ok(Some(asset))
    }

    /// Normalize through `normalize_avatar` before entering the caller's transaction.
    pub fn set_avatar(
        &self,
        ctx: &Context<'_>,
        id: &str,
        asset: &AvatarAsset,
        source: &str,
        expected: u64,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        ensure!(
            self.schemas.valid(
                "ownerProjectPreparedAvatar",
                &json!({"projectId":id,"source":source,"expectedVersion":expected})
            )?,
            "The project avatar request is invalid."
        );
        ensure!(
            self.schemas
                .valid("ownerProjectAvatarAssetMetadata", &asset.metadata)?,
            "The project image metadata is invalid."
        );
        ensure!(
            !asset.bytes.is_empty()
                && asset.bytes.len() <= 8 * 1024 * 1024
                && format!("{:x}", Sha256::digest(&asset.bytes)) == asset.metadata["contentHash"],
            "The project image does not match its content hash or byte bound."
        );
        let before = self.required_version(ctx, id, Some(expected))?;
        let avatar =
            json!({"kind":"image","source":source,"thumbhash":asset.metadata["thumbhash"]});
        let existing = self.avatar_asset(ctx, id)?;
        if before["avatar"] == avatar
            && existing.is_some_and(|existing| {
                existing.metadata["contentHash"] == asset.metadata["contentHash"]
            })
        {
            return Ok(before);
        }
        persistence::save_avatar(ctx, id, &asset.bytes, &asset.metadata)?;
        let mut after = before.clone();
        after["avatar"] = avatar;
        self.store_event(
            ctx,
            &before,
            &mut after,
            json!({"type":"project_avatar_updated"}),
        )?;
        Ok(after)
    }

    pub fn clear_avatar(&self, ctx: &Context<'_>, id: &str, expected: u64) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        ensure!(
            self.schemas.valid(
                "ownerProjectClearAvatar",
                &json!({"projectId":id,"expectedVersion":expected})
            )?,
            "The project avatar clear request is invalid."
        );
        let before = self.required_version(ctx, id, Some(expected))?;
        if before.get("avatar").is_none() {
            return Ok(before);
        }
        persistence::delete_avatar(ctx, id)?;
        let mut after = before.clone();
        after.as_object_mut().unwrap().remove("avatar");
        self.write_event(
            ctx,
            &before,
            &mut after,
            json!({"type":"project_avatar_cleared"}),
        )?;
        Ok(after)
    }

    pub(super) fn write_event(
        &self,
        ctx: &Context<'_>,
        before: &Value,
        after: &mut Value,
        event: Value,
    ) -> Result<()> {
        if before == after {
            return Ok(());
        }
        self.store_event(ctx, before, after, event)
    }

    pub(super) fn store_event(
        &self,
        ctx: &Context<'_>,
        before: &Value,
        after: &mut Value,
        mut event: Value,
    ) -> Result<()> {
        after["version"] = json!(before["version"].as_u64().unwrap() + 1);
        after["updatedAt"] = json!(now());
        *after = persistence::write(ctx, &self.schemas, before, after)?;
        event["project"] = after.clone();
        event["previousProject"] = before.clone();
        self.observe(ctx, event)
    }
}
