use super::persistence::{
    GLOBAL_SKILLS_MIGRATIONS, query_global_skills_state, save_global_skills_state,
};
use crate::product::{
    config::ConfigModule,
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    events::EventsModule,
    identity::now,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{FutureExt, future::BoxFuture, future::Shared};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

const WATCH: &str = "global-skills-watch";
const WRITE_PREFERENCES: &str = "global-skills-write-preferences";

#[derive(Clone, Debug)]
pub struct GlobalSkillsError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub details: Option<Value>,
}
impl std::fmt::Display for GlobalSkillsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for GlobalSkillsError {}
fn skill_error(status: u16, code: &'static str, message: &'static str) -> anyhow::Error {
    GlobalSkillsError {
        status,
        code,
        message: message.into(),
        details: None,
    }
    .into()
}
type ScanFuture =
    Shared<BoxFuture<'static, std::result::Result<Arc<SkillScan>, Arc<GlobalSkillsError>>>>;
struct PendingScan {
    sequence: u64,
    future: ScanFuture,
}
struct Watching {
    stop: CancellationToken,
    done: CancellationToken,
}

/// The installation catalog owns global skill files, stable identities,
/// enablement and supervision. A disabled skill remains readable and watched.
pub struct GlobalSkillsModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    events: Arc<EventsModule>,
    schemas: Schemas,
    pending: Mutex<Option<PendingScan>>,
    sequence: AtomicU64,
    previous_paths: Mutex<BTreeMap<String, String>>,
    watching: Mutex<Option<Watching>>,
    closed: AtomicBool,
}

