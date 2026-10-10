use super::*;
use futures_util::{future::BoxFuture, future::join_all};
use monty_pool::{Pool, PoolConfig, ReplConfig, ResumeValue, TurnEvent};
use monty_types::{MontyObject, ResourceLimits};
use std::time::Duration;
use tokio::sync::mpsc;

pub(super) struct Execute {
    pub owner: Weak<WorkflowsModule>,
}
struct LiveGuard {
    owner: Arc<WorkflowsModule>,
    key: (String, String),
}
impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.owner
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&self.key);
        self.owner
            .changed
            .send_modify(|version| *version = version.wrapping_add(1));
    }
}
impl DurableFunction for Execute {
    fn execute(
        self: Arc<Self>,
        call: Value,
        _: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let owner = self
                .owner
                .upgrade()
                .context("The workflow owner was closed.")?;
            let agent = call["arguments"]["agentId"].as_str().unwrap().to_owned();
            let id = call["arguments"]["runId"].as_str().unwrap().to_owned();
            let module = owner.clone();
            let agent_owned = agent.clone();
            let id_owned = id.clone();
            let restored = call["arguments"]["resumeFromRunId"]
                .as_str()
                .map(str::to_owned);
            let Some((request, checkpoint, calls)) = owner
                .runtime
                .transact(move |ctx| {
                    let run = module.require(ctx, &agent_owned, &id_owned)?;
                    if run["status"] != "running" {
                        return Ok(None);
                    }
                    let request =
                        persistence::read_request(ctx, &module.schemas, &agent_owned, &id_owned)?
                            .context("The running workflow no longer has its script.")?;
                    let current = persistence::read_checkpoint(
                        ctx,
                        &module.schemas,
                        &agent_owned,
                        &id_owned,
                    )?;
                    let reuse = if current.is_some() {
                        Some(id_owned.as_str())
                    } else {
                        restored.as_deref().or(request["resumeFromRunId"].as_str())
                    };
                    let (checkpoint, calls) = if let Some(reuse) = reuse {
                        (
                            persistence::read_checkpoint(
                                ctx,
                                &module.schemas,
                                &agent_owned,
                                reuse,
                            )?,
                            persistence::read_calls(ctx, &module.schemas, &agent_owned, reuse)?,
                        )
                    } else {
                        (None, BTreeMap::new())
                    };
                    Ok(Some((request, checkpoint, calls)))
                })
                .await?
            else {
                return Ok(Value::Null);
            };
            let token = cancel.child_token();
            let key = (agent.clone(), id.clone());
            {
                let mut live = owner
                    .live
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                anyhow::ensure!(live.len() < 1024, "The active workflow bound was reached.");
                anyhow::ensure!(
                    !live.contains_key(&key),
                    "The workflow is already executing."
                );
                live.insert(key.clone(), token.clone());
            }
            let _guard = LiveGuard {
                owner: owner.clone(),
                key,
            };
            let (note_send, mut notes) = mpsc::channel::<(Option<String>, Option<String>)>(128);
            let note_owner = owner.clone();
            let note_agent = agent.clone();
            let note_id = id.clone();
            let note_cancel = CancellationToken::new();
            let note_stop = note_cancel.clone();
            let note_task = tokio::spawn(async move {
                loop {
                    tokio::select! {_=note_stop.cancelled()=>break,note=notes.recv()=>{let Some((log,phase))=note else{break;};note_owner.note(&note_agent,&note_id,log,phase).await;}}
                }
            });
            let state = Arc::new(Runner {
                owner: owner.clone(),
                agent: agent.clone(),
                id: id.clone(),
                next: AtomicU64::new(
                    checkpoint
                        .as_ref()
                        .map_or(0, |checkpoint| checkpoint.next_call_index),
                ),
                phase: Mutex::new(checkpoint.as_ref().map_or_else(
                    || "Workflow".to_owned(),
                    |checkpoint| checkpoint.phase.clone(),
                )),
                cached: if checkpoint.is_some() {
                    calls
                } else {
                    BTreeMap::new()
                },
                notes: note_send,
                cancel: token.clone(),
            });
            let output = state.run(&request, checkpoint).await;
            drop(state);
            if tokio::time::timeout(Duration::from_secs(2), note_task)
                .await
                .is_err()
            {
                note_cancel.cancel();
            }
            if token.is_cancelled() || owner.lifecycle.shutdown.is_cancelled() {
                anyhow::bail!("The workflow was stopped.");
            }
            owner.finish(&agent, &id, output).await?;
            Ok(Value::Null)
        })
    }
}
struct Runner {
    owner: Arc<WorkflowsModule>,
    agent: String,
    id: String,
    next: AtomicU64,
    phase: Mutex<String>,
    cached: BTreeMap<u64, Value>,
    notes: mpsc::Sender<(Option<String>, Option<String>)>,
    cancel: CancellationToken,
}
impl Runner {
    fn note(&self, text: String) {
        let text = format::slice(&text.replace("\r\n", "\n").replace('\r', "\n"), 4000);
        let _ = self.notes.try_send((Some(text), None));
    }
    fn reserve(&self, count: u64) -> Result<u64> {
        self.next
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |next| {
                next.checked_add(count).filter(|next| *next <= 1000)
            })
            .map_err(|_| anyhow::anyhow!("Workflows are limited to 1000 agent calls."))
    }
    fn options(&self, value: &Value) -> Result<Value> {
        anyhow::ensure!(
            self.owner
                .schemas
                .valid("ownerWorkflowAgentOptions", value)?,
            "Agent options must be a dictionary with a model and a supported effort."
        );
        let mut options = value.clone();
        options["model"] = json!(format::trim(options["model"].as_str().unwrap()));
        if let Some(provider) = options["provider"].as_str() {
            options["provider"] = json!(format::trim(provider));
        }
        Ok(values::normalize(options))
    }
    fn requests(&self, value: &Value, name: &str) -> Result<Vec<Value>> {
        let values = value
            .as_array()
            .with_context(|| format!("{name}() requires a list."))?;
        anyhow::ensure!(values.len() <= 4096, "{name}() accepts at most 4096 items.");
        values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                anyhow::ensure!(
                    self.owner
                        .schemas
                        .valid("ownerWorkflowAgentRequest", value)?,
                    "{name}() item {} must be a dictionary with prompt, model, and effort.",
                    index + 1
                );
                let mut request = value.clone();
                request["model"] = json!(format::trim(request["model"].as_str().unwrap()));
                request["prompt"] = json!(format::trim(request["prompt"].as_str().unwrap()));
                if let Some(provider) = request["provider"].as_str() {
                    request["provider"] = json!(format::trim(provider));
                }
                Ok(values::normalize(request))
            })
            .collect()
    }
    async fn agent(
        self: &Arc<Self>,
        prompt: Value,
        options: Value,
        reserved: Option<u64>,
    ) -> Result<Value> {
        anyhow::ensure!(!self.cancel.is_cancelled(), "The workflow was stopped.");
        let prompt = prompt
            .as_str()
            .filter(|prompt| !format::trim(prompt).is_empty())
            .context("agent() requires a non-empty prompt string.")?;
        let options = self.options(&options)?;
        let signature = values::normalize(json!({"options":options,"prompt":prompt})).to_string();
        let index = if let Some(index) = reserved {
            index
        } else {
            self.reserve(1)?
        };
        if let Some(cached) = self
            .cached
            .get(&index)
            .filter(|cached| cached["signature"] == signature)
        {
            let owner = self.owner.clone();
            let agent = self.agent.clone();
            let id = self.id.clone();
            let output = cached["output"].clone();
            let signature_owned = signature.clone();
            let output_owned = output.clone();
            owner
                .runtime
                .clone()
                .transact(move |ctx| {
                    persistence::remember_call(
                        ctx,
                        &agent,
                        &id,
                        index,
                        &signature_owned,
                        &output_owned,
                    )
                })
                .await?;
            let label = options["label"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    self.phase
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .clone()
                });
            self.note(format!("Reused {label} from the previous run."));
            return Ok(output);
        }
        let title = options["label"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                self.phase
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone()
            });
        let prompt = if let Some(schema) = options.get("schema") {
            format!(
                "{prompt}\n\nReturn only JSON matching this JSON Schema:\n{}",
                values::normalize(schema.clone())
            )
        } else {
            prompt.to_owned()
        };
        let mut request = json!({"title":title,"model":options["model"],"effort":options["effort"],"text":prompt});
        if let Some(provider) = options.get("provider") {
            request["provider"] = provider.clone();
        }
        if let Some(tier) = options.get("service_tier") {
            request["serviceTier"] = tier.clone();
        }
        let answer = self.start_agent(index, &signature, request).await?;
        let output = if let Some(schema) = options.get("schema") {
            values::structured(&self.owner.schemas, &answer, schema)?
        } else {
            json!(answer)
        };
        let agent = self.agent.clone();
        let id = self.id.clone();
        let signature = signature.clone();
        let value = output.clone();
        self.owner
            .runtime
            .transact(move |ctx| {
                persistence::remember_call(ctx, &agent, &id, index, &signature, &value)
            })
            .await?;
        Ok(output)
    }
    async fn start_agent(&self, index: u64, signature: &str, request: Value) -> Result<String> {
        let mut changed = self.owner.changed.subscribe();
        let owner = self.owner.clone();
        let agent = self.agent.clone();
        let id = self.id.clone();
        let signature_owned = signature.to_owned();
        let collaborator=self.owner.runtime.transact(move|ctx|{if let Some(call)=persistence::read_call(ctx,&owner.schemas,&agent,&id,index)?{anyhow::ensure!(call["signature"]==signature_owned,"The restored workflow agent call no longer matches its checkpoint.");return Ok(call["collaboratorId"].as_str().unwrap().to_owned());}anyhow::ensure!(owner.require(ctx,&agent,&id)?["status"]=="running","The workflow was stopped.");let collaborator=cuid2::create_id();persistence::write_call(ctx,&agent,&id,index,&collaborator,&signature_owned)?;if let Err(error)=owner.note_transactional(ctx,&agent,&id,None,None,true){tracing::warn!(%error,"Workflow progress could not be recorded.");}owner.collaboration.create_agent(ctx,&agent,&request,&collaborator,&json!({"reportToCreator":false,"metadata":{"workflow":{"runId":id,"callIndex":index}}}))?;Ok(collaborator)}).await?;
        loop {
            let owner = self.owner.clone();
            let agent = self.agent.clone();
            let id = self.id.clone();
            let collaborator = collaborator.clone();
            let signature = signature.to_owned();
            if let Some(output) = self
                .owner
                .runtime
                .transact(move |ctx| {
                    let call = persistence::read_call(ctx, &owner.schemas, &agent, &id, index)?
                        .context("The restored workflow agent call changed during recovery.")?;
                    anyhow::ensure!(
                        call["collaboratorId"] == collaborator && call["signature"] == signature,
                        "The restored workflow agent call changed during recovery."
                    );
                    if let Some(error) = call["error"].as_str() {
                        anyhow::bail!("{error}");
                    }
                    call.get("output").map(format::serialize).transpose()
                })
                .await?
            {
                return Ok(output);
            }
            tokio::select! {_=self.cancel.cancelled()=>anyhow::bail!("The workflow was stopped."),_=self.owner.lifecycle.shutdown.cancelled()=>anyhow::bail!("The workflow was stopped."),result=changed.changed()=>{result.context("The workflow owner was closed.")?;}}
        }
    }
    async fn external(
        self: &Arc<Self>,
        name: &str,
        arguments: Vec<MontyObject>,
        kwargs: Vec<(MontyObject, MontyObject)>,
    ) -> Result<Value> {
        let mut arguments = arguments
            .into_iter()
            .map(values::output)
            .collect::<Result<Vec<_>>>()?;
        arguments.push(values::output(MontyObject::dict(kwargs))?);
        let argument = |index: usize| arguments.get(index).cloned().unwrap_or(Value::Null);
        match name {
            "agent" => self.agent(argument(0), argument(1), None).await,
            "log" => {
                let message = argument(0);
                self.note(
                    message
                        .as_str()
                        .context("log() requires a string.")?
                        .to_owned(),
                );
                Ok(Value::Null)
            }
            "phase" => {
                let title = argument(0);
                let title = title
                    .as_str()
                    .filter(|title| !format::trim(title).is_empty())
                    .context("phase() requires a non-empty title.")?;
                let title = format::trim(title).to_owned();
                *self
                    .phase
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = title.clone();
                let _ = self.notes.try_send((None, Some(format::slice(&title, 96))));
                self.note(format!("Phase: {title}"));
                Ok(Value::Null)
            }
            "parallel" => {
                let requests = self.requests(&argument(0), "parallel")?;
                let first = self.reserve(requests.len() as u64)?;
                let output = join_all(requests.into_iter().enumerate().map(
                    |(offset, mut request)| {
                        let owner = self.clone();
                        async move {
                            let prompt = request.as_object_mut().unwrap().remove("prompt").unwrap();
                            let label = request["label"]
                                .as_str()
                                .unwrap_or("Workflow agent")
                                .to_owned();
                            match owner
                                .agent(prompt, request, Some(first + offset as u64))
                                .await
                            {
                                Ok(value) => value,
                                Err(error) => {
                                    owner.note(format!("{label} failed: {error}"));
                                    Value::Null
                                }
                            }
                        }
                    },
                ))
                .await;
                Ok(json!(output))
            }
            "pipeline" => {
                let items = argument(0);
                let items = items
                    .as_array()
                    .context("pipeline() requires a list of items.")?;
                let stages = self.requests(&argument(1), "pipeline")?;
                anyhow::ensure!(
                    items.len() <= 4096,
                    "pipeline() accepts at most 4096 items."
                );
                let first = self.reserve((items.len() * stages.len()) as u64)?;
                let total = items.len();
                let output=join_all(items.iter().cloned().enumerate().map(|(index,item)|{let owner=self.clone();let stages=stages.clone();async move{let run=async{let mut previous=item.clone();for(stage_index,mut stage)in stages.iter().cloned().enumerate(){let prompt=stage.as_object_mut().unwrap().remove("prompt").unwrap();let prompt=format!("{}\n\nOriginal item ({}/{}):\n{}\n\nPrevious stage result:\n{}",prompt.as_str().unwrap(),index+1,total,format::serialize(&item)?,format::serialize(&previous)?);previous=owner.agent(json!(prompt),stage,Some(first+(index*stages.len()+stage_index)as u64)).await?;}Ok::<Value,anyhow::Error>(previous)}.await;match run{Ok(value)=>value,Err(error)=>{owner.note(format!("Pipeline item {} failed: {error}",index+1));Value::Null}}}})).await;
                Ok(json!(output))
            }
            _ => anyhow::bail!("Workflow function '{name}' is unavailable."),
        }
    }
    async fn run(
        self: &Arc<Self>,
        request: &Value,
        checkpoint: Option<persistence::Checkpoint>,
    ) -> Result<Value> {
        let mut config = PoolConfig::subprocess(self.owner.config.workflow_worker_executable()?);
        config.min_processes = 1;
        config.max_processes = 1;
        config.request_timeout = Some(Duration::from_secs(31));
        config.duration_limit_grace = Some(Duration::from_millis(500));
        let pool = Pool::new(config).await?;
        let result = tokio::select! {_=self.cancel.cancelled()=>Err(anyhow::anyhow!("The workflow was stopped.")),_=self.owner.lifecycle.shutdown.cancelled()=>Err(anyhow::anyhow!("The workflow was stopped.")),output=self.drive(&pool,request,checkpoint)=>output};
        pool.close().await;
        result
    }
    async fn drive(
        self: &Arc<Self>,
        pool: &Pool,
        request: &Value,
        checkpoint: Option<persistence::Checkpoint>,
    ) -> Result<Value> {
        let owner = self.clone();
        let mut print = move |_: monty_types::PrintStream, text: &str| -> monty_pool::PrintFuture {
            let note = format::trim_end(text);
            if !note.is_empty() {
                owner.note(note.to_owned());
            }
            Box::pin(async {})
        };
        let mut session = pool
            .checkout(&ReplConfig {
                script_name: "workflow.py".to_owned(),
                limits: Some(ResourceLimits {
                    max_duration: Some(Duration::from_secs(30)),
                    max_memory: Some(32 * 1024 * 1024),
                    max_recursion_depth: 200,
                    ..Default::default()
                }),
                ..Default::default()
            })
            .await?;
        let mut progress = if let Some(checkpoint) = checkpoint {
            session
                .restore(checkpoint.snapshot, vec![], &mut print)
                .await?
                .0
                .context("The workflow reached an unsupported suspended state.")?
        } else {
            session
                .feed(
                    request["script"].as_str().unwrap(),
                    vec![(
                        "args".to_owned(),
                        values::input(request.get("args").unwrap_or(&Value::Null))?,
                    )],
                    vec![],
                    false,
                    &mut print,
                )
                .await?
        };
        loop {
            anyhow::ensure!(!self.cancel.is_cancelled(), "The workflow was stopped.");
            match progress {
                TurnEvent::Complete(output) => {
                    let output = values::output(output);
                    session.finish().await?;
                    return output;
                }
                TurnEvent::NameLookup { name } => {
                    let external = matches!(
                        name.as_str(),
                        "agent" | "parallel" | "pipeline" | "log" | "phase"
                    )
                    .then(|| MontyObject::Function {
                        name,
                        docstring: None,
                    });
                    progress = session.resume_name_lookup(external, &mut print).await?;
                }
                TurnEvent::FunctionCall {
                    function_name,
                    args,
                    kwargs,
                    ..
                } => {
                    anyhow::ensure!(
                        matches!(
                            function_name.as_str(),
                            "agent" | "parallel" | "pipeline" | "log" | "phase"
                        ),
                        "Workflow function '{function_name}' is unavailable."
                    );
                    let snapshot = session.dump().await?;
                    let owner = self.owner.clone();
                    let agent = self.agent.clone();
                    let id = self.id.clone();
                    let checkpoint = persistence::Checkpoint {
                        snapshot: snapshot.clone(),
                        next_call_index: self.next.load(Ordering::Acquire),
                        phase: self
                            .phase
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clone(),
                    };
                    self.owner
                        .runtime
                        .transact(move |ctx| {
                            persistence::write_checkpoint(
                                ctx,
                                &owner.schemas,
                                &agent,
                                &id,
                                &checkpoint,
                            )
                        })
                        .await?;
                    session.finish().await?;
                    let output = self.external(&function_name, args, kwargs).await?;
                    session = pool.checkout(&ReplConfig::default()).await?;
                    let restored = session.restore(snapshot, vec![], &mut print).await?.0;
                    anyhow::ensure!(
                        matches!(restored, Some(TurnEvent::FunctionCall { .. })),
                        "The workflow checkpoint did not restore its external call."
                    );
                    progress = session
                        .resume(ResumeValue::Return(values::input(&output)?), &mut print)
                        .await?;
                }
                TurnEvent::OsCall { function_name, .. } => {
                    anyhow::bail!("Workflow function '{function_name}' is unavailable.")
                }
                TurnEvent::ResolveFutures { .. } => {
                    anyhow::bail!("The workflow reached an unsupported suspended state.")
                }
            }
        }
    }
}
