use super::*;
pub(super) struct Delivery {
    pub owner: Weak<SchedulingModule>,
}
impl DurableFunction for Delivery {
    fn execute(
        self: Arc<Self>,
        call: Value,
        _: CallKv,
        cancel: CancellationToken,
    ) -> futures_util::future::BoxFuture<'static, Result<Value>> {
        Box::pin(async move {
            let owner = self
                .owner
                .upgrade()
                .context("The scheduling owner was closed.")?;
            let id = call["arguments"]["scheduleId"].as_str().unwrap().to_owned();
            loop {
                let module = owner.clone();
                let schedule_id = id.clone();
                let Some(due) = owner
                    .runtime
                    .transact(move |ctx| {
                        persistence::read_schedule(ctx, &module.schemas, &schedule_id)
                    })
                    .await?
                else {
                    return Ok(Value::Null);
                };
                if due["status"] != "pending" {
                    return Ok(Value::Null);
                }
                let due_at = due["dueAt"].as_u64().unwrap();
                if now() < due_at {
                    tokio::select! {_=cancel.cancelled()=>anyhow::bail!("The scheduled delivery was interrupted."),_=tokio::time::sleep(Duration::from_millis(due_at.saturating_sub(now()).min(2_147_483_647)))=>{}}
                    continue;
                }
                let sender = due["senderAgentId"].as_str().unwrap();
                let target = due["targetAgentId"].as_str().unwrap();
                let introduction = if sender == target {
                    "A message you scheduled for now:".to_owned()
                } else {
                    format!("A message agent {sender} scheduled for now:")
                };
                let input = json!({"id":id,"message":{"role":"user","content":[{"type":"text","text":format!("{introduction}\n\n{}",due["message"].as_str().unwrap())}]},"metadata":{"scheduling":{"scheduleId":id,"senderAgentId":sender,"targetAgentId":target},"senderAgentId":sender},"options":{}});
                let module = owner.clone();
                let recipient = target.to_owned();
                let failure = owner
                    .runtime
                    .transact(move |ctx| module.agents.enqueue(ctx, &recipient, &input, false))
                    .await
                    .err()
                    .map(|error| {
                        let text = format!("{error:#}");
                        String::from_utf16_lossy(
                            &text.encode_utf16().take(2000).collect::<Vec<_>>(),
                        )
                    });
                if cancel.is_cancelled() {
                    anyhow::bail!("The scheduled delivery was interrupted.");
                }
                let module = owner.clone();
                let schedule_id = id.clone();
                let delivered = failure.is_none();
                owner
                    .runtime
                    .transact(move |ctx| {
                        let Some(mut before) =
                            persistence::read_schedule(ctx, &module.schemas, &schedule_id)?
                        else {
                            return Ok(());
                        };
                        if before["status"] != "pending" {
                            return Ok(());
                        }
                        let at = now().max(before["dueAt"].as_u64().unwrap());
                        before["updatedAt"] = json!(at);
                        if let Some(failure) = failure {
                            before["status"] = json!("undelivered");
                            before["failure"] = json!(if failure.is_empty() {
                                "The delivery failed.".to_owned()
                            } else {
                                failure
                            });
                        } else {
                            before["status"] = json!("delivered");
                            before["deliveredAt"] = json!(at);
                        }
                        persistence::write_schedule(ctx, &module.schemas, &before)?;
                        module.event(
                            ctx,
                            before["senderAgentId"].as_str().unwrap(),
                            "scheduled_message_delivery_outcome",
                            "schedule",
                            &before,
                            None,
                        )
                    })
                    .await?;
                if delivered {
                    owner.interrupt_waits(target)?;
                }
                return Ok(Value::Null);
            }
        })
    }
}