impl GlobalSkillsModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        events: Arc<EventsModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "globalSkillsState",
            "globalSkill",
            "skillRelativePath",
            "skillEntry",
            "skillPageQuery",
            "ownerSkillMetadata",
            "ownerSkillPagePosition",
            "skillsUpdatedPayload",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let module = Arc::new(Self {
            config,
            runtime,
            durable: durable.clone(),
            events,
            schemas,
            pending: Mutex::new(None),
            sequence: AtomicU64::new(0),
            previous_paths: Mutex::new(BTreeMap::new()),
            watching: Mutex::new(None),
            closed: AtomicBool::new(false),
        });
        for (name, procedure) in [
            (WATCH, Procedure::Watch),
            (WRITE_PREFERENCES, Procedure::WritePreferences),
        ] {
            durable.register(Registration {
                name: name.into(),
                arguments_schema: "ownerOpenEmpty",
                result_schema: "ownerNull",
                function: Arc::new(SkillProcedure {
                    owner: Arc::downgrade(&module),
                    procedure,
                }),
            })?;
        }
        Ok(module)
    }

    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("global-skills", GLOBAL_SKILLS_MIGRATIONS)
            .await?;
        let module = self.clone();
        self.runtime
            .transact(move |ctx| {
                let mut state = query_global_skills_state(ctx, &module.schemas)?.unwrap_or(
                    json!({"revision":skill_version(None)?,"scanSequence":0,"rootStamp":"","entries":[]}),
                );
                state["scanSequence"] = json!(0);
                save_global_skills_state(ctx, &module.schemas, &state)
            })
            .await?;
        // Filesystem discovery is optional. A database failure still propagates
        // from reconciliation rather than being mistaken for an unreadable root.
        match self.scan().await {
            Ok((sequence, scan)) => {
                let reconciled = self.reconcile(sequence, scan).await;
                self.release_scan(sequence);
                reconciled?;
                let module = self.clone();
                self.runtime
                    .transact(move |ctx| module.schedule_preferences(ctx))
                    .await?;
            }
            Err(error) => eprintln!("Global skills could not be scanned: {error}"),
        }
        Ok(())
    }

    pub async fn start(self: &Arc<Self>) -> Result<()> {
        let module = self.clone();
        self.runtime
            .transact(move |ctx| {
                module.durable.invoke(
                    ctx,
                    &json!({"function":WATCH,"arguments":{},"operationId":WATCH,"lockKeys":[WATCH]}),
                )?;
                Ok(())
            })
            .await
    }

    pub fn get(&self, ctx: &Context<'_>, id: &str) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let state = self.query_state(ctx)?;
        Ok(self.entry(&state, id)?["skill"].clone())
    }

    pub async fn list(self: &Arc<Self>, query: Value) -> Result<Value> {
        let (state, _) = self.refresh().await?;
        let mut skills = state["entries"]
            .as_array()
            .context("Stored global skill entries are invalid.")?
            .iter()
            .filter(|entry| entry["present"] == true)
            .map(|entry| entry["skill"].clone())
            .collect::<Vec<_>>();
        skills.sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
        self.page(
            &skills,
            state["revision"].as_str().unwrap_or(""),
            &query,
            "skills",
        )
    }

    pub async fn read(self: &Arc<Self>, id: &str) -> Result<Value> {
        let (state, scan) = self.refresh().await?;
        let skill = self.entry(&state, id)?["skill"].clone();
        let document = scan
            .skills
            .iter()
            .find(|document| skill["path"] == document.path);
        Ok(
            json!({"skill":skill,"content":document.and_then(|document|document.content.as_deref()),"instructions":document.and_then(|document|document.instructions.as_deref())}),
        )
    }

    pub async fn files(self: &Arc<Self>, id: &str, query: Value) -> Result<Value> {
        let (state, scan) = self.refresh().await?;
        let skill = &self.entry(&state, id)?["skill"];
        let document = scan
            .skills
            .iter()
            .find(|document| skill["path"] == document.path)
            .ok_or_else(|| {
                skill_error(403, "forbidden", "Some files in this skill cannot be read.")
            })?;
        if document.files_error {
            return Err(skill_error(
                403,
                "forbidden",
                "Some files in this skill cannot be read.",
            ));
        }
        let mut page = self.page(
            &document.files,
            skill["version"].as_str().unwrap_or(""),
            &query,
            "files",
        )?;
        page["version"] = skill["version"].clone();
        Ok(page)
    }

    pub async fn read_file(self: &Arc<Self>, id: &str, path: &str) -> Result<Vec<u8>> {
        let (state, _) = self.refresh().await?;
        let entry = self.entry(&state, id)?;
        let expected = entry["canonical"].as_str().unwrap_or("").to_owned();
        let logical = self
            .config
            .global_skills_root()
            .join(entry["skill"]["path"].as_str().unwrap_or(""));
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            let canonical = fs::canonicalize(logical).map_err(|_| {
                skill_error(
                    409,
                    "conflict",
                    "The skill directory changed. Reload it before reading.",
                )
            })?;
            if canonical != Path::new(&expected) {
                return Err(skill_error(
                    409,
                    "conflict",
                    "The skill directory changed. Reload it before reading.",
                ));
            }
            read_skill_file(&canonical, &path, 8 * 1024 * 1024, &Schemas::new()?)
        })
        .await?
    }

    /// Callers may compose preference mutation with their existing transaction.
    /// Scanning is separate so no filesystem work runs inside that transaction.
    pub fn set_enabled(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        id: &str,
        enabled: bool,
        expected_version: &str,
        mutation: Option<&str>,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        let mut state = self.query_state(ctx)?;
        let entries = state["entries"]
            .as_array_mut()
            .context("Stored global skill entries are invalid.")?;
        let entry = entries
            .iter_mut()
            .find(|entry| entry["present"] == true && entry["skill"]["id"] == id)
            .ok_or_else(|| skill_error(404, "not_found", "The installed skill was not found."))?;
        if entry["skill"]["version"] != expected_version {
            return Err(GlobalSkillsError {
                status: 409,
                code: "conflict",
                message: "The skill has changed.".into(),
                details: Some(
                    json!({"currentVersion":entry["skill"]["version"],"skill":entry["skill"]}),
                ),
            }
            .into());
        }
        if entry["skill"]["enabled"] == enabled {
            return Ok(entry["skill"].clone());
        }
        let version = skill_version(entry["skill"]["version"].as_str())?;
        entry["skill"]["enabled"] = json!(enabled);
        entry["skill"]["updatedAt"] = json!(now());
        entry["skill"]["version"] = json!(version);
        let skill = entry["skill"].clone();
        state["revision"] = json!(skill_version(state["revision"].as_str())?);
        save_global_skills_state(ctx, &self.schemas, &state)?;
        self.schedule_preferences(ctx)?;
        let mut event = json!({"skillIds":[id],"paths":[]});
        if let Some(mutation) = mutation {
            event["mutationId"] = json!(mutation);
        }
        self.emit(ctx, event)?;
        Ok(skill)
    }

    pub async fn set_enabled_current(
        self: &Arc<Self>,
        id: String,
        enabled: bool,
        expected_version: String,
        mutation: Option<String>,
    ) -> Result<Value> {
        self.refresh().await?;
        let module = self.clone();
        self.runtime
            .transact(move |ctx| {
                module.set_enabled(ctx, &id, enabled, &expected_version, mutation.as_deref())
            })
            .await
    }

    pub fn unavailable_locations(&self, ctx: &Context<'_>) -> Result<BTreeSet<PathBuf>> {
        self.runtime.assert_context(ctx)?;
        let state = self.query_state(ctx)?;
        let entries = state["entries"]
            .as_array()
            .context("Stored global skill entries are invalid.")?;
        let available = entries
            .iter()
            .filter(|entry| {
                entry["present"] == true
                    && entry["skill"]["enabled"] == true
                    && entry["skill"]["status"] == "ready"
            })
            .filter_map(|entry| entry["canonical"].as_str())
            .collect::<BTreeSet<_>>();
        Ok(entries
            .iter()
            .filter(|entry| {
                entry["present"] == true
                    && !available.contains(entry["canonical"].as_str().unwrap_or(""))
                    && (entry["skill"]["enabled"] != true || entry["skill"]["status"] != "ready")
            })
            .filter_map(|entry| entry["canonical"].as_str())
            .map(|directory| Path::new(directory).join("SKILL.md"))
            .collect())
    }

    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let done = self
            .watching
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|watching| {
                watching.stop.cancel();
                watching.done.clone()
            });
        if let Some(done) = done {
            done.cancelled().await;
        }
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
            .map(|pending| pending.future.clone());
        if let Some(pending) = pending {
            let _ = pending.await;
        }
    }

    fn query_state(&self, ctx: &Context<'_>) -> Result<Value> {
        query_global_skills_state(ctx, &self.schemas)?
            .ok_or_else(|| skill_error(503, "internal", "Global skills are still starting."))
    }

    fn entry<'a>(&self, state: &'a Value, id: &str) -> Result<&'a Value> {
        state["entries"]
            .as_array()
            .context("Stored global skill entries are invalid.")?
            .iter()
            .find(|entry| entry["present"] == true && entry["skill"]["id"] == id)
            .ok_or_else(|| skill_error(404, "not_found", "The installed skill was not found."))
    }

    fn schedule_preferences(&self, ctx: &Context<'_>) -> Result<()> {
        self.durable.invoke(
            ctx,
            &json!({"function":WRITE_PREFERENCES,"arguments":{},"lockKeys":[WRITE_PREFERENCES]}),
        )?;
        Ok(())
    }

    fn emit(&self, ctx: &Context<'_>, event: Value) -> Result<()> {
        anyhow::ensure!(
            self.schemas.valid("skillsUpdatedPayload", &event)?,
            "The skill update is invalid."
        );
        let events = self.events.clone();
        ctx.after_commit(move || {
            events.with_journal(|journal| {
                journal.append("skills.updated", event, None);
            });
        })
    }

    fn page(&self, items: &[Value], revision: &str, query: &Value, key: &str) -> Result<Value> {
        if !self.schemas.valid("skillPageQuery", query)? {
            return Err(skill_error(
                400,
                "invalid_request",
                "The skill page query is invalid.",
            ));
        }
        let mut offset = 0;
        if let Some(cursor) = query["pageCursor"].as_str() {
            let decoded: Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(cursor).map_err(|_| {
                    skill_error(400, "invalid_request", "The skill page cursor is invalid.")
                })?)
                .map_err(|_| {
                    skill_error(400, "invalid_request", "The skill page cursor is invalid.")
                })?;
            if !self.schemas.valid("ownerSkillPagePosition", &decoded)? {
                return Err(skill_error(
                    400,
                    "invalid_request",
                    "The skill page cursor is invalid.",
                ));
            }
            if decoded["revision"] != revision {
                return Err(skill_error(
                    409,
                    "conflict",
                    "The skills changed while paging. Start the list again.",
                ));
            }
            offset = decoded["offset"].as_u64().unwrap_or(0) as usize;
        }
        let limit = query["limit"].as_u64().unwrap_or(50) as usize;
        let next = offset.saturating_add(limit).min(items.len());
        let cursor = if next < items.len() {
            Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(
                &json!({"revision":revision,"offset":next}),
            )?))
        } else {
            None
        };
        Ok(json!({key:items.get(offset..next).unwrap_or(&[]),"nextPageCursor":cursor}))
    }

    async fn scan(&self) -> Result<(u64, Arc<SkillScan>)> {
        let (sequence, future) = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if pending.is_none() {
                let sequence = self.sequence.fetch_add(1, Ordering::AcqRel) + 1;
                let root = self.config.global_skills_root();
                let future = async move {
                    tokio::task::spawn_blocking(move || scan_global_skills(&root, &Schemas::new()?))
                        .await
                        .map_err(|_| {
                            Arc::new(GlobalSkillsError {
                                status: 503,
                                code: "internal",
                                message: "The global skills directory cannot be read.".into(),
                                details: None,
                            })
                        })?
                        .map(Arc::new)
                        .map_err(|error| {
                            Arc::new(GlobalSkillsError {
                                status: 503,
                                code: "internal",
                                message: error.to_string(),
                                details: None,
                            })
                        })
                }
                .boxed()
                .shared();
                *pending = Some(PendingScan { sequence, future });
            }
            let pending = pending.as_ref().context("The skill scan did not start.")?;
            (pending.sequence, pending.future.clone())
        };
        match future.await {
            Ok(scan) => Ok((sequence, scan)),
            Err(error) => {
                self.release_scan(sequence);
                Err(error.as_ref().clone().into())
            }
        }
    }

    fn release_scan(&self, sequence: u64) {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending
            .as_ref()
            .is_some_and(|pending| pending.sequence == sequence)
        {
            *pending = None;
        }
    }

    async fn refresh(self: &Arc<Self>) -> Result<(Value, Arc<SkillScan>)> {
        let (sequence, scan) = self.scan().await?;
        let result = self.reconcile(sequence, scan.clone()).await;
        self.release_scan(sequence);
        Ok((result?, scan))
    }

    async fn reconcile(self: &Arc<Self>, sequence: u64, scan: Arc<SkillScan>) -> Result<Value> {
        let module = self.clone();
        self.runtime.transact(move |ctx| {
            let mut state = module.query_state(ctx)?;
            if state["scanSequence"].as_u64().unwrap_or(0) > sequence {
                return Err(skill_error(409,"conflict","The skills changed during this read. Reload the skill catalog."));
            }
            let initial = module.config.global_skill_enablement();
            let mut changed = Vec::new();
            let found = scan.skills.iter().map(|document| document.path.as_str()).collect::<BTreeSet<_>>();
            let entries = state["entries"].as_array_mut().context("Stored global skill entries are invalid.")?;
            for document in &scan.skills {
                let position = entries.iter().position(|entry| entry["skill"]["path"] == document.path);
                let prior = position.map(|position| &entries[position]);
                if prior.is_some_and(|entry| entry["present"] == true && entry["stamp"] == document.stamp) { continue; }
                let skill = json!({"id":prior.map(|entry|entry["skill"]["id"].clone()).unwrap_or_else(||json!(cuid2::create_id())),"path":document.path,"name":document.name,"description":document.description,"enabled":prior.and_then(|entry|entry["skill"]["enabled"].as_bool()).or_else(||initial.get(&document.path).copied()).unwrap_or(true),"status":document.status,"error":document.error,"version":skill_version(prior.and_then(|entry|entry["skill"]["version"].as_str()))?,"updatedAt":now()});
                changed.push(skill["id"].clone());
                let mut entry = prior.cloned().unwrap_or_else(||json!({}));
                entry["skill"] = skill;
                entry["present"] = json!(true);
                entry["stamp"] = json!(document.stamp);
                entry["canonical"] = json!(document.canonical);
                if let Some(position) = position { entries[position] = entry; }
                else {
                    if entries.len() >= 10000 {
                        return Err(skill_error(503,"internal","The installed skill history exceeds its storage limit."));
                    }
                    entries.push(entry);
                }
            }
            for entry in entries.iter_mut() {
                let path = entry["skill"]["path"].as_str().unwrap_or("");
                if entry["present"] != true || found.contains(path) { continue; }
                if scan.unreadable.iter().any(|unreadable| path == unreadable || path.starts_with(&format!("{unreadable}/"))) {
                    if entry["skill"]["status"] == "unreadable" { continue; }
                    let name = Path::new(path).file_name().map(|name|name.to_string_lossy().into_owned()).unwrap_or_default();
                    let version = skill_version(entry["skill"]["version"].as_str())?;
                    entry["skill"]["name"] = json!(name);
                    entry["skill"]["description"] = json!("");
                    entry["skill"]["status"] = json!("unreadable");
                    entry["skill"]["error"] = json!("The skill directory cannot be read.");
                    entry["skill"]["version"] = json!(version);
                    entry["skill"]["updatedAt"] = json!(now());
                    entry["stamp"] = json!("unreadable");
                } else { entry["present"] = json!(false); }
                changed.push(entry["skill"]["id"].clone());
            }
            let filesystem_changed = state["rootStamp"] != scan.root_stamp;
            if !changed.is_empty() || filesystem_changed { state["revision"] = json!(skill_version(state["revision"].as_str())?); }
            state["rootStamp"] = json!(scan.root_stamp);
            state["scanSequence"] = json!(sequence);
            save_global_skills_state(ctx, &module.schemas, &state)?;
            let previous = module.previous_paths.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            let paths = previous.keys().chain(scan.paths.keys()).collect::<BTreeSet<_>>().into_iter()
                .filter(|path| previous.get(*path) != scan.paths.get(*path)).cloned().collect::<Vec<_>>();
            drop(previous);
            if !changed.is_empty() || filesystem_changed {
                module.emit(ctx, json!({"skillIds":if changed.len()>100{Value::Null}else{json!(changed)},"paths":if paths.len()>100 || (filesystem_changed && paths.is_empty()){Value::Null}else{json!(paths)}}))?;
            }
            let updated = module.clone();
            ctx.after_commit(move || { *updated.previous_paths.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = scan.paths.clone(); })?;
            Ok(state)
        }).await
    }

    async fn write_preferences(self: Arc<Self>) -> Result<()> {
        let module = self.clone();
        let preferences = self
            .runtime
            .transact(move |ctx| {
                let state = module.query_state(ctx)?;
                Ok(state["entries"]
                    .as_array()
                    .context("Stored global skill entries are invalid.")?
                    .iter()
                    .map(|entry| {
                        (
                            entry["skill"]["path"].as_str().unwrap_or("").to_owned(),
                            entry["skill"]["enabled"].as_bool().unwrap_or(true),
                        )
                    })
                    .collect::<BTreeMap<_, _>>())
            })
            .await?;
        self.config
            .write_runtime_skill_enablement(preferences)
            .await
    }

    async fn watch(self: Arc<Self>, cancel: CancellationToken) -> Result<()> {
        if self.closed.load(Ordering::Acquire) || cancel.is_cancelled() {
            return Ok(());
        }
        let stop = CancellationToken::new();
        let done = CancellationToken::new();
        {
            let mut watching = self
                .watching
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            anyhow::ensure!(
                watching.is_none(),
                "The global skill watcher is already running."
            );
            if self.closed.load(Ordering::Acquire) {
                return Ok(());
            }
            *watching = Some(Watching {
                stop: stop.clone(),
                done: done.clone(),
            });
        }
        let _completion = WatchCompletion {
            owner: self.clone(),
            done,
        };
        let mut watches = native_watch::Watches::new();
        let mut periodic = tokio::time::interval(Duration::from_secs(30));
        periodic.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut broad = false;
        loop {
            if stop.is_cancelled() || cancel.is_cancelled() {
                break;
            }
            match self.scan().await {
                Ok((sequence, scan)) => {
                    let result = self.reconcile(sequence, scan.clone()).await;
                    self.release_scan(sequence);
                    result?;
                    let mut directories = scan.directories.clone();
                    #[cfg(target_os = "macos")]
                    for path in scan.paths.keys() {
                        // Directory vnodes report entry changes; file vnodes
                        // also report writes to an existing document or support file.
                        if let Ok(path) =
                            fs::canonicalize(self.config.global_skills_root().join(path))
                        {
                            directories.insert(path);
                        }
                    }
                    let mut parent = self.config.global_skills_root();
                    while parent.pop() {
                        if fs::symlink_metadata(&parent).is_ok_and(|metadata| metadata.is_dir()) {
                            directories.insert(parent.clone());
                            break;
                        }
                    }
                    if watches.update(&directories) {
                        continue;
                    }
                    if broad {
                        let module = self.clone();
                        self.runtime
                            .transact(move |ctx| {
                                module.emit(ctx, json!({"skillIds":null,"paths":null}))
                            })
                            .await?;
                        broad = false;
                    }
                }
                Err(error) => {
                    eprintln!("Global skills could not be refreshed: {error}");
                    let module = self.clone();
                    self.runtime
                        .transact(move |ctx| {
                            module.emit(ctx, json!({"skillIds":null,"paths":null}))
                        })
                        .await?;
                }
            }
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = stop.cancelled() => break,
                _ = periodic.tick() => {},
                event = watches.changed() => {
                    broad |= event;
                    tokio::select! {
                        _ = cancel.cancelled() => break,
                        _ = stop.cancelled() => break,
                        _ = tokio::time::sleep(Duration::from_millis(100)) => {},
                    }
                },
            }
        }
        Ok(())
    }
}

