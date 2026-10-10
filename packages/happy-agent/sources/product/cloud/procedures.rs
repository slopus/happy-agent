//! Durable deadlines own recovery; HTTP attempts are never replayed by the scheduler.
use super::*;

async fn wait(deadline: u64, cancel: &CancellationToken) -> Result<()> {
    tokio::select! {biased;_=cancel.cancelled()=>anyhow::bail!("The durable function was stopped."),_=tokio::time::sleep(Duration::from_millis(deadline.saturating_sub(now())))=>Ok(())}
}
impl DurableFunction for Procedure {
    fn execute(
        self: Arc<Self>,
        call: Value,
        kv: CallKv,
        cancel: CancellationToken,
    ) -> BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let module = self
                .module
                .upgrade()
                .context("Cloud authentication is no longer available.")?;
            match self.kind {
                Function::Expiry => {
                    let input = &call["arguments"];
                    ensure!(
                        module.schemas.valid("cloudAuthorizationExpiry", input)?,
                        "The Cloud authorization deadline is invalid."
                    );
                    let version = input["version"]
                        .as_str()
                        .expect("validated version")
                        .to_owned();
                    let deadline = input["expiresAt"].as_u64().expect("validated deadline");
                    if module
                        .attempt
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .as_ref()
                        .is_some_and(|attempt| attempt.version == version)
                    {
                        while now() < deadline {
                            wait(deadline, &cancel).await?;
                        }
                    }
                    loop {
                        ensure!(!cancel.is_cancelled(), "The durable function was stopped.");
                        let result = async {
                            let _lock = tokio::select! {
                                biased;
                                _ = cancel.cancelled() => anyhow::bail!("The durable function was stopped."),
                                lock = module.credentials.lock() => lock,
                            };
                            let owner = module.clone();
                            let version = version.clone();
                            module.runtime.transact(move |ctx| {
                                if persistence::read(ctx, &owner.schemas)?.is_some_and(|stored| stored["pending"] == true && stored["version"] == version) {
                                    owner.replace(ctx, &json!({"error":{"code":"authorization_expired","message":"Cloud authorization expired."},"pending":false,"session":null}), false, None)?;
                                }
                                Ok(())
                            }).await
                        }.await;
                        if result.is_ok() {
                            break;
                        }
                        wait(now() + 5_000, &cancel).await?;
                    }
                }
                Function::Refresh => {
                    ensure!(
                        module
                            .schemas
                            .valid("cloudSessionRefresh", &call["arguments"])?,
                        "The Cloud session refresh deadline is invalid."
                    );
                    let initial = call["arguments"].clone();
                    loop {
                        ensure!(!cancel.is_cancelled(), "The durable function was stopped.");
                        if module.closed.load(Ordering::Acquire) || module.lifecycle.is_draining() {
                            wait(now() + HOUR, &cancel).await?;
                            continue;
                        }
                        let initial = initial.clone();
                        let schedule = kv
                            .transact(move |ctx, kv| match kv.read(ctx, "schedule")? {
                                Some(value) => Ok(value),
                                None => {
                                    kv.write(ctx, "schedule", &initial)?;
                                    Ok(initial)
                                }
                            })
                            .await;
                        let schedule = match schedule {
                            Ok(value) if module.schemas.valid("cloudSessionRefresh", &value)? => {
                                value
                            }
                            _ => {
                                wait(now() + 5_000, &cancel).await?;
                                continue;
                            }
                        };
                        let deadline = schedule["refreshAt"].as_u64().expect("validated deadline");
                        if now() < deadline {
                            wait(deadline, &cancel).await?;
                            continue;
                        }
                        let kv = kv.clone();
                        let signal = cancel.clone();
                        let result = module
                            .workflow(move |owner| {
                                Box::pin(async move {
                                    let _lock = owner.credentials.lock().await;
                                    ensure!(
                                        !signal.is_cancelled(),
                                        "The durable function was stopped."
                                    );
                                    owner.running()?;
                                    if owner.status()["status"] != "connected" {
                                        return Ok(json!(false));
                                    }
                                    kv.transact(|ctx, kv| {
                                        kv.write(ctx, "schedule", &json!({"refreshAt":now()+HOUR}))
                                    })
                                    .await?;
                                    ensure!(
                                        !signal.is_cancelled(),
                                        "The durable function was stopped."
                                    );
                                    let _ = owner.mint_in_lock(None).await;
                                    Ok(json!(owner.status()["status"] == "connected"))
                                })
                            })
                            .await;
                        if matches!(result, Ok(Value::Bool(false)))
                            && !module.closed.load(Ordering::Acquire)
                        {
                            break;
                        }
                        if result.is_err() {
                            wait(now() + 5_000, &cancel).await?;
                        }
                    }
                }
            }
            Ok(Value::Null)
        })
    }
}
