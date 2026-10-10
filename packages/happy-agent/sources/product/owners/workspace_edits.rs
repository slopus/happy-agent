//! Human catalog mutations use guarded versions and one Source resource event.
use super::*;

#[derive(Debug, thiserror::Error)]
pub enum WorkspaceError {
    #[error("The workspace version changed.")]
    Conflict(Value),
    #[error("{0}")]
    Invalid(String),
    #[error("The workspace was not found.")]
    NotFound,
}

impl WorkspacesModule {
    pub(super) fn required_version(
        &self,
        ctx: &Context<'_>,
        id: &str,
        expected: Option<u64>,
    ) -> Result<Value> {
        let before = self.get(ctx, id)?.ok_or(WorkspaceError::NotFound)?;
        if expected.is_some_and(|expected| before["version"].as_u64() != Some(expected)) {
            return Err(WorkspaceError::Conflict(before).into());
        }
        Ok(before)
    }
    pub fn rename(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        id: &str,
        name: &str,
        expected: u64,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.assert_catalog_enabled()?;
        anyhow::ensure!(
            Schemas::new()?.valid(
                "ownerWorkspaceRename",
                &json!({"workspaceId":id,"name":name,"expectedVersion":expected})
            )?,
            "The workspace rename request is invalid."
        );
        self.rename_catalog(ctx, id, name, Some(expected), false)
    }
    pub fn reorder(
        &self,
        ctx: &Context<'_>,
        id: &str,
        after_id: Option<&str>,
        expected: u64,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.assert_catalog_enabled()?;
        let schemas = Schemas::new()?;
        anyhow::ensure!(
            schemas.valid(
                "ownerWorkspaceReorder",
                &json!({"workspaceId":id,"afterId":after_id,"expectedVersion":expected})
            )?,
            "The workspace reorder request is invalid."
        );
        if after_id == Some(id) {
            return Err(WorkspaceError::Invalid(
                "A workspace cannot be placed after itself.".to_owned(),
            )
            .into());
        }
        let before = self.required_version(ctx, id, None)?;
        let rows =
            persistence::project_workspaces(ctx, &schemas, before["projectRef"].as_str().unwrap())?
                .into_iter()
                .filter(|row| row["parentId"] == before["parentId"] && row["id"] != id)
                .collect::<Vec<_>>();
        let position = match after_id {
            None => 0,
            Some(after) => {
                rows.iter()
                    .position(|row| row["id"] == after)
                    .ok_or_else(|| {
                        WorkspaceError::Invalid(
                            "The workspace to place after is not a sibling of this workspace."
                                .to_owned(),
                        )
                    })?
                    + 1
            }
        };
        let key = workspace_identity::between(
            position
                .checked_sub(1)
                .map(|index| rows[index]["orderKey"].as_str().unwrap()),
            rows.get(position).and_then(|row| row["orderKey"].as_str()),
        )?;
        let before = self.required_version(ctx, id, Some(expected))?;
        let mut after = before.clone();
        after["orderKey"] = json!(key);
        self.write_event(
            ctx,
            &before,
            &mut after,
            json!({"type":"workspace_reordered","previousOrderKey":before["orderKey"]}),
        )?;
        Ok(after)
    }
    pub fn archive_with_version(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        id: &str,
        expected: u64,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.assert_catalog_enabled()?;
        anyhow::ensure!(
            Schemas::new()?.valid(
                "ownerWorkspaceArchiveOptions",
                &json!({"expectedVersion":expected})
            )?,
            "The workspace archive request is invalid."
        );
        self.required_version(ctx, id, Some(expected))?;
        self.begin_archive(ctx, id)?
            .ok_or_else(|| WorkspaceError::NotFound.into())
    }
}