struct WatchCompletion {
    owner: Arc<GlobalSkillsModule>,
    done: CancellationToken,
}
impl Drop for WatchCompletion {
    fn drop(&mut self) {
        *self
            .owner
            .watching
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        self.done.cancel();
    }
}
#[derive(Clone, Copy)]
enum Procedure {
    Watch,
    WritePreferences,
}
struct SkillProcedure {
    owner: Weak<GlobalSkillsModule>,
    procedure: Procedure,
}
impl DurableFunction for SkillProcedure {
    fn execute(
        self: Arc<Self>,
        _call: Value,
        _kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let owner = self
                .owner
                .upgrade()
                .context("The global skills owner has stopped.")?;
            match self.procedure {
                Procedure::Watch => owner.watch(cancel).await?,
                Procedure::WritePreferences => {
                    anyhow::ensure!(
                        !cancel.is_cancelled(),
                        "The skill preference write was stopped."
                    );
                    owner.write_preferences().await?;
                }
            }
            Ok(Value::Null)
        })
    }
}

fn skill_version(previous: Option<&str>) -> Result<String> {
    let prior = previous.and_then(|value| {
        u64::from_str_radix(
            &value.replace('-', "").chars().take(12).collect::<String>(),
            16,
        )
        .ok()
    });
    let time = now().max(prior.map_or(0, |prior| prior.saturating_add(1)));
    anyhow::ensure!(
        time <= 0xffffffffffff,
        "The skill version clock is exhausted."
    );
    let stamp = format!("{time:012x}");
    let random = uuid::Uuid::new_v4().to_string();
    Ok(format!(
        "{}-{}-7{}",
        &stamp[..8],
        &stamp[8..],
        &random[15..]
    ))
}

