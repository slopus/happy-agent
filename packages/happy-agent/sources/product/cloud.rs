//! Cloud owns WorkOS authorization, rotating credentials and organization operations.
mod credentials;
mod operations;
mod persistence;
mod procedures;
#[cfg(test)]
mod tests;
mod transport;
mod validation;

use super::{
    config::ConfigModule,
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    events::EventsModule,
    identity::{Versions, now},
    lifecycle::LifecycleModule,
    runtime::{Context, RuntimeModule},
    schemas::Schemas,
};
use anyhow::{Context as _, Result, ensure};
use futures_util::future::{BoxFuture, FutureExt, Shared};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    sync::{Semaphore, oneshot},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;
use transport::{Boundary, RemoteError};

const EXPIRY_OPERATION: &str = "cloud.authorization-expiry";
const REFRESH_OPERATION: &str = "cloud.session-refresh";
const HOUR: u64 = 3_600_000;
#[derive(Debug, Clone)]
pub struct CloudOperationError {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    pub cloud: Value,
}
impl std::fmt::Display for CloudOperationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for CloudOperationError {}

pub struct CloudModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    events: Arc<EventsModule>,
    lifecycle: Arc<LifecycleModule>,
    schemas: Schemas,
    credentials: tokio::sync::Mutex<()>,
    snapshot: Mutex<Value>,
    attempt: Mutex<Option<Attempt>>,
    cache: Mutex<VecDeque<(String, Arc<Credential>)>>,
    generation: AtomicU64,
    started: AtomicBool,
    closed: AtomicBool,
    work: Arc<Semaphore>,
    tasks: Mutex<JoinSet<()>>,
}
#[derive(Clone)]
struct Attempt {
    environment: String,
    expires: u64,
    verifier: String,
    state: String,
    redirect: String,
    url: String,
    version: String,
    consumed: bool,
}
struct Credential {
    token: Mutex<Option<validation::Token>>,
    pending: Mutex<
        Option<Shared<BoxFuture<'static, std::result::Result<String, Arc<CloudOperationError>>>>>,
    >,
    waiters: Mutex<Vec<Weak<CancellationToken>>>,
    refresh_after: AtomicU64,
    generation: u64,
}
#[derive(Clone, Copy)]
enum Function {
    Expiry,
    Refresh,
}
struct Procedure {
    module: Weak<CloudModule>,
    kind: Function,
}

