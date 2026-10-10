//! Docker owns container creation, the execution carrier and durable cleanup.
mod engine;
mod framing;
mod persistence;
#[cfg(all(test, target_os = "linux"))]
mod tests;
mod worker;
use super::config::{ConfigModule, DockerConfiguration};
use super::{
    durable::{CallKv, DurableFunction, DurableFunctionsModule, Registration},
    lifecycle::LifecycleModule,
    owners::{EmbeddedRunner, RunnerCompute, RunnerTransport, RunnersModule},
    runtime::RuntimeModule,
};
use anyhow::{Context as _, Result, ensure};
use futures_util::future::BoxFuture;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

pub(super) use worker::run as run_worker;
pub struct DockerModule {
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    lifecycle: Arc<LifecycleModule>,
    runners: Arc<RunnersModule>,
    computes: Mutex<BTreeMap<String, Arc<Environment>>>,
    containers: tokio::sync::Mutex<BTreeMap<String, Container>>,
    closed: AtomicBool,
}
struct Environment {
    request: Value,
    state: Mutex<State>,
    changed: tokio::sync::Notify,
    done: tokio::sync::Notify,
    ended: AtomicBool,
}
enum State {
    Starting,
    Ready(Arc<RunnerCompute>),
    Failed(String),
    Closing,
}
struct Container {
    id: String,
    request: Value,
    owners: usize,
}
struct Executor(Weak<DockerModule>);
struct Cleanup(Weak<DockerModule>);
impl DockerModule {
    pub fn new(
        config: Arc<ConfigModule>,
        runtime: Arc<RuntimeModule>,
        durable: Arc<DurableFunctionsModule>,
        lifecycle: Arc<LifecycleModule>,
        runners: Arc<RunnersModule>,
    ) -> Result<Arc<Self>> {
        let module = Arc::new(Self {
            config,
            runtime,
            durable: durable.clone(),
            lifecycle,
            runners,
            computes: Mutex::new(BTreeMap::new()),
            containers: tokio::sync::Mutex::new(BTreeMap::new()),
            closed: AtomicBool::new(false),
        });
        durable.register(Registration {
            name: "docker.environment".into(),
            arguments_schema: "dockerEnvironmentRequest",
            result_schema: "ownerNull",
            function: Arc::new(Executor(Arc::downgrade(&module))),
        })?;
        durable.register(Registration {
            name: "docker.cleanup".into(),
            arguments_schema: "dockerEnvironmentRecord",
            result_schema: "ownerNull",
            function: Arc::new(Cleanup(Arc::downgrade(&module))),
        })?;
        Ok(module)
    }
    pub async fn agent_compute(
        self: &Arc<Self>,
        agent: &str,
        configuration: &Value,
        cancel: &CancellationToken,
    ) -> Result<Arc<RunnerCompute>> {
        self.runners.assert_local_execution()?;
        let selected = self.config.docker_configuration(agent, configuration)?;
        self.compute(&selected.request, cancel).await
    }
    pub async fn load(self: &Arc<Self>) -> Result<()> {
        // A daemon restart cannot prove the former worker's process outcomes.
        // Recover its durable teardown before accepting another compute; never
        // replay the old shell or install a second worker beside it.
        let durable = self.durable.clone();
        let module = self.clone();
        self.runtime.transact(move|ctx| {
            for (id,mut record) in persistence::records(ctx)? {
                let environment=module.environment(&record["request"])?;
                environment.finish(Ok(()));
                record["closing"]=json!(true);persistence::put_record(ctx,&id,&record)?;
                durable.invoke(ctx,&json!({"function":"docker.cleanup","operationId":format!("docker-cleanup-{id}"),"arguments":record,"lockKeys":[format!("docker-{id}")]}))?;
                durable.cancel(ctx,&format!("docker-{id}"))?;
            }
            Ok(())
        }).await
    }
    pub async fn compute(
        self: &Arc<Self>,
        request: &Value,
        cancel: &CancellationToken,
    ) -> Result<Arc<RunnerCompute>> {
        ensure!(
            !self.closed.load(Ordering::Acquire),
            "The Docker compute owner is closed."
        );
        let selected = self.config.docker_runner_configuration(request)?;
        let id = selected.request["computeId"].as_str().unwrap().to_owned();
        let failed = self
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&id)
            .is_some_and(|environment| {
                environment.ended.load(Ordering::Acquire)
                    && matches!(
                        *environment
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner),
                        State::Failed(_)
                    )
            });
        if failed {
            self.dispose(&id).await?;
        }
        let identity = id.clone();
        let record = self
            .runtime
            .transact(move |ctx| persistence::query_record(ctx, &identity))
            .await?;
        if record.is_none() {
            let mut computes = self
                .computes
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if computes
                .get(&id)
                .is_some_and(|environment| environment.ended.load(Ordering::Acquire))
            {
                computes.remove(&id);
            }
        }
        let environment = self.environment(&selected.request)?;
        let module = self.clone();
        let input = selected.request;
        let operation = format!("docker-{id}");
        self.runtime.transact(move|ctx| {
            if let Some(record)=persistence::query_record(ctx,&id)? {ensure!(record["closing"]==false,"The Docker environment still has a pending cleanup intent.");}
            else {persistence::put_record(ctx,&id,&json!({"request":input,"closing":false}))?;}
            module.durable.invoke(ctx,&json!({"function":"docker.environment","operationId":operation,"arguments":input,"lockKeys":[format!("docker-{id}")]}))?;
            Ok(())
        }).await?;
        loop {
            let changed = environment.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            match &*environment
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
            {
                State::Ready(compute) => return Ok(compute.clone()),
                State::Failed(error) => anyhow::bail!("{error}"),
                State::Closing => anyhow::bail!("The Docker compute is closing."),
                State::Starting => {}
            }
            tokio::select! {_=changed=>{},_=cancel.cancelled()=>anyhow::bail!("Docker compute initialization was interrupted."),_=self.lifecycle.shutdown.cancelled()=>anyhow::bail!("The Docker compute owner is shutting down.")}
        }
    }
    fn environment(&self, request: &Value) -> Result<Arc<Environment>> {
        let id = request["computeId"]
            .as_str()
            .context("The Docker compute identity is missing.")?;
        let mut computes = self
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(environment) = computes.get(id) {
            ensure!(
                environment.request == *request,
                "The Docker compute configuration changed while its environment remains owned."
            );
            return Ok(environment.clone());
        }
        ensure!(
            computes.len() < 512,
            "The bounded Docker compute catalog is full."
        );
        let environment = Arc::new(Environment {
            request: request.clone(),
            state: Mutex::new(State::Starting),
            changed: tokio::sync::Notify::new(),
            done: tokio::sync::Notify::new(),
            ended: AtomicBool::new(false),
        });
        computes.insert(id.into(), environment.clone());
        Ok(environment)
    }
    pub async fn dispose_agent(&self, agent: &str) -> Result<()> {
        self.dispose(&format!("agent-{agent}")).await
    }
    pub async fn dispose(&self, id: &str) -> Result<()> {
        let environment = self
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .cloned();
        let environment = if let Some(environment) = environment {
            environment
        } else {
            let identity = id.to_owned();
            let record = self
                .runtime
                .transact(move |ctx| persistence::query_record(ctx, &identity))
                .await?;
            let Some(record) = record else { return Ok(()) };
            let environment = self.environment(&record["request"])?;
            environment.finish(Ok(()));
            environment
        };
        let durable = self.durable.clone();
        let operation = format!("docker-{id}");
        let identity = id.to_owned();
        let request = environment.request.clone();
        self.runtime.transact(move|ctx| {
            let mut record=persistence::query_record(ctx,&identity)?.unwrap_or(json!({"request":request,"closing":true}));record["closing"]=json!(true);
            persistence::put_record(ctx,&identity,&record)?;
            durable.invoke(ctx,&json!({"function":"docker.cleanup","operationId":format!("docker-cleanup-{identity}"),"arguments":record,"lockKeys":[operation]}))?;
            durable.cancel(ctx,&format!("docker-{identity}"))?;
            Ok(())
        }).await?;
        tokio::time::timeout(std::time::Duration::from_secs(45), async {
            loop {
                let done = environment.done.notified();
                tokio::pin!(done);
                done.as_mut().enable();
                if environment.ended.load(Ordering::Acquire) {
                    break;
                }
                done.await;
            }
        })
        .await
        .context("Docker compute cleanup has not been confirmed.")?;
        let identity = id.to_owned();
        tokio::time::timeout(std::time::Duration::from_secs(45),async {
            loop {
                let id=identity.clone();
                if self.runtime.transact(move|ctx|persistence::query_record(ctx,&id)).await?.is_none() {return Ok::<_,anyhow::Error>(())};
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }).await.context("The durable Docker teardown is still pending; container cleanup has not been confirmed.")??;
        self.computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(id);
        Ok(())
    }
    pub async fn close(&self) -> Result<()> {
        self.closed.store(true, Ordering::Release);
        let ids = self
            .computes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut first = None;
        for id in ids {
            if let Err(error) = self.dispose(&id).await {
                first.get_or_insert(error);
            }
        }
        first.map_or(Ok(()), Err)
    }
    async fn acquire(&self, selected: &DockerConfiguration) -> Result<(String, Option<String>)> {
        let docker = &selected.request["docker"];
        let engine = engine::Engine {
            socket: selected.socket.clone(),
        };
        if let Some(id) = docker["container"].as_str() {
            let details = engine
                .call(
                    "GET",
                    &format!("/containers/{}/json", engine::component(id)),
                    &Value::Null,
                )
                .await?;
            validate_mount(selected, &details)?;
            ensure!(
                details["State"]["Running"] == true,
                "The selected Docker container is not running."
            );
            let identity = details["Id"]
                .as_str()
                .context("The attached Docker container identity is missing.")?;
            return Ok((identity.into(), None));
        }
        let id = selected.request["computeId"].as_str().unwrap();
        let name = docker["name"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| format!("compute-{id}"));
        let key = format!("{}\0{name}", selected.socket.display());
        let mut containers = self.containers.lock().await;
        if let Some(container) = containers.get_mut(&key) {
            ensure!(
                container.request == *docker,
                "The shared Docker container has a different configuration."
            );
            container.owners += 1;
            return Ok((container.id.clone(), Some(key)));
        }
        let details = engine
            .call(
                "GET",
                &format!("/containers/{}/json", engine::component(&name)),
                &Value::Null,
            )
            .await;
        let container = match details {
            Ok(details) => {
                ensure!(
                    details["Config"]["Labels"]["dev.agent-compute.managed"] == "true"
                        && (docker["name"].is_string()
                            || details["Config"]["Labels"]["dev.agent-compute.session"] == id),
                    "The requested Docker container name belongs to another container."
                );
                validate_mount(selected, &details)?;
                let container = details["Id"]
                    .as_str()
                    .context("The Docker container identity is missing.")?
                    .to_owned();
                if details["State"]["Running"] != true {
                    engine
                        .call(
                            "POST",
                            &format!("/containers/{}/start", engine::component(&container)),
                            &Value::Null,
                        )
                        .await?;
                }
                container
            }
            Err(error) if error.downcast_ref::<engine::NotFound>().is_some() => {
                self.config.require_docker_fuse()?;
                let body = container_request(selected, id)?;
                let result = engine
                    .call(
                        "POST",
                        &format!("/containers/create?name={}", engine::component(&name)),
                        &body,
                    )
                    .await.context("The selected Docker engine must provision its /dev/fuse character device for the native workspace-write boundary.")?;
                let container = result["Id"]
                    .as_str()
                    .context("The Docker engine did not return a container identity.")?
                    .to_owned();
                if let Err(error) = engine
                    .call(
                        "POST",
                        &format!("/containers/{}/start", engine::component(&container)),
                        &Value::Null,
                    )
                    .await
                {
                    let cleanup = engine
                        .call(
                            "DELETE",
                            &format!("/containers/{}?force=true", engine::component(&container)),
                            &Value::Null,
                        )
                        .await;
                    cleanup.context(
                        "Docker startup failed and container cleanup remains unconfirmed.",
                    )?;
                    return Err(error);
                }
                container
            }
            Err(error) => return Err(error),
        };
        containers.insert(
            key.clone(),
            Container {
                id: container.clone(),
                request: docker.clone(),
                owners: 1,
            },
        );
        Ok((container, Some(key)))
    }
    async fn release(&self, engine: &engine::Engine, key: &str) -> Result<()> {
        let mut containers = self.containers.lock().await;
        let Some(container) = containers.get_mut(key) else {
            return Ok(());
        };
        container.owners = container.owners.saturating_sub(1);
        if container.owners > 0 {
            return Ok(());
        };
        engine
            .call(
                "DELETE",
                &format!(
                    "/containers/{}?force=true",
                    engine::component(&container.id)
                ),
                &Value::Null,
            )
            .await?;
        containers.remove(key);
        Ok(())
    }
    async fn execute(self: &Arc<Self>, request: &Value, cancel: CancellationToken) -> Result<()> {
        let selected = self.config.docker_runner_configuration(request)?;
        let environment = self.environment(request)?;
        let engine = engine::Engine {
            socket: selected.socket.clone(),
        };
        let acquired = self.acquire(&selected).await;
        let (container, key) = match acquired {
            Ok(value) => value,
            Err(error) => {
                environment.finish(Err(format!("{error:#}")));
                return Err(error);
            }
        };
        let mut connection: Option<Arc<EmbeddedRunner>> = None;
        let mut compute: Option<Arc<RunnerCompute>> = None;
        let mut exec = None;
        let mut tasks = tokio::task::JoinSet::new();
        let stop = CancellationToken::new();
        let execution=async {
            let identity=request["computeId"].as_str().unwrap().to_owned();let stored_container=container.clone();
            self.runtime.transact(move|ctx| {if let Some(mut record)=persistence::query_record(ctx,&identity)? {record["container"]=json!(stored_container);persistence::put_record(ctx,&identity,&record)?;}Ok(())}).await?;
            let id=engine.create_worker(&container).await?;
            exec=Some(id.clone());
            let identity=request["computeId"].as_str().unwrap().to_owned();
            let stored_exec=id.clone();
            self.runtime.transact(move|ctx| {if let Some(mut record)=persistence::query_record(ctx,&identity)? {record["exec"]=json!(stored_exec);persistence::put_record(ctx,&identity,&record)?;}Ok(())}).await?;
            let stream=engine.attach(&id).await?;
            let (read,write)=tokio::io::split(stream);
            let (stdout_read,stdout_write)=tokio::io::duplex(128*1024);
            let (incoming,incoming_rx)=tokio::sync::mpsc::channel(4);
            let (outgoing,outgoing_rx)=tokio::sync::mpsc::channel(4);
            tasks.spawn(engine::stdout(read,stdout_write,stop.clone()));
            tasks.spawn(framing::read(stdout_read,incoming));
            tasks.spawn(framing::write(write,outgoing_rx));
            let opened=self.runners.embedded_transport(RunnerTransport {incoming:incoming_rx,outgoing}).await?;
            let mut params=request.clone();
            params.as_object_mut().unwrap().remove("docker");
            if let Some(policy)=request.get("policy").or_else(||request["docker"].get("hostPolicy")) {params["policy"]=policy.clone();}
            connection=Some(opened.clone());
            let ready=opened.compute(params,&cancel).await?;
            compute=Some(ready.clone());
            *environment.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner)=State::Ready(ready);
            environment.changed.notify_waiters();
            tokio::select! {_=cancel.cancelled()=>Ok(()),_=self.lifecycle.shutdown.cancelled()=>Ok(()),ended=tasks.join_next()=>{match ended{Some(Ok(Err(error)))=>Err(error),_=>anyhow::bail!("The Docker compute connection ended; command outcomes are unproven.")}}}
        }.await;
        *environment
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = State::Closing;
        environment.changed.notify_waiters();
        let mut cleanup = Ok(());
        if let Some(compute) = compute {
            cleanup = tokio::time::timeout(
                std::time::Duration::from_secs(15),
                compute.dispose(&CancellationToken::new()),
            )
            .await
            .context("The container compute release did not finish in time.")
            .and_then(|result| result);
        }
        if let Some(connection) = connection {
            if let Err(error) =
                tokio::time::timeout(std::time::Duration::from_secs(10), connection.close())
                    .await
                    .context("The private container connection did not close in time.")
                    .and_then(|result| result)
            {
                cleanup = Err(error);
            }
        }
        stop.cancel();
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
        if let Some(key) = key {
            // Removing a managed container is a positive teardown barrier for its
            // namespace and all worker/workload processes, including startup failure.
            let removed = self.release(&engine, &key).await;
            if removed.is_ok() {
                cleanup = Ok(())
            } else {
                cleanup = removed;
            }
        } else if let Some(exec) = exec {
            if let Err(error) = engine.wait_worker(&exec).await {
                cleanup = Err(error);
            }
        }
        let result = cleanup.and(execution);
        if result.is_ok() {
            let identity = request["computeId"].as_str().unwrap().to_owned();
            self.runtime
                .transact(move |ctx| persistence::delete_record(ctx, &identity))
                .await?;
        }
        environment.finish(
            result
                .as_ref()
                .map(|_| ())
                .map_err(|error| format!("{error:#}")),
        );
        result
    }
}
impl Environment {
    fn finish(&self, result: std::result::Result<(), String>) {
        *self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = match result {
            Ok(()) => State::Closing,
            Err(error) => State::Failed(error),
        };
        self.ended.store(true, Ordering::Release);
        self.changed.notify_waiters();
        self.done.notify_waiters();
    }
}
impl DurableFunction for Executor {
    fn execute(
        self: Arc<Self>,
        call: Value,
        _kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let module = self
                .0
                .upgrade()
                .context("The Docker compute owner is unavailable.")?;
            module.execute(&call["arguments"], cancel).await?;
            Ok(Value::Null)
        })
    }
}
impl DurableFunction for Cleanup {
    fn execute(
        self: Arc<Self>,
        call: Value,
        _kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let module = self
                .0
                .upgrade()
                .context("The Docker cleanup owner is unavailable.")?;
            let initial = &call["arguments"];
            let identity = initial["request"]["computeId"].as_str().unwrap().to_owned();
            loop {
                let id = identity.clone();
                let record = module
                    .runtime
                    .transact(move |ctx| persistence::query_record(ctx, &id))
                    .await?;
                let Some(record) = record else {
                    return Ok(Value::Null);
                };
                let selected = module
                    .config
                    .docker_runner_configuration(&record["request"])?;
                let engine = engine::Engine {
                    socket: selected.socket.clone(),
                };
                let result=async {
                    if selected.request["docker"]["container"].is_string() {
                        if let Some(exec)=record["exec"].as_str() {engine.wait_worker(exec).await?;}
                    } else {
                        let docker=&selected.request["docker"];
                        let name=docker["name"].as_str().map(str::to_owned).unwrap_or_else(||format!("compute-{identity}"));
                        let key=format!("{}\0{name}",selected.socket.display());
                        let containers=module.containers.lock().await;
                        if containers.get(&key).is_none_or(|container|container.owners==0) {
                            let target=record["container"].as_str().unwrap_or(&name);
                            match engine.call("GET",&format!("/containers/{}/json",engine::component(target)),&Value::Null).await {
                                Ok(details)=>{
                                    ensure!(details["Config"]["Labels"]["dev.agent-compute.managed"]=="true" && (docker["name"].is_string() || details["Config"]["Labels"]["dev.agent-compute.session"]==identity),"The Docker cleanup target belongs to another owner.");
                                    engine.call("DELETE",&format!("/containers/{}?force=true",engine::component(target)),&Value::Null).await?;
                                },
                                Err(error) if error.downcast_ref::<engine::NotFound>().is_some()=>{},
                                Err(error)=>return Err(error),
                            }
                        }
                    }
                    Ok::<_,anyhow::Error>(())
                }.await;
                if result.is_ok() {
                    return Ok(Value::Null);
                };
                // Only idempotent teardown is retried by its owning executor.
                // The original command or start request is never replayed.
                tokio::select! {_=cancel.cancelled()=>anyhow::bail!("Docker cleanup was stopped; its durable intent remains pending."),_=tokio::time::sleep(std::time::Duration::from_secs(1))=>{}}
            }
        })
    }
    fn success(
        &self,
        ctx: &crate::product::runtime::Context<'_>,
        call: &Value,
        _result: &Value,
    ) -> Result<()> {
        persistence::delete_record(
            ctx,
            call["arguments"]["request"]["computeId"].as_str().unwrap(),
        )
    }
}
fn validate_mount(selected: &DockerConfiguration, details: &Value) -> Result<()> {
    ensure!(
        details["Mounts"]
            .as_array()
            .is_some_and(|mounts| mounts.iter().any(|mount| mount["Destination"]
                == engine::EXECUTABLE
                && mount["Type"] == "bind"
                && mount["RW"] == false
                && mount["Source"].as_str() == selected.executable.to_str())),
        "Docker compute requires a read-only bind mount of this Linux executable at {}. Restart the selected container with that mount.",
        engine::EXECUTABLE
    );
    Ok(())
}
fn container_request(selected: &DockerConfiguration, id: &str) -> Result<Value> {
    let docker = &selected.request["docker"];
    let mut mounts = Vec::new();
    for mount in docker["mounts"].as_array().into_iter().flatten() {
        let target = mount["target"].as_str().unwrap();
        ensure!(
            target != "/"
                && !engine::EXECUTABLE.starts_with(&format!("{}/", target.trim_end_matches('/')))
                && target != engine::EXECUTABLE,
            "The Docker mount target overlaps the protected executable path."
        );
        mounts.push(json!({"Type":"bind","Source":mount["source"],"Target":target,"ReadOnly":mount["readOnly"].as_bool().unwrap_or(false)}));
    }
    mounts.push(json!({"Type":"bind","Source":selected.executable,"Target":engine::EXECUTABLE,"ReadOnly":true}));
    let environment = docker["environment"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(key, value)| format!("{key}={}", value.as_str().unwrap()))
        .collect::<Vec<_>>();
    let profile = docker["apparmorProfile"].as_str().unwrap_or("unconfined");
    // Source managed containers admit the inner supervisor's namespaces. The
    // supervisor applies each shell's actual filesystem and network boundary.
    // Attaching to an existing container never changes its outer host policy.
    let body = json!({"Image":docker["image"],"Entrypoint":["/bin/sh","-c"],"Cmd":["trap : TERM INT; while :; do sleep 2073600; done"],"Env":environment,"Labels":{"dev.agent-compute.managed":"true","dev.agent-compute.session":id},"OpenStdin":false,"Tty":false,"WorkingDir":docker["workingDirectory"],"HostConfig":{"Mounts":mounts,"SecurityOpt":["seccomp=unconfined",format!("apparmor={profile}")],"MaskedPaths":[],"ReadonlyPaths":[],"Devices":[{"PathOnHost":"/dev/fuse","PathInContainer":"/dev/fuse","CgroupPermissions":"rw"}]}});
    Ok(body)
}