#[derive(Default)]
struct SkillScan {
    skills: Vec<ScannedSkill>,
    paths: BTreeMap<String, String>,
    directories: BTreeSet<PathBuf>,
    root_stamp: String,
    unreadable: BTreeSet<String>,
}
struct ScannedSkill {
    path: String,
    canonical: PathBuf,
    name: String,
    description: String,
    status: &'static str,
    error: Option<&'static str>,
    content: Option<String>,
    instructions: Option<String>,
    files: Vec<Value>,
    stamp: String,
    files_error: bool,
}

fn read_skill_file(root: &Path, path: &str, maximum: usize, schemas: &Schemas) -> Result<Vec<u8>> {
    if !schemas.valid("skillRelativePath", &json!(path))? {
        return Err(skill_error(
            400,
            "invalid_request",
            "Provide a relative file path inside the skill.",
        ));
    }
    let candidate = root.join(path);
    let canonical = fs::canonicalize(&candidate).map_err(skill_file_io)?;
    if !canonical.starts_with(root) {
        return Err(skill_error(
            403,
            "forbidden",
            "The file is outside this skill.",
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(&canonical).map_err(skill_file_io)?;
    let metadata = file.metadata().map_err(skill_file_io)?;
    if !metadata.is_file() {
        return Err(skill_error(
            400,
            "invalid_request",
            "Only regular skill files may be read.",
        ));
    }
    let current = fs::canonicalize(&candidate).map_err(skill_file_io)?;
    let live = fs::metadata(&current).map_err(skill_file_io)?;
    if current != canonical
        || !current.starts_with(root)
        || file_identity(&metadata) != file_identity(&live)
    {
        return Err(skill_error(
            403,
            "forbidden",
            "The skill file location changed while it was opened.",
        ));
    }
    if metadata.len() > maximum as u64 {
        return Err(skill_error(
            413,
            "too_large",
            "The skill file is too large to read.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(skill_file_io)?;
    if bytes.len() > maximum {
        return Err(skill_error(
            413,
            "too_large",
            "The skill file is too large to read.",
        ));
    }
    Ok(bytes)
}

fn skill_file_io(error: std::io::Error) -> anyhow::Error {
    if matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    ) {
        skill_error(404, "not_found", "The skill file no longer exists.")
    } else {
        skill_error(403, "forbidden", "The skill file cannot be read.")
    }
}

fn file_identity(metadata: &fs::Metadata) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    {
        (
            metadata
                .created()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |time| time.as_nanos() as u64),
            metadata.len(),
        )
    }
}

fn file_stamp(metadata: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime() as f64 * 1000.0 + metadata.mtime_nsec() as f64 / 1_000_000.0,
            metadata.ctime() as f64 * 1000.0 + metadata.ctime_nsec() as f64 / 1_000_000.0,
            metadata.mode()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{:?}:{}:{:?}:{}",
            file_identity(metadata),
            metadata.len(),
            metadata.modified().ok(),
            metadata.permissions().readonly()
        )
    }
}

fn scan_global_skills(root: &Path, schemas: &Schemas) -> Result<SkillScan> {
    #[derive(Clone)]
    struct Directory {
        canonical: PathBuf,
        path: String,
        ancestors: BTreeSet<PathBuf>,
        discover: bool,
    }
    struct File {
        path: String,
        canonical: PathBuf,
        info: Option<Value>,
    }
    let mut scan = SkillScan::default();
    let root = match fs::canonicalize(root) {
        Ok(root) => root,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(scan),
        Err(_) => bail!("The global skills directory cannot be read."),
    };
    let initial =
        fs::symlink_metadata(&root).context("The global skills directory cannot be read.")?;
    let mut queue = vec![Directory {
        canonical: root.clone(),
        path: String::new(),
        ancestors: BTreeSet::new(),
        discover: true,
    }];
    let mut files = Vec::<File>::new();
    let mut entries = 0;
    let mut document_bytes = 0;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut index = 0;
    while index < queue.len() {
        anyhow::ensure!(
            queue.len() <= 4096 && Instant::now() <= deadline,
            "The global skills directory exceeds the scan limit."
        );
        let Directory {
            canonical,
            path,
            mut ancestors,
            discover,
        } = queue[index].clone();
        index += 1;
        if !discover
            && !scan
                .skills
                .iter()
                .any(|skill| path.starts_with(&format!("{}/", skill.path)))
        {
            continue;
        }
        if !ancestors.insert(canonical.clone()) {
            continue;
        }
        scan.directories.insert(canonical.clone());
        let mut has_document = false;
        match fs::read_dir(&canonical) {
            Ok(directory) => {
                for entry in directory {
                    entries += 1;
                    anyhow::ensure!(
                        entries <= 16384 && Instant::now() <= deadline,
                        "The global skills directory exceeds the scan limit."
                    );
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(_) => {
                            scan.unreadable.insert(path.clone());
                            continue;
                        }
                    };
                    let name = entry.file_name().to_string_lossy().into_owned();
                    let logical = if path.is_empty() {
                        name.clone()
                    } else {
                        format!("{path}/{name}")
                    };
                    if !schemas.valid("skillRelativePath", &json!(logical))? {
                        continue;
                    }
                    let candidate = canonical.join(&name);
                    let metadata = match fs::symlink_metadata(&candidate) {
                        Ok(metadata) => metadata,
                        Err(_) if path.is_empty() => {
                            bail!("The global skills directory changed during the scan.")
                        }
                        Err(_) => {
                            scan.unreadable.insert(path.clone());
                            continue;
                        }
                    };
                    scan.paths.insert(logical.clone(), file_stamp(&metadata));
                    if name == "SKILL.md" && !path.is_empty() && discover {
                        has_document = true;
                    }
                    if metadata.is_dir() || metadata.file_type().is_symlink() {
                        match fs::canonicalize(&candidate).and_then(|linked| {
                            fs::symlink_metadata(&linked).map(|info| (linked, info))
                        }) {
                            Ok((linked, info)) if info.is_dir() => {
                                if !ancestors.contains(&linked) {
                                    queue.push(Directory {
                                        canonical: linked,
                                        path: logical,
                                        ancestors: ancestors.clone(),
                                        discover: discover
                                            && !name.starts_with('.')
                                            && name != "node_modules",
                                    });
                                }
                                continue;
                            }
                            Err(_) => {
                                scan.unreadable.insert(path.clone());
                            }
                            _ => {}
                        }
                    }
                    let modified = metadata
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map_or(0, |time| time.as_millis() as u64);
                    files.push(File {
                        path: logical.clone(),
                        canonical: candidate,
                        info: metadata.is_file().then(
                            || json!({"path":logical,"size":metadata.len(),"modifiedAt":modified}),
                        ),
                    });
                }
            }
            Err(_) if path.is_empty() => bail!("The global skills directory cannot be read."),
            Err(_) => {
                scan.unreadable.insert(path.clone());
                has_document = discover
                    && fs::symlink_metadata(canonical.join("SKILL.md"))
                        .is_ok_and(|info| info.is_file());
            }
        }
        if !has_document {
            continue;
        }
        anyhow::ensure!(
            scan.skills.len() < 1024,
            "Too many global skills are installed to scan safely."
        );
        let mut skill = ScannedSkill {
            path: path.clone(),
            canonical: canonical.clone(),
            name: Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            description: String::new(),
            status: "unreadable",
            error: Some("The skill document cannot be read."),
            content: None,
            instructions: None,
            files: Vec::new(),
            stamp: String::new(),
            files_error: false,
        };
        let document = (|| -> Result<String> {
            anyhow::ensure!(
                !fs::symlink_metadata(canonical.join("SKILL.md"))?
                    .file_type()
                    .is_symlink(),
                "The skill document is linked."
            );
            let bytes = read_skill_file(&canonical, "SKILL.md", 256 * 1024, schemas)?;
            document_bytes += bytes.len();
            anyhow::ensure!(
                document_bytes <= 64 * 1024 * 1024,
                "The skill documents exceed the scan memory limit."
            );
            Ok(String::from_utf8(bytes)?)
        })();
        anyhow::ensure!(
            document_bytes <= 64 * 1024 * 1024,
            "The skill documents exceed the scan memory limit."
        );
        if let Ok(content) = document {
            skill.status = "invalid";
            skill.error = Some("The skill needs valid name and description frontmatter.");
            if let Ok((metadata, instructions)) = frontmatter::parse(
                &content,
                canonical
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .as_deref()
                    .unwrap_or(""),
                schemas,
            ) {
                let mut entry = metadata.clone();
                entry["location"] = json!(canonical.join("SKILL.md"));
                entry["source"] = json!("user");
                if schemas.valid("skillEntry", &entry)? {
                    skill.name = metadata["name"].as_str().unwrap_or("").to_owned();
                    skill.description = metadata["description"].as_str().unwrap_or("").to_owned();
                    skill.instructions = Some(instructions);
                    skill.status = "ready";
                    skill.error = None;
                }
            }
            skill.content = Some(content);
        }
        scan.skills.push(skill);
    }
    scan.skills
        .sort_by(|left, right| left.path.cmp(&right.path));
    let installed = scan
        .skills
        .iter()
        .map(|skill| skill.path.clone())
        .collect::<Vec<_>>();
    for skill in &mut scan.skills {
        let prefix = format!("{}/", skill.path);
        let nested = installed
            .iter()
            .filter(|path| path.starts_with(&prefix))
            .collect::<Vec<_>>();
        skill.files = files
            .iter()
            .filter(|file| {
                file.path.starts_with(&prefix)
                    && !nested
                        .iter()
                        .any(|other| file.path.starts_with(&format!("{other}/")))
                    && file.canonical.starts_with(&skill.canonical)
            })
            .filter_map(|file| {
                file.info.as_ref().map(|info| {
                    let mut info = info.clone();
                    info["path"] = json!(&file.path[prefix.len()..]);
                    info
                })
            })
            .collect();
        skill
            .files
            .sort_by(|left, right| left["path"].as_str().cmp(&right["path"].as_str()));
        skill.files_error = scan
            .unreadable
            .iter()
            .any(|path| path == &skill.path || path.starts_with(&prefix));
        let owned = scan
            .paths
            .iter()
            .filter(|(path, _)| {
                (*path == &skill.path || path.starts_with(&prefix))
                    && !nested
                        .iter()
                        .any(|other| *path == *other || path.starts_with(&format!("{other}/")))
            })
            .map(|(path, stamp)| json!([path, stamp]))
            .collect::<Vec<_>>();
        skill.stamp = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&json!([
                skill.canonical,
                skill.content,
                skill.status,
                skill.files_error,
                owned
            ]))?)
        );
    }
    let live = fs::symlink_metadata(&root)
        .context("The global skills directory changed during the scan.")?;
    anyhow::ensure!(
        file_identity(&initial) == file_identity(&live),
        "The global skills directory changed during the scan."
    );
    let paths = scan
        .paths
        .iter()
        .map(|(path, stamp)| json!([path, stamp]))
        .collect::<Vec<_>>();
    let (dev, ino) = file_identity(&live);
    scan.root_stamp = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&json!([root, dev, ino, paths]))?)
    );
    Ok(scan)
}