impl CloudModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        lifecycle: Arc<LifecycleModule>,
        events: Arc<EventsModule>,
    ) -> Result<Arc<Self>> {
        let schemas = Schemas::new()?;
        for name in [
            "cloudSnapshot",
            "cloudStoredState",
            "cloudStartRequest",
            "cloudCompleteRequest",
            "cloudAuthorizationExpiry",
            "cloudSessionRefresh",
            "cloudAuthenticationWire",
            "cloudDeployment",
        ] {
            let _ = schemas.valid(name, &Value::Null)?;
        }
        let snapshot = json!({"authorization":null,"environment":null,"error":null,"status":"disconnected","updatedAt":now(),"user":null,"version":Versions::new().next()});
        let module = Arc::new(Self {
            config,
            runtime,
            durable: durable.clone(),
            events,
            lifecycle,
            schemas,
            credentials: tokio::sync::Mutex::new(()),
            snapshot: Mutex::new(snapshot),
            attempt: Mutex::new(None),
            cache: Mutex::new(VecDeque::new()),
            generation: AtomicU64::new(0),
            started: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            work: Arc::new(Semaphore::new(128)),
            tasks: Mutex::new(JoinSet::new()),
        });
        for (name, arguments, kind) in [
            (
                "cloud.expire-authorization",
                "cloudAuthorizationExpiry",
                Function::Expiry,
            ),
            (
                "cloud.refresh-session",
                "cloudSessionRefresh",
                Function::Refresh,
            ),
        ] {
            durable.register(Registration {
                name: name.into(),
                arguments_schema: arguments,
                result_schema: "ownerNull",
                function: Arc::new(Procedure {
                    module: Arc::downgrade(&module),
                    kind,
                }),
            })?;
        }
        Ok(module)
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        self.runtime
            .migrate("cloud", persistence::MIGRATIONS)
            .await?;
        let module = self.clone();
        self.runtime
            .transact(move |ctx| {
                let state = match persistence::read(ctx, &module.schemas)? {
                    Some(state) => state,
                    None => persistence::replace(
                        ctx,
                        &module.schemas,
                        &json!({"error":null,"pending":false,"session":null}),
                    )?,
                };
                if !state["session"].is_null() {
                    module.schedule(ctx)?;
                }
                let snapshot = project(&state, None);
                let owner = module.clone();
                ctx.after_commit(move || {
                    *owner
                        .snapshot
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot;
                    owner.started.store(true, Ordering::Release);
                })?;
                Ok(())
            })
            .await
    }
    pub fn status(&self) -> Value {
        self.snapshot
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
    fn error(&self, status: u16, code: &'static str, message: impl Into<String>) -> anyhow::Error {
        CloudOperationError {
            status,
            code,
            message: message.into(),
            cloud: self.status(),
        }
        .into()
    }
    fn unavailable(&self, message: &str) -> anyhow::Error {
        self.error(503, "cloud_unavailable", message)
    }
    fn not_authenticated(&self) -> anyhow::Error {
        let snapshot = self.status();
        let message = if snapshot["error"]["code"] == "credentials_rejected" {
            "Cloud authorization has expired. Sign in to Cloud again on this Happy Agent."
        } else if snapshot["status"] == "authorizing" {
            "Cloud sign-in is in progress. Complete sign-in on this Happy Agent."
        } else {
            "Cloud is not authenticated on this Happy Agent. Sign in to Cloud to continue."
        };
        self.error(409, "cloud_not_authenticated", message)
    }
    fn running(&self) -> Result<()> {
        ensure!(
            self.started.load(Ordering::Acquire),
            "Cloud authentication has not started."
        );
        ensure!(
            !self.closed.load(Ordering::Acquire) && !self.lifecycle.is_draining(),
            "Cloud authentication is stopping."
        );
        Ok(())
    }
    fn launch(
        self: &Arc<Self>,
        work: impl FnOnce(Arc<Self>) -> BoxFuture<'static, Result<Value>> + Send + 'static,
    ) -> Result<oneshot::Receiver<Result<Value>>> {
        self.running()?;
        let permit = self
            .work
            .clone()
            .try_acquire_owned()
            .map_err(|_| self.unavailable("Cloud authentication is busy."))?;
        let (sender, receiver) = oneshot::channel();
        let module = self.clone();
        {
            let mut tasks = self
                .tasks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            while tasks.try_join_next().is_some() {}
            self.running()?;
            tasks.spawn(async move {
                let _permit = permit;
                let result = work(module).await;
                let _ = sender.send(result);
            });
        }
        Ok(receiver)
    }
    async fn workflow(
        self: &Arc<Self>,
        work: impl FnOnce(Arc<Self>) -> BoxFuture<'static, Result<Value>> + Send + 'static,
    ) -> Result<Value> {
        self.launch(work)?
            .await
            .map_err(|_| self.unavailable("Cloud authentication is temporarily unavailable."))?
    }
    pub async fn start(self: &Arc<Self>, request: &Value) -> Result<Value> {
        ensure!(
            self.schemas.valid("cloudStartRequest", request)?,
            "The Cloud authorization request is invalid."
        );
        let request = request.clone();
        self.workflow(move |module| {
            Box::pin(async move {
                let _lock = module.credentials.lock().await;
                module.running()?;
                if module.status()["status"] == "connected" {
                    return Err(module.error(409, "conflict", "Disconnect Cloud before connecting another account."));
                }
                let redirect = validation::redirect(request["redirectUri"].as_str().expect("validated redirect"))
                    .ok_or_else(|| module.error(400, "invalid_request", "The Cloud redirect URI is invalid."))?;
                let environment = request["environment"].as_str().expect("validated environment").to_owned();
                let previous = module.attempt.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
                if let Some(attempt) = previous {
                    if !attempt.consumed && now() >= attempt.expires {
                        module.expire_attempt(&attempt).await?;
                    } else if !attempt.consumed && attempt.environment == environment && attempt.redirect == redirect {
                        return Ok(module.status());
                    }
                }
                module.read().await?;
                let secret = Boundary::new(&module.config, &environment)?.authorization(&redirect)
                    .map_err(|_| module.unavailable("Cloud authorization is temporarily unavailable."))?;
                let mut attempt = Attempt {
                    environment, expires: now() + 600_000,
                    verifier: secret["codeVerifier"].as_str().expect("validated verifier").to_owned(),
                    state: secret["state"].as_str().expect("validated state").to_owned(), redirect,
                    url: secret["url"].as_str().expect("validated URL").to_owned(), version: String::new(), consumed: false,
                };
                let owner = module.clone();
                let mutation = request.get("mutationId").cloned();
                module.runtime.transact(move |ctx| {
                    owner.durable.cancel(ctx, EXPIRY_OPERATION)?;
                    let stored = persistence::replace(ctx, &owner.schemas, &json!({"error":null,"pending":true,"session":null}))?;
                    attempt.version = stored["version"].as_str().expect("validated version").to_owned();
                    let arguments = json!({"expiresAt":attempt.expires,"version":attempt.version});
                    let snapshot = project(&stored, Some(&attempt));
                    // Activate the verifier before an after-commit dispatcher can
                    // observe the pending record and interpret it as restored.
                    owner.activate(ctx, snapshot.clone(), Some(attempt), true, mutation)?;
                    owner.durable.invoke(ctx, &json!({"function":"cloud.expire-authorization","arguments":arguments,"operationId":EXPIRY_OPERATION}))?;
                    Ok(snapshot)
                }).await
            })
        }).await
    }
    pub async fn complete(self: &Arc<Self>, request: &Value) -> Result<Value> {
        ensure!(
            self.schemas.valid("cloudCompleteRequest", request)?,
            "The Cloud authorization callback is invalid."
        );
        let request = request.clone();
        self.workflow(move |module| {
            Box::pin(async move {
                let _lock = module.credentials.lock().await;
                module.running()?;
                let attempt = module.attempt.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
                    .filter(|attempt| !attempt.consumed)
                    .ok_or_else(|| module.error(400, "invalid_request", "There is no Cloud authorization waiting for this callback."))?;
                if now() >= attempt.expires {
                    module.expire_attempt(&attempt).await?;
                    return Err(module.error(400, "invalid_request", "The Cloud authorization has expired."));
                }
                let callback = validation::callback(request["callbackUrl"].as_str().expect("validated callback"), &attempt.redirect, &attempt.state)
                    .ok_or_else(|| module.error(400, "invalid_request", "The Cloud authorization callback is invalid."))?;
                module.read().await?;
                {
                    let mut current = module.attempt.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
                    if let Some(current) = current.as_mut().filter(|current| current.version == attempt.version && !current.consumed) {
                        current.consumed = true;
                    } else {
                        return Err(module.error(400, "invalid_request", "There is no Cloud authorization waiting for this callback."));
                    }
                }
                let mutation = request.get("mutationId").cloned();
                if let validation::Callback::Error(error) = callback {
                    let rejected = error == "access_denied";
                    module.settle(&attempt, json!({"error":if rejected {json!({"code":"authorization_rejected","message":"Cloud authorization was not approved."})} else {Value::Null},"pending":false,"session":null}), mutation).await?;
                    return Err(module.error(if rejected {409} else {503}, if rejected {"cloud_unauthorized"} else {"cloud_unavailable"}, if rejected {"Cloud authorization was not approved."} else {"Cloud authorization is temporarily unavailable."}));
                }
                let validation::Callback::Code(code) = callback else { unreachable!() };
                let authentication = async {
                    let boundary = Boundary::new(&module.config, &attempt.environment).map_err(|_| RemoteError::Unavailable)?;
                    let authentication = boundary.exchange(&code, &attempt.verifier).await?;
                    boundary.verify(authentication["accessToken"].as_str().expect("validated token"), authentication["user"]["id"].as_str().expect("validated identity")).await?;
                    Ok::<_, RemoteError>(authentication)
                }.await;
                match authentication {
                    Ok(authentication) => module.settle(&attempt, json!({"error":null,"pending":false,"session":{"environment":attempt.environment,"refreshToken":authentication["refreshToken"],"user":authentication["user"]}}), mutation).await,
                    Err(error) => {
                        let rejected = matches!(error, RemoteError::CredentialsRejected | RemoteError::IdentityMismatch);
                        module.settle(&attempt, json!({"error":if rejected {json!({"code":"authorization_rejected","message":"Cloud rejected the authorization."})} else {Value::Null},"pending":false,"session":null}), mutation).await?;
                        Err(module.error(if rejected {409} else {503}, if rejected {"cloud_unauthorized"} else {"cloud_unavailable"}, if rejected {"Cloud rejected the authorization."} else {"Cloud authorization could not be verified."}))
                    }
                }
            })
        }).await
    }
    /// Local sign-out composes with the caller's transaction. Version/token
    /// fences prevent an already-dispatched exchange from reviving this session.
    pub fn disconnect(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        mutation: Option<&Value>,
    ) -> Result<Value> {
        self.runtime.assert_context(ctx)?;
        self.running()?;
        let current = persistence::read(ctx, &self.schemas)?;
        if let Some(current) = current.filter(|current| {
            current["session"].is_null()
                && current["pending"] == false
                && current["error"].is_null()
        }) {
            return Ok(project(&current, None));
        }
        self.replace(
            ctx,
            &json!({"error":null,"pending":false,"session":null}),
            true,
            mutation.cloned(),
        )
    }
    pub async fn mint(self: &Arc<Self>) -> Result<Value> {
        self.mint_with_mutation(None).await
    }
    pub async fn mint_with_mutation(self: &Arc<Self>, mutation: Option<Value>) -> Result<Value> {
        self.workflow(move |module| {
            Box::pin(async move {
                let _lock = module.credentials.lock().await;
                module.running()?;
                let (authentication, cloud) =
                    module.mint_in_lock_with_mutation(None, mutation).await?;
                Ok(json!({"accessToken":authentication["accessToken"],"cloud":cloud}))
            })
        })
        .await
    }
    async fn mint_in_lock(self: &Arc<Self>, organization: Option<&str>) -> Result<(Value, Value)> {
        self.mint_in_lock_with_mutation(organization, None).await
    }
    async fn mint_in_lock_with_mutation(
        self: &Arc<Self>,
        organization: Option<&str>,
        mutation: Option<Value>,
    ) -> Result<(Value, Value)> {
        let stored = self.read().await?.ok_or_else(|| self.not_authenticated())?;
        let session = &stored["session"];
        if session.is_null() || self.status()["status"] != "connected" {
            return Err(self.not_authenticated());
        }
        let boundary = Boundary::new(
            &self.config,
            session["environment"]
                .as_str()
                .expect("validated deployment"),
        )?;
        let authentication = match boundary
            .refresh(
                session["refreshToken"]
                    .as_str()
                    .expect("validated refresh token"),
                organization,
            )
            .await
        {
            Ok(value) => value,
            Err(RemoteError::CredentialsRejected) => {
                let module = self.clone();
                let expected = session["refreshToken"].clone();
                self.runtime.transact(move |ctx| {
                    if persistence::read(ctx, &module.schemas)?.is_some_and(|current| current["session"]["refreshToken"] == expected) {
                        module.replace(ctx, &json!({"error":{"code":"credentials_rejected","message":"Cloud authorization has expired."},"pending":false,"session":null}), false, mutation)?;
                    }
                    Ok(())
                }).await?;
                return Err(self.error(
                    409,
                    "cloud_unauthorized",
                    "Cloud authorization has expired.",
                ));
            }
            Err(_) => {
                return Err(self.unavailable("Cloud authentication is temporarily unavailable."));
            }
        };
        let expected = session["refreshToken"]
            .as_str()
            .expect("validated refresh token")
            .to_owned();
        let replacement = authentication["refreshToken"]
            .as_str()
            .expect("validated replacement")
            .to_owned();
        let module = self.clone();
        self.runtime
            .transact(move |ctx| persistence::rotate(ctx, &module.schemas, &expected, &replacement))
            .await
            .map_err(|_| {
                if self.status()["status"] != "connected" {
                    self.not_authenticated()
                } else {
                    self.unavailable("Cloud credentials could not be saved.")
                }
            })?;
        if authentication["user"]["id"] != session["user"]["id"] {
            return Err(self.unavailable("Cloud returned an unexpected account."));
        }
        boundary
            .verify(
                authentication["accessToken"]
                    .as_str()
                    .expect("validated token"),
                session["user"]["id"].as_str().expect("validated user"),
            )
            .await
            .map_err(|_| self.unavailable("Cloud could not verify the access token."))?;
        if authentication["user"] != session["user"] {
            let module = self.clone();
            let authentication = authentication.clone();
            let environment = session["environment"].clone();
            let expected = authentication["refreshToken"].clone();
            self.runtime.transact(move |ctx| {
                let current = persistence::read(ctx, &module.schemas)?.context("The Cloud session changed while its token was refreshing.")?;
                ensure!(current["session"]["refreshToken"] == expected, "The Cloud session changed while its token was refreshing.");
                let value = json!({"error":null,"pending":false,"session":{"environment":environment,"refreshToken":authentication["refreshToken"],"user":authentication["user"]}});
                module.replace(ctx, &value, false, mutation).map(|_| ())
            }).await?;
        }
        if self.status()["status"] != "connected" {
            return Err(self.not_authenticated());
        }
        Ok((authentication, self.status()))
    }
    async fn read(self: &Arc<Self>) -> Result<Option<Value>> {
        let module = self.clone();
        self.runtime
            .transact(move |ctx| persistence::read(ctx, &module.schemas))
            .await
    }
    fn schedule(&self, ctx: &Context<'_>) -> Result<()> {
        self.durable.invoke(ctx,&json!({"function":"cloud.refresh-session","operationId":REFRESH_OPERATION,"arguments":{"refreshAt":now()+HOUR}}))?;
        Ok(())
    }
    fn replace(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        value: &Value,
        cancel_expiry: bool,
        mutation: Option<Value>,
    ) -> Result<Value> {
        if cancel_expiry {
            self.durable.cancel(ctx, EXPIRY_OPERATION)?;
        }
        let stored = persistence::replace(ctx, &self.schemas, value)?;
        if stored["session"].is_null() {
            self.durable.cancel(ctx, REFRESH_OPERATION)?;
        } else {
            self.schedule(ctx)?;
        }
        let snapshot = project(&stored, None);
        self.activate(ctx, snapshot.clone(), None, true, mutation)?;
        Ok(snapshot)
    }
    fn activate(
        self: &Arc<Self>,
        ctx: &Context<'_>,
        snapshot: Value,
        attempt: Option<Attempt>,
        publish: bool,
        mutation: Option<Value>,
    ) -> Result<()> {
        ensure!(
            self.schemas.valid("cloudSnapshot", &snapshot)?,
            "The Cloud snapshot is invalid."
        );
        let activated = snapshot.clone();
        let module = self.clone();
        ctx.after_commit(move || {
            let previous = module.status();
            if activated["status"] != "connected"
                || previous["status"] != "connected"
                || activated["environment"] != previous["environment"]
                || activated["user"]["id"] != previous["user"]["id"]
            {
                module.invalidate_cache();
            }
            *module
                .attempt
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = attempt;
            *module
                .snapshot
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = activated;
        })?;
        if publish {
            let mut payload = json!({"cloud":snapshot});
            if let Some(mutation) = mutation {
                payload["mutationId"] = mutation;
            }
            self.events.record(ctx, None, "cloud.updated", payload)?;
        }
        Ok(())
    }
    fn invalidate_cache(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
    }
    async fn settle(
        self: &Arc<Self>,
        attempt: &Attempt,
        value: Value,
        mutation: Option<Value>,
    ) -> Result<Value> {
        let module = self.clone();
        let version = attempt.version.clone();
        self.runtime
            .transact(move |ctx| {
                let current = persistence::read(ctx, &module.schemas)?;
                if !current.is_some_and(|current| {
                    current["pending"] == true && current["version"] == version
                }) {
                    return Err(module.error(
                        400,
                        "invalid_request",
                        "The Cloud authorization changed while completing.",
                    ));
                }
                module.replace(ctx, &value, true, mutation)
            })
            .await
    }
    async fn expire_attempt(self: &Arc<Self>, attempt: &Attempt) -> Result<Value> {
        self.settle(attempt,json!({"error":{"code":"authorization_expired","message":"Cloud authorization expired."},"pending":false,"session":null}),None).await
    }
    pub async fn close(self: &Arc<Self>) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        self.work.close();
        self.invalidate_cache();
        let mut tasks = std::mem::take(
            &mut *self
                .tasks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        );
        while tasks.join_next().await.is_some() {}
        *self
            .attempt
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        Ok(())
    }
}
fn project(stored: &Value, attempt: Option<&Attempt>) -> Value {
    let mut cloud = json!({"authorization":null,"environment":null,"error":stored["error"],"status":"disconnected","updatedAt":stored["updatedAt"],"user":null,"version":stored["version"]});
    if stored["pending"] == true {
        if let Some(attempt) = attempt {
            cloud["authorization"] = json!({"expiresAt":attempt.expires,"url":attempt.url});
            cloud["environment"] = json!(attempt.environment);
            cloud["status"] = json!("authorizing");
        } else {
            cloud["error"] =
                json!({"code":"authorization_expired","message":"Cloud authorization expired."});
        }
    } else if !stored["session"].is_null() {
        cloud["environment"] = stored["session"]["environment"].clone();
        cloud["user"] = stored["session"]["user"].clone();
        cloud["status"] = json!("connected");
    }
    cloud
}
