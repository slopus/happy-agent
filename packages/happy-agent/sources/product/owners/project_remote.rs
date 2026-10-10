//! Managed clone acceptance holds the filesystem decision through the catalog transaction.
use super::{ProjectError, ProjectsModule, persistence, registration::increment_order_key};
use crate::product::{identity::now, owners::PreparedGitCredential, runtime::Context};
use anyhow::{Context as _, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use tokio::sync::OwnedMutexGuard;
use tokio_util::sync::CancellationToken;

pub struct PreparedRemoteProject {
    id: String,
    name: String,
    path: String,
    runner: Option<String>,
    source: Value,
    secret: Option<String>,
    creator: Value,
    credential: Option<Arc<PreparedGitCredential>>,
    _path_lock: OwnedMutexGuard<()>,
    _project_lock: OwnedMutexGuard<()>,
}
fn invalid(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    ProjectError::Invalid {
        code,
        message: message.into(),
    }
    .into()
}

impl ProjectsModule {
    pub async fn prepare_remote(
        self: &Arc<Self>,
        input: &Value,
        cancel: &CancellationToken,
    ) -> Result<Arc<PreparedRemoteProject>> {
        if !self.schemas.valid("ownerProjectRemoteRequest", input)? {
            return Err(invalid(
                "invalid_request",
                "The remote project request is invalid.",
            ));
        }
        let name = input["name"].as_str().unwrap().trim();
        if name.is_empty() {
            return Err(invalid("invalid_request", "The name cannot be empty."));
        }
        if name.chars().count() > 100 {
            return Err(invalid(
                "invalid_request",
                "The name cannot be longer than 100 characters.",
            ));
        }
        if !self
            .schemas
            .valid("ownerProjectDisplayNameGuard", &json!(name))?
        {
            return Err(invalid(
                "invalid_request",
                "The name cannot contain control characters.",
            ));
        }
        if !self
            .schemas
            .valid("ownerProjectManagedFolderName", &json!(name))?
        {
            return Err(invalid(
                "invalid_request",
                "The managed project name must be one folder name.",
            ));
        }
        if input.get("secret").is_some() && input["source"]["kind"] != "github" {
            return Err(invalid(
                "unsupported_git_source",
                "GitHub credentials can only be used with a GitHub repository.",
            ));
        }
        if !self
            .schemas
            .valid("ownerProjectRemoteSource", &input["source"])?
        {
            return Err(invalid(
                "unsupported_git_source",
                "The remote repository source is invalid.",
            ));
        }
        let id = input["projectId"]
            .as_str()
            .map(|id| id.trim().to_owned())
            .unwrap_or_else(cuid2::create_id);
        if !self.schemas.valid("cuid2", &json!(id))? {
            return Err(invalid(
                "invalid_request",
                "The project ID must be a cuid2 identity.",
            ));
        }
        let owners = self.owners()?;
        let runner = owners
            .runners
            .place(input["runnerId"].as_str())
            .map_err(|error| invalid("invalid_request", error.to_string()))?;
        owners
            .runners
            .prepare_machine(runner.as_deref(), cancel)
            .await?;
        let root = owners
            .runners
            .projects_home(runner.as_deref(), cancel)
            .await?;
        let path = owners
            .runners
            .future_path(runner.as_deref(), &root.join(name), cancel)
            .await?;
        let path = path
            .to_str()
            .context("The managed project path is not valid UTF-8.")?
            .to_owned();
        ensure!(
            self.schemas
                .valid("ownerProjectRepositoryRef", &json!(path))?,
            "The managed project path is invalid."
        );
        let key = format!(
            "registration.{:x}",
            Sha256::digest(format!("{}\0{path}", runner.as_deref().unwrap_or("")).as_bytes())
        );
        let path_lock = owners.git.project_lock(&key, cancel).await?;
        let project_lock = owners.git.project_lock(&id, cancel).await?;
        let owner = self.clone();
        let lookup_id = id.clone();
        let lookup_path = path.clone();
        let lookup_runner = runner.clone();
        let source = input["source"].clone();
        let lookup_source = source.clone();
        let secret = input["secret"]["kind"].as_str().map(str::to_owned);
        let lookup_secret = secret.clone();
        let (known, creator) = self.runtime.transact(move |ctx| {
            let creator = json!({"instanceId":owner.runtime.installation_epoch(ctx)?,"profileId":"local"});
            let known = owner.remote_existing(ctx, &lookup_id, &lookup_path, lookup_runner.as_deref(), &lookup_source, lookup_secret.as_deref())?;
            if known.is_none() && owner.find_by_path(ctx, &lookup_path, lookup_runner.as_deref())?.is_some() { return Err(invalid("project_path_conflict", "That managed project folder already belongs to another project.")); }
            Ok((known, creator))
        }).await?;
        if known.is_none() {
            if owners
                .runners
                .exists(runner.as_deref(), Path::new(&path), cancel)
                .await?
            {
                return Err(invalid(
                    "project_path_conflict",
                    "That managed project folder already exists.",
                ));
            }
            owners
                .runners
                .mkdir(
                    runner.as_deref(),
                    Path::new(&path)
                        .parent()
                        .context("The managed project folder has no parent.")?,
                    cancel,
                )
                .await?;
        }
        let credential = if secret.as_deref() == Some("github") {
            match owners.config.resolve_github_token_for_import(cancel).await {
                Some(token) => Some(
                    owners
                        .git
                        .prepare_github_credential(
                            &id,
                            &creator,
                            source["repository"].as_str().unwrap(),
                            &token,
                        )
                        .await?,
                ),
                None => None,
            }
        } else {
            None
        };
        ensure!(!cancel.is_cancelled(), "Project creation was cancelled.");
        Ok(Arc::new(PreparedRemoteProject {
            id,
            name: name.to_owned(),
            path,
            runner,
            source,
            secret,
            creator,
            credential,
            _path_lock: path_lock,
            _project_lock: project_lock,
        }))
    }

    pub fn register_remote(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        prepared: &PreparedRemoteProject,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let owners = self.owners()?;
        let existing = self.remote_existing(
            ctx,
            &prepared.id,
            &prepared.path,
            prepared.runner.as_deref(),
            &prepared.source,
            prepared.secret.as_deref(),
        )?;
        if let Some(credential) = &prepared.credential {
            owners
                .git
                .activate_github_credential(ctx, credential.clone())?;
        }
        if let Some(before) = existing {
            let can_retry = before["requiredSecretKind"] != "github"
                || prepared.credential.is_some()
                || owners
                    .git
                    .has_github_credential(&prepared.id, &prepared.creator)?;
            if before["initializationStatus"] == "failed" && !can_retry {
                return Ok(before);
            }
            let mut after = before.clone();
            if before["initializationStatus"] == "failed" {
                after["initializationStatus"] = json!("initializing");
                after.as_object_mut().unwrap().remove("initializationError");
                self.write_state(ctx, &before, &mut after, "initialization_retried")?;
            }
            if after["initializationStatus"] == "initializing" && can_retry {
                self.schedule_provision(ctx, &after)?;
            }
            return Ok(after);
        }
        if self
            .find_by_path(ctx, &prepared.path, prepared.runner.as_deref())?
            .is_some()
        {
            return Err(invalid(
                "project_path_conflict",
                "That managed project folder already belongs to another project.",
            ));
        }
        let base = self.storage_key_for(&prepared.name);
        let mut storage_key = base.clone();
        if persistence::query_storage_key_exists(ctx, &storage_key)? {
            let trimmed = base[..base.len().min(56)].trim_end_matches('-');
            for suffix in 2..=10001 {
                storage_key = format!("{trimmed}-{suffix}");
                if !persistence::query_storage_key_exists(ctx, &storage_key)? {
                    break;
                }
            }
            ensure!(
                !persistence::query_storage_key_exists(ctx, &storage_key)?,
                "The project storage key space is exhausted."
            );
        }
        let order = match persistence::query_last_order(ctx)? {
            None => "00000000000000000001".to_owned(),
            Some(key) => increment_order_key(&key)?,
        };
        let at = now();
        let mut project = json!({"id":prepared.id,"repositoryRef":prepared.path,"kind":"regular","storageKey":storage_key,"name":prepared.name,"nameSource":"folder","status":"active","presence":"missing","initializationStatus":"initializing","initializationAttempt":0,"worktreeSupport":"unknown","remoteSource":prepared.source,"gitAhead":0,"gitBehind":0,"gitDetached":false,"orderKey":order,"version":1,"createdAt":at,"updatedAt":at});
        if let Some(runner) = &prepared.runner {
            project["runnerId"] = json!(runner);
        }
        if let Some(secret) = &prepared.secret {
            project["requiredSecretKind"] = json!(secret);
        }
        self.register(ctx, &project)
    }

    fn remote_existing(
        &self,
        ctx: &Context<'_>,
        id: &str,
        path: &str,
        runner: Option<&str>,
        source: &Value,
        secret: Option<&str>,
    ) -> Result<Option<Value>> {
        let Some(project) = self.get(ctx, id)? else {
            return Ok(None);
        };
        let equal_source = project.get("remoteSource") == Some(source);
        if project["repositoryRef"] != path
            || project["runnerId"].as_str() != runner
            || !equal_source
            || project["requiredSecretKind"].as_str() != secret
        {
            return Err(invalid(
                "project_id_conflict",
                "That project ID already names a different project.",
            ));
        }
        Ok(Some(project))
    }
}