mod frontmatter {
    use super::*;
    use serde::de::{MapAccess, Visitor};
    use std::fmt;

    struct MetadataMap(serde_yaml::Mapping);
    impl<'de> serde::Deserialize<'de> for MetadataMap {
        fn deserialize<D: serde::Deserializer<'de>>(
            deserializer: D,
        ) -> std::result::Result<Self, D::Error> {
            struct MapVisitor;
            impl<'de> Visitor<'de> for MapVisitor {
                type Value = MetadataMap;
                fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                    formatter.write_str("a skill frontmatter map")
                }
                fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                    Ok(MetadataMap(serde_yaml::Mapping::new()))
                }
                fn visit_map<M: MapAccess<'de>>(
                    self,
                    mut entries: M,
                ) -> std::result::Result<Self::Value, M::Error> {
                    let mut mapping = serde_yaml::Mapping::new();
                    while let Some((key, value)) =
                        entries.next_entry::<serde_yaml::Value, serde_yaml::Value>()?
                    {
                        // The shipped loader accepts duplicate top-level scalar
                        // keys and the last value wins, including a kind change.
                        if matches!(
                            value,
                            serde_yaml::Value::String(_) | serde_yaml::Value::Bool(_)
                        ) {
                            mapping.insert(key, value);
                        }
                    }
                    Ok(MetadataMap(mapping))
                }
            }
            deserializer.deserialize_any(MapVisitor)
        }
    }

    /// YAML syntax belongs to the YAML parser, including aliases and block
    /// scalars. Runtime metadata still uses the original TypeBox schemas.
    pub fn parse(content: &str, directory: &str, schemas: &Schemas) -> Result<(Value, String)> {
        let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
        let lines = normalized.split('\n').collect::<Vec<_>>();
        let closing = lines
            .iter()
            .enumerate()
            .skip(1)
            .find(|(_, line)| marker(line.trim_start_matches([' ', '\t'])))
            .map(|(index, _)| index);
        if lines.first().is_none_or(|line| !marker(line)) || closing.is_none() {
            return Ok((json!({"name":directory,"description":""}), String::new()));
        }
        let closing = closing.context("The skill frontmatter is incomplete.")?;
        let source = format!("{}\n", lines[1..closing].join("\n"));
        let MetadataMap(mapping) = serde_yaml::from_str(&source)?;
        let mut metadata = json!({"name":directory,"description":""});
        for field in ["name", "description"] {
            if let Some(value) = mapping
                .get(serde_yaml::Value::String(field.into()))
                .and_then(serde_yaml::Value::as_str)
            {
                metadata[field] = json!(value);
            }
        }
        if mapping
            .get(serde_yaml::Value::String("disable-model-invocation".into()))
            .and_then(serde_yaml::Value::as_bool)
            == Some(true)
        {
            metadata["disableModelInvocation"] = json!(true);
        }
        anyhow::ensure!(
            schemas.valid("ownerSkillMetadata", &metadata)?,
            "Skill frontmatter metadata is invalid."
        );
        Ok((metadata, lines[closing + 1..].join("\n")))
    }

    fn marker(line: &str) -> bool {
        line.strip_prefix("---").is_some_and(|rest| {
            let rest = rest.trim_start_matches([' ', '\t']);
            rest.is_empty() || rest.starts_with('#')
        })
    }
}

mod native_watch {
    use super::*;
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    use tokio::io::unix::AsyncFd;

