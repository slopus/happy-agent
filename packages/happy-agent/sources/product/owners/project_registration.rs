//! Folder inspection precedes the atomic catalog decision and durable setup intent.
use super::{ProjectError, ProjectsModule, persistence};
use crate::product::{identity::now, owners::RunnerUnavailableError, runtime::Context};
use anyhow::{Context as _, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tokio::sync::OwnedMutexGuard;
use tokio_util::sync::CancellationToken;

pub struct PreparedProjectRegistration {
    path: String,
    runner_id: Option<String>,
    requested_id: Option<String>,
    known_id: Option<String>,
    home: bool,
    // An API keeps this preparation alive until its transaction has committed.
    _path_lock: OwnedMutexGuard<()>,
    _project_lock: Option<OwnedMutexGuard<()>>,
}

fn invalid(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    ProjectError::Invalid {
        code,
        message: message.into(),
    }
    .into()
}

impl ProjectsModule {
    pub fn archive_with_version(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        id: &str,
        expected: u64,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.required_version(ctx, id, Some(expected))?;
        self.archive(ctx, id)?
            .ok_or_else(|| ProjectError::NotFound.into())
    }
    pub async fn prepare_registration(
        self: &Arc<Self>,
        input: &Value,
        cancel: &CancellationToken,
    ) -> Result<Arc<PreparedProjectRegistration>> {
        ensure!(
            self.schemas.valid("ownerProjectRegistration", input)?,
            "The project registration request is invalid."
        );
        let owners = self.owners()?;
        let requested = Path::new(input["path"].as_str().unwrap());
        if !requested.is_absolute() {
            return Err(invalid(
                "invalid_request",
                "The project path must be absolute.",
            ));
        }
        let requested_id = input["projectId"].as_str().map(|id| id.trim().to_owned());
        if let Some(id) = &requested_id {
            if !self.schemas.valid("cuid2", &json!(id))? {
                return Err(invalid(
                    "invalid_request",
                    "The project ID must be a cuid2 identity.",
                ));
            }
        }
        let runner = owners
            .runners
            .place(input["runnerId"].as_str())
            .map_err(|error| invalid("invalid_request", error.to_string()))?;
        owners
            .runners
            .prepare_machine(runner.as_deref(), cancel)
            .await?;
        let details = match owners
            .runners
            .stat(runner.as_deref(), requested, cancel)
            .await
        {
            Ok(details) => details,
            Err(error) if error.downcast_ref::<RunnerUnavailableError>().is_some() => {
                return Err(error);
            }
            Err(error) => {
                return Err(match owners.runners.error_code(&error) {
                    Some("ENOENT" | "ENOTDIR") => {
                        invalid("path_missing", "The project folder does not exist.")
                    }
                    _ => invalid("path_inaccessible", "The project folder is not accessible."),
                });
            }
        };
        if details["isDirectory"] != true {
            return Err(invalid(
                "not_directory",
                "The project path is not a folder.",
            ));
        }
        owners
            .runners
            .directory_page(runner.as_deref(), requested, 1, cancel)
            .await
            .map_err(|error| {
                if error.downcast_ref::<RunnerUnavailableError>().is_some() {
                    error
                } else {
                    invalid("path_inaccessible", "The project folder is not accessible.")
                }
            })?;
        let path = owners
            .runners
            .canonical_path(runner.as_deref(), requested, cancel)
            .await
            .unwrap_or_else(|_| normalized(requested));
        let path = path
            .to_str()
            .context("The project folder name is not valid UTF-8.")?
            .to_owned();
        ensure!(
            self.schemas
                .valid("ownerProjectRepositoryRef", &json!(path))?,
            "The canonical project path is invalid."
        );
        let key = format!(
            "registration.{:x}",
            Sha256::digest(format!("{}\0{path}", runner.as_deref().unwrap_or("")).as_bytes())
        );
        let path_lock = owners.git.project_lock(&key, cancel).await?;
        let owner = self.clone();
        let lookup_path = path.clone();
        let lookup_runner = runner.clone();
        let (known, home) = self
            .runtime
            .transact(move |ctx| {
                let home =
                    owner.registration_is_home(ctx, &lookup_path, lookup_runner.as_deref())?;
                let known = owner.registration_existing(
                    ctx,
                    &lookup_path,
                    lookup_runner.as_deref(),
                    home,
                )?;
                Ok((known, home))
            })
            .await?;
        let known_id = known
            .as_ref()
            .and_then(|project| project["id"].as_str())
            .map(str::to_owned);
        let project_lock = match known_id.as_deref() {
            Some(id) => Some(owners.git.project_lock(id, cancel).await?),
            None => None,
        };
        ensure!(
            !cancel.is_cancelled(),
            "Project registration was cancelled."
        );
        Ok(Arc::new(PreparedProjectRegistration {
            path,
            runner_id: runner,
            requested_id,
            known_id,
            home,
            _path_lock: path_lock,
            _project_lock: project_lock,
        }))
    }

    pub fn register_path(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        prepared: &PreparedProjectRegistration,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let owners = self.owners()?;
        let path = &prepared.path;
        let runner = prepared.runner_id.as_deref();
        let existing = self.registration_existing(ctx, path, runner, prepared.home)?;
        if !(prepared.home && existing.is_some())
            && let Some(id) = prepared.requested_id.as_deref()
        {
            if let Some(known) = self.get(ctx, id)? {
                if known["repositoryRef"] != *path || known["runnerId"].as_str() != runner {
                    return Err(invalid(
                        "project_id_conflict",
                        "That project ID already names another folder.",
                    ));
                }
            }
        }
        if let Some(before) = existing {
            if before["status"] != "archived" {
                return Ok(before);
            }
            if prepared.known_id.as_deref() != before["id"].as_str() {
                return Err(ProjectError::Conflict(before).into());
            }
            let id = before["id"].as_str().unwrap();
            owners
                .durable
                .cancel(ctx, &format!("project-archive.{id}"))?;
            owners
                .durable
                .cancel(ctx, &format!("project-cleanup.{id}"))?;
            owners.services.reopen_admission(ctx, id)?;
            let mut after = before.clone();
            after["status"] = json!("active");
            after.as_object_mut().unwrap().remove("archivedAt");
            self.write_event(ctx, &before, &mut after, json!({"type":"project_restored"}))?;
            return Ok(after);
        }
        let is_home = prepared.home;
        let name = if is_home {
            "Home".to_owned()
        } else {
            let candidate = path
                .split(['/', '\\'])
                .filter(|part| !part.is_empty())
                .next_back()
                .unwrap_or("")
                .trim();
            if candidate.is_empty() {
                "Project".to_owned()
            } else {
                candidate.to_owned()
            }
        };
        let base = if is_home {
            "home".to_owned()
        } else {
            self.storage_key_for(&name)
        };
        let mut storage_key = base.clone();
        let taken = |candidate: &str| persistence::query_storage_key_exists(ctx, candidate);
        if taken(&storage_key)? {
            let trimmed = base[..base.len().min(56)].trim_end_matches('-');
            for suffix in 2..=10001 {
                storage_key = format!("{trimmed}-{suffix}");
                if !taken(&storage_key)? {
                    break;
                }
            }
            ensure!(
                !taken(&storage_key)?,
                "The project storage key space is exhausted."
            );
        }
        let last = persistence::query_last_order(ctx)?;
        let order_key = match last {
            None => "00000000000000000001".to_owned(),
            Some(key) => {
                ensure!(
                    self.schemas.valid("projectOrderKey", &json!(key))?,
                    "The stored project order key is invalid."
                );
                increment_order_key(&key)?
            }
        };
        let at = now();
        let mut project = json!({"id":prepared.requested_id.clone().unwrap_or_else(cuid2::create_id),"repositoryRef":path,"kind":if is_home{"home"}else{"regular"},"storageKey":storage_key,"name":name,"nameSource":"folder","status":"active","presence":"present","initializationStatus":if is_home{"ready"}else{"initializing"},"initializationAttempt":0,"worktreeSupport":"unknown","gitAhead":0,"gitBehind":0,"gitDetached":false,"orderKey":order_key,"version":1,"createdAt":at,"updatedAt":at});
        if let Some(runner) = runner {
            project["runnerId"] = json!(runner);
        }
        persistence::validate(&self.schemas, &project)?;
        self.register(ctx, &project)
    }

    pub fn set_up_again(self: &Arc<Self>, ctx: &Context<'_>, id: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let before = self.required_version(ctx, id, None)?;
        if before["kind"] == "home" {
            return Err(invalid(
                "invalid_request",
                "The Home project does not need to be set up.",
            ));
        }
        if before["status"] == "archived" {
            return Ok(before);
        }
        let mut after = before.clone();
        let attempt = before["initializationAttempt"].as_u64().unwrap();
        ensure!(
            attempt < 1_000_000,
            "The project's setup attempt limit was reached."
        );
        after["initializationStatus"] = json!("initializing");
        after["initializationAttempt"] = json!(attempt + 1);
        after.as_object_mut().unwrap().remove("initializationError");
        self.write_state(ctx, &before, &mut after, "refresh")?;
        self.schedule_provision(ctx, &after)?;
        Ok(after)
    }

    fn registration_is_home(
        &self,
        ctx: &Context<'_>,
        path: &str,
        runner: Option<&str>,
    ) -> Result<bool> {
        let owners = self.owners()?;
        let home_runner = if owners.runners.enabled() {
            owners.runners.default_runner_id()
        } else {
            None
        };
        if runner != home_runner.as_deref() {
            return Ok(false);
        }
        let home = match runner {
            None => Some(owners.config.project_local_home().to_owned()),
            Some(runner) => owners
                .runners
                .known_machine(ctx, runner)?
                .and_then(|machine| machine["home"].as_str().map(PathBuf::from)),
        };
        Ok(home.as_deref() == Some(Path::new(path)))
    }

    fn registration_existing(
        &self,
        ctx: &Context<'_>,
        path: &str,
        runner: Option<&str>,
        home: bool,
    ) -> Result<Option<Value>> {
        if home {
            let id = persistence::query_home_id(ctx)?;
            if let Some(id) = id {
                return self.get(ctx, &id);
            }
        }
        self.find_by_path(ctx, path, runner)
    }
}

fn normalized(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            component => result.push(component.as_os_str()),
        }
    }
    result
}
pub(super) fn increment_order_key(key: &str) -> Result<String> {
    let mut digits = key.trim_start_matches('0').as_bytes().to_vec();
    if digits.is_empty() {
        digits.push(b'0');
    }
    let mut carry = true;
    for digit in digits.iter_mut().rev() {
        if *digit < b'9' {
            *digit += 1;
            carry = false;
            break;
        } else {
            *digit = b'0';
        }
    }
    if carry {
        digits.insert(0, b'1');
    }
    let value = String::from_utf8(digits)?;
    let value = format!("{value:0>20}");
    ensure!(
        value.len() <= 128,
        "The project order key space is exhausted."
    );
    Ok(value)
}