    /// Native notifications accelerate the bounded periodic scan. Failure to
    /// acquire a watch does not invalidate a catalog or retain a stale entry.
    pub struct Watches {
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        descriptor: Option<AsyncFd<OwnedFd>>,
        #[cfg(target_os = "linux")]
        directories: BTreeMap<PathBuf, (i32, (u64, u64))>,
        #[cfg(target_os = "macos")]
        directories: BTreeMap<PathBuf, (fs::File, (u64, u64))>,
    }

    impl Watches {
        pub fn new() -> Self {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            let descriptor = {
                #[cfg(target_os = "linux")]
                // A nonblocking inotify instance is owned by this execution.
                let raw = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
                #[cfg(target_os = "macos")]
                // A kqueue instance is owned by this execution.
                let raw = unsafe { libc::kqueue() };
                if raw < 0 {
                    None
                } else {
                    // Successful creation transfers the unique descriptor here.
                    let owned = unsafe { OwnedFd::from_raw_fd(raw) };
                    #[cfg(target_os = "macos")]
                    // kqueue reads below use a zero timeout; CLOEXEC avoids
                    // leaking installation watches into child commands.
                    unsafe {
                        libc::fcntl(owned.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
                    }
                    AsyncFd::new(owned).ok()
                }
            };
            Self {
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                descriptor,
                #[cfg(any(target_os = "linux", target_os = "macos"))]
                directories: BTreeMap::new(),
            }
        }

        /// Return whether adding handles requires another scan to close the
        /// discovery/subscription gap. Retargeted directory identities re-arm.
        pub fn update(&mut self, desired: &BTreeSet<PathBuf>) -> bool {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            {
                let Some(descriptor) = &self.descriptor else {
                    return false;
                };
                let raw = descriptor.get_ref().as_raw_fd();
                let obsolete = self
                    .directories
                    .iter()
                    .filter(|(path, (_, identity))| {
                        !desired.contains(*path)
                            || fs::symlink_metadata(path)
                                .map_or(true, |metadata| file_identity(&metadata) != *identity)
                    })
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>();
                for path in obsolete {
                    if let Some((handle, _)) = self.directories.remove(&path) {
                        #[cfg(target_os = "linux")]
                        // Removal owns only this instance's previously added watch.
                        unsafe {
                            libc::inotify_rm_watch(raw, handle);
                        }
                        #[cfg(target_os = "macos")]
                        let _ = vnode_change(raw, handle.as_raw_fd(), libc::EV_DELETE);
                    }
                }
                let mut added = false;
                for path in desired {
                    if self.directories.contains_key(path) {
                        continue;
                    }
                    let Ok(metadata) = fs::symlink_metadata(path) else {
                        continue;
                    };
                    #[cfg(target_os = "linux")]
                    if !metadata.is_dir() {
                        continue;
                    }
                    #[cfg(target_os = "macos")]
                    if !metadata.is_dir() && !metadata.is_file() {
                        continue;
                    }
                    #[cfg(target_os = "linux")]
                    {
                        use std::os::unix::ffi::OsStrExt;
                        let Ok(pathname) = std::ffi::CString::new(path.as_os_str().as_bytes())
                        else {
                            continue;
                        };
                        let mask = libc::IN_ATTRIB
                            | libc::IN_CLOSE_WRITE
                            | libc::IN_CREATE
                            | libc::IN_DELETE
                            | libc::IN_DELETE_SELF
                            | libc::IN_MODIFY
                            | libc::IN_MOVED_FROM
                            | libc::IN_MOVED_TO
                            | libc::IN_MOVE_SELF;
                        // The path buffer remains valid for this bounded syscall.
                        let handle =
                            unsafe { libc::inotify_add_watch(raw, pathname.as_ptr(), mask) };
                        if handle >= 0 {
                            self.directories
                                .insert(path.clone(), (handle, file_identity(&metadata)));
                            added = true;
                        }
                    }
                    #[cfg(target_os = "macos")]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        let Ok(handle) = fs::OpenOptions::new()
                            .read(true)
                            .custom_flags(libc::O_EVTONLY | libc::O_CLOEXEC)
                            .open(path)
                        else {
                            continue;
                        };
                        if vnode_change(
                            raw,
                            handle.as_raw_fd(),
                            libc::EV_ADD | libc::EV_ENABLE | libc::EV_CLEAR,
                        )
                        .is_ok()
                        {
                            self.directories
                                .insert(path.clone(), (handle, file_identity(&metadata)));
                            added = true;
                        }
                    }
                }
                added
            }
            #[cfg(not(any(target_os = "linux", target_os = "macos")))]
            {
                let _ = desired;
                false
            }
        }

        pub async fn changed(&mut self) -> bool {
            #[cfg(any(target_os = "linux", target_os = "macos"))]
            {
                if let Some(descriptor) = &self.descriptor {
                    loop {
                        let Ok(mut ready) = descriptor.readable().await else {
                            break;
                        };
                        match ready
                            .try_io(|descriptor| read_events(descriptor.get_ref().as_raw_fd()))
                        {
                            Ok(Ok(broad)) => return broad,
                            Ok(Err(_)) => break,
                            Err(_) => {}
                        }
                    }
                }
                self.descriptor = None;
                self.directories.clear();
            }
            // On platforms without a native carrier, or after native failure,
            // the same bounded 30-second scan remains active and cancellable.
            std::future::pending().await
        }
    }

    #[cfg(target_os = "linux")]
    fn read_events(raw: i32) -> std::io::Result<bool> {
        let mut bytes = [0u8; 65536];
        // This descriptor is nonblocking and the output buffer is fully owned.
        let count = unsafe { libc::read(raw, bytes.as_mut_ptr().cast(), bytes.len()) };
        if count < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if count == 0 {
            return Err(std::io::ErrorKind::WouldBlock.into());
        }
        let mut offset = 0;
        let mut broad = false;
        let length = std::mem::size_of::<libc::inotify_event>();
        while offset + length <= count as usize {
            // The kernel supplies aligned records; the byte array itself may
            // have less alignment, so copy each fixed header without alignment.
            let event = unsafe {
                std::ptr::read_unaligned(bytes.as_ptr().add(offset).cast::<libc::inotify_event>())
            };
            broad |= event.mask & (libc::IN_Q_OVERFLOW | libc::IN_IGNORED) != 0 || event.len == 0;
            offset += length + event.len as usize;
        }
        Ok(broad)
    }

    #[cfg(target_os = "macos")]
    fn vnode_change(raw: i32, directory: i32, flags: u16) -> std::io::Result<()> {
        // The initialized record describes one owned directory descriptor.
        let mut event: libc::kevent = unsafe { std::mem::zeroed() };
        event.ident = directory as libc::uintptr_t;
        event.filter = libc::EVFILT_VNODE;
        event.flags = flags;
        event.fflags = libc::NOTE_WRITE
            | libc::NOTE_DELETE
            | libc::NOTE_RENAME
            | libc::NOTE_ATTRIB
            | libc::NOTE_EXTEND;
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        // All pointed-to records live until the bounded call returns.
        if unsafe { libc::kevent(raw, &event, 1, std::ptr::null_mut(), 0, &timeout) } < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn read_events(raw: i32) -> std::io::Result<bool> {
        // The kernel fills at most the supplied fixed-size event array.
        let mut events: [libc::kevent; 128] = unsafe { std::mem::zeroed() };
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let count = unsafe {
            libc::kevent(
                raw,
                std::ptr::null(),
                0,
                events.as_mut_ptr(),
                events.len() as i32,
                &timeout,
            )
        };
        if count < 0 {
            return Err(std::io::Error::last_os_error());
        }
        if count == 0 {
            return Err(std::io::ErrorKind::WouldBlock.into());
        }
        Ok(events[..count as usize].iter().any(|event| {
            event.flags & libc::EV_ERROR != 0
                || event.fflags & (libc::NOTE_RENAME | libc::NOTE_DELETE) != 0
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::owners::{GlobalSkillsError, tests::Fixture};

    fn document(name: &str) -> String {
        format!("---\nname: {name}\ndescription: A useful skill.\n---\nRead the diff.\n")
    }

    #[test]
    fn yaml_frontmatter_matches_shipped_alias_block_duplicate_and_boolean_examples() {
        let schemas = Schemas::new().expect("TypeBox metadata");
        let cases = [
            (
                "---\n{name: flow, description: \"Flow: skill\"}\n---\nBody",
                json!({"name":"flow","description":"Flow: skill"}),
            ),
            (
                "---\nname: &skill alias\ndescription: *skill\n---\nBody",
                json!({"name":"alias","description":"alias"}),
            ),
            (
                "---\nname: quoted-name\ndescription: first\n  second\nunknown: ignored\ndescription: 'last: value # kept'\n---\nBody",
                json!({"name":"quoted-name","description":"last: value # kept"}),
            ),
            (
                "---\rname: block\rdescription: |-\r  first\r  second\r---\rBody",
                json!({"name":"block","description":"first\nsecond"}),
            ),
            (
                "---\nname: folded\ndescription: >+\n  first\n  second\n\n---\nBody",
                json!({"name":"folded","description":"first second\n\n"}),
            ),
            (
                "--- # metadata\nname: commented\ndescription: Valid.\n--- # end\nBody",
                json!({"name":"commented","description":"Valid."}),
            ),
            (
                "---\nname: 42\ndescription: A valid description.\n---\nBody",
                json!({"name":"fallback","description":"A valid description."}),
            ),
            (
                "---\n{ name: deploy, description: Deploy., disable-model-invocation: TRUE }\n---\nBody",
                json!({"name":"deploy","description":"Deploy.","disableModelInvocation":true}),
            ),
        ];
        for (source, expected) in cases {
            assert_eq!(
                frontmatter::parse(source, "fallback", &schemas)
                    .expect("valid YAML")
                    .0,
                expected,
                "{source}"
            );
        }
        for value in ["false", "\"true\"", "yes", "1", "~"] {
            let source = format!(
                "---\nname: deploy\ndescription: Deploy.\ndisable-model-invocation: {value}\n---\nBody"
            );
            assert_eq!(
                frontmatter::parse(&source, "fallback", &schemas)
                    .expect("YAML scalar")
                    .0,
                json!({"name":"deploy","description":"Deploy."})
            );
        }
        assert_eq!(frontmatter::parse("---\nname: deploy\ndescription: Deploy.\ndisable-model-invocation: true\ndisable-model-invocation: no\n---\nBody","fallback",&schemas).expect("duplicate changes scalar kind").0,json!({"name":"deploy","description":"Deploy."}));
    }

    #[tokio::test]
    async fn stable_catalog_keeps_original_text_and_nested_support_files_separate() {
        let fixture = Fixture::new().await;
        let content = document("parent").replace('\n', "\r\n");
        let parent = fixture.install("parent", &content);
        fixture.install("parent/child", &document("child"));
        fixture.install(".hidden", &document("hidden"));
        fs::create_dir_all(parent.join(".support")).expect("support folder");
        fs::write(parent.join(".support/readme.txt"), "Supporting data.").expect("support file");
        let first = fixture.skills.list(json!({})).await.expect("catalog");
        let cursor = fixture.events.cursor();
        assert_eq!(
            fixture
                .skills
                .list(json!({}))
                .await
                .expect("fresh unchanged scan"),
            first
        );
        assert_eq!(fixture.events.cursor(), cursor);
        let entries = first["skills"].as_array().expect("skills");
        assert_eq!(entries.len(), 2);
        let id = entries[0]["id"].as_str().expect("parent identity");
        let read = fixture.skills.read(id).await.expect("current document");
        assert_eq!(read["content"], content);
        assert_eq!(read["instructions"], "Read the diff.\n");
        let files = fixture
            .skills
            .files(id, json!({}))
            .await
            .expect("parent files");
        assert_eq!(
            files["files"]
                .as_array()
                .expect("files")
                .iter()
                .map(|file| file["path"].as_str().expect("path"))
                .collect::<Vec<_>>(),
            vec![".support/readme.txt", "SKILL.md"]
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn disablement_survives_removal_reinstallation_restart_and_current_preference_write() {
        let mut fixture = Fixture::new().await;
        let path = fixture.install("review", &document("review"));
        let first = fixture.skills.list(json!({})).await.expect("catalog")["skills"][0].clone();
        let disabled = fixture
            .skills
            .set_enabled_current(
                first["id"].as_str().expect("id").to_owned(),
                false,
                first["version"].as_str().expect("version").to_owned(),
                Some("disable-review".into()),
            )
            .await
            .expect("disable current skill");
        assert_eq!(disabled["enabled"], false);
        fs::remove_dir_all(&path).expect("uninstall skill");
        assert_eq!(
            fixture
                .skills
                .list(json!({}))
                .await
                .expect("removed catalog")["skills"],
            json!([])
        );
        fixture.install("review", &document("review"));
        let reinstalled = fixture
            .skills
            .list(json!({}))
            .await
            .expect("reinstallation")["skills"][0]
            .clone();
        assert_eq!(reinstalled["id"], first["id"]);
        assert_eq!(reinstalled["enabled"], false);
        fixture.restart().await;
        fixture
            .durable
            .start()
            .await
            .expect("real preference owner recovery");
        fixture
            .wait_runtime(
                "skill_enablement",
                &toml::Value::try_from(json!({"review":false})).expect("enablement TOML"),
            )
            .await;
        fixture.wait_pending_count(WRITE_PREFERENCES, 0).await;
        let owner = fixture.skills.clone();
        assert_eq!(
            fixture
                .runtime
                .transact(move |ctx| owner.unavailable_locations(ctx))
                .await
                .expect("native discovery availability"),
            BTreeSet::from([path.join("SKILL.md")])
        );
        assert_eq!(
            fixture
                .skills
                .list(json!({}))
                .await
                .expect("recovered catalog")["skills"][0]["id"],
            first["id"]
        );
        fixture.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn aliases_keep_independent_preferences_cycles_do_not_recurse_and_file_escapes_fail() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new().await;
        let path = fixture.install(
            "original",
            "---\ndescription: A linked skill.\n---\nInstructions.",
        );
        symlink(&path, fixture.config.global_skills_root().join("alias"))
            .expect("installation alias");
        symlink(fixture.config.global_skills_root(), path.join("cycle")).expect("ancestor cycle");
        let list = fixture
            .skills
            .list(json!({}))
            .await
            .expect("bounded aliases");
        assert_eq!(list["skills"].as_array().expect("aliases").len(), 2);
        assert_eq!(list["skills"][0]["name"], "original");
        assert_eq!(list["skills"][1]["name"], "original");
        let original = list["skills"][1].clone();
        fixture
            .skills
            .set_enabled_current(
                original["id"].as_str().expect("id").to_owned(),
                false,
                original["version"].as_str().expect("version").to_owned(),
                None,
            )
            .await
            .expect("disable one alias");
        let owner = fixture.skills.clone();
        assert!(
            fixture
                .runtime
                .transact(move |ctx| owner.unavailable_locations(ctx))
                .await
                .expect("other alias remains available")
                .is_empty()
        );
        let alias = list["skills"][0].clone();
        fixture
            .skills
            .set_enabled_current(
                alias["id"].as_str().expect("id").to_owned(),
                false,
                alias["version"].as_str().expect("version").to_owned(),
                None,
            )
            .await
            .expect("disable other alias");
        let outside = fixture.directory.path().join("outside.txt");
        fs::write(&outside, "Outside the installation.").expect("outside fixture file");
        symlink(outside, path.join("escape.txt")).expect("escaping file alias");
        assert!(
            fixture
                .skills
                .read_file(original["id"].as_str().expect("id"), "escape.txt")
                .await
                .is_err()
        );
        assert!(
            fixture
                .skills
                .read_file(original["id"].as_str().expect("id"), "../outside.txt")
                .await
                .is_err()
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn preference_mutation_and_notification_roll_back_with_caller_transaction() {
        let fixture = Fixture::new().await;
        fixture.install("review", &document("review"));
        let skill = fixture.skills.list(json!({})).await.expect("catalog")["skills"][0].clone();
        let before = fixture.pending().await.expect("startup intents");
        let cursor = fixture.events.cursor();
        let owner = fixture.skills.clone();
        let prior = skill.clone();
        let result: Result<()> = fixture
            .runtime
            .transact(move |ctx| {
                owner.set_enabled(
                    ctx,
                    prior["id"].as_str().expect("id"),
                    false,
                    prior["version"].as_str().expect("version"),
                    None,
                )?;
                bail!("Deliberate preference transaction rollback.");
            })
            .await;
        assert!(result.is_err());
        assert_eq!(
            fixture.pending().await.expect("same durable intents"),
            before
        );
        assert_eq!(fixture.events.cursor(), cursor);
        let owner = fixture.skills.clone();
        assert_eq!(
            fixture
                .runtime
                .transact(move |ctx| owner.get(ctx, skill["id"].as_str().expect("id")))
                .await
                .expect("same committed preference")["enabled"],
            true
        );
        fixture.close().await;
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[tokio::test]
    async fn durable_watch_discovers_a_missing_root_and_restarts_one_pending_owned_lifetime() {
        let mut fixture = Fixture::new().await;
        fixture
            .skills
            .start()
            .await
            .expect("after-start watch intent");
        let initial = fixture
            .pending()
            .await
            .expect("owed watch")
            .into_iter()
            .find(|call| call["function"] == WATCH)
            .expect("watch row");
        assert_eq!(initial["operationId"], WATCH);
        assert_eq!(initial["lockKeys"], json!([WATCH]));
        fixture.durable.start().await.expect("start real owners");
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if fixture.skills.watching.lock().unwrap().is_some() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("watch execution owns a lifetime");
        fixture.install("new", &document("new"));
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let owner = fixture.skills.clone();
                let state = fixture
                    .runtime
                    .transact(move |ctx| owner.query_state(ctx))
                    .await
                    .expect("watch catalog state");
                if state["entries"]
                    .as_array()
                    .expect("entries")
                    .iter()
                    .any(|entry| entry["present"] == true && entry["skill"]["path"] == "new")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("native filesystem event updates catalog without a read");
        fixture.restart().await;
        assert!(fixture.skills.watching.lock().unwrap().is_none());
        fixture
            .skills
            .start()
            .await
            .expect("restart watch deduplicates pending call");
        let pending = fixture
            .pending()
            .await
            .expect("preserved watch")
            .into_iter()
            .filter(|call| call["function"] == WATCH)
            .collect::<Vec<_>>();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0]["id"], initial["id"]);
        fixture
            .durable
            .start()
            .await
            .expect("recover actual watch owner");
        fixture.close().await;
        assert!(fixture.skills.watching.lock().unwrap().is_none());
    }

    #[tokio::test]
    async fn pagination_detects_changed_catalog_and_versions_advance_past_future_observations() {
        let fixture = Fixture::new().await;
        fixture.install("one", &document("one"));
        fixture.install("two", &document("two"));
        let first = fixture
            .skills
            .list(json!({"limit":1}))
            .await
            .expect("first page");
        let second = fixture
            .skills
            .list(json!({"limit":1,"pageCursor":first["nextPageCursor"]}))
            .await
            .expect("stable second page");
        assert_eq!(second["skills"][0]["path"], "two");
        fixture.install("three", &document("three"));
        assert!(
            fixture
                .skills
                .list(json!({"pageCursor":first["nextPageCursor"]}))
                .await
                .is_err()
        );
        let previous = "ffffffff-fffe-7abc-8123-456789abcdef";
        let next = skill_version(Some(previous)).expect("advance future timestamp");
        assert!(next.as_str() > previous);
        fixture.close().await;
    }

    #[tokio::test]
    async fn management_errors_preserve_source_status_codes_and_conflict_resource() {
        let fixture = Fixture::new().await;
        let path = fixture.install("review", &document("review"));
        let original = fixture.skills.list(json!({})).await.expect("catalog")["skills"][0].clone();
        let current = fixture
            .skills
            .set_enabled_current(
                original["id"].as_str().expect("id").into(),
                false,
                original["version"].as_str().expect("version").into(),
                None,
            )
            .await
            .expect("disable skill");
        let conflict = fixture
            .skills
            .set_enabled_current(
                original["id"].as_str().expect("id").into(),
                true,
                original["version"].as_str().expect("version").into(),
                None,
            )
            .await
            .expect_err("stale expected version");
        let conflict = conflict
            .downcast_ref::<GlobalSkillsError>()
            .expect("typed management conflict");
        assert_eq!((conflict.status, conflict.code), (409, "conflict"));
        assert_eq!(
            conflict.details,
            Some(json!({"currentVersion":current["version"],"skill":current}))
        );
        let oversized = fs::File::create(path.join("large.txt")).expect("support file");
        oversized
            .set_len(8 * 1024 * 1024 + 1)
            .expect("bounded sparse fixture");
        drop(oversized);
        let error = fixture
            .skills
            .read_file(original["id"].as_str().expect("id"), "large.txt")
            .await
            .expect_err("oversized supporting file");
        assert_eq!(
            error
                .downcast_ref::<GlobalSkillsError>()
                .expect("typed size failure")
                .status,
            413
        );
        let error = fixture
            .skills
            .read_file(original["id"].as_str().expect("id"), "../escape")
            .await
            .expect_err("invalid relative path");
        assert_eq!(
            error
                .downcast_ref::<GlobalSkillsError>()
                .expect("typed path failure")
                .status,
            400
        );
        let owner = fixture.skills.clone();
        let error = fixture
            .runtime
            .transact(move |ctx| owner.get(ctx, "absentskill"))
            .await
            .expect_err("missing installed identity");
        assert_eq!(
            error
                .downcast_ref::<GlobalSkillsError>()
                .expect("typed missing resource")
                .status,
            404
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn concurrent_real_node_and_preference_executors_preserve_both_runtime_fields() {
        let fixture = Fixture::new().await;
        fixture.install("review", &document("review"));
        let skill = fixture.skills.list(json!({})).await.expect("catalog")["skills"][0].clone();
        let owner = fixture.skills.clone();
        let node = fixture.node.clone();
        fixture
            .runtime
            .transact(move |ctx| {
                owner.set_enabled(
                    ctx,
                    skill["id"].as_str().expect("id"),
                    false,
                    skill["version"].as_str().expect("version"),
                    None,
                )?;
                node.set_name(ctx, "Both durable owners")?;
                Ok(())
            })
            .await
            .expect("two atomic intents with disjoint execution locks");
        fixture
            .durable
            .start()
            .await
            .expect("concurrent real owners");
        fixture.wait_pending_count(WRITE_PREFERENCES, 0).await;
        fixture
            .wait_pending_count("node-save-runtime-name", 0)
            .await;
        let runtime: toml::Value = toml::from_str(
            &fs::read_to_string(fixture.runtime_file()).expect("atomic runtime file"),
        )
        .expect("complete TOML");
        assert_eq!(
            runtime["node"]["name"].as_str(),
            Some("Both durable owners")
        );
        assert_eq!(runtime["skill_enablement"]["review"].as_bool(), Some(false));
        fixture.close().await;
    }
}
