use super::*;
impl UserInputModule {
    pub async fn wait(
        self: &Arc<Self>,
        agent: &str,
        id: &str,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        // One watch counter, no transcript cache or retained transaction. Subscribe before
        // the authoritative read so a settlement cannot disappear between registration and read.
        let mut changes = self.changes.subscribe();
        let mut presence_changes = self.presence.subscribe_user_input();
        let owner = self.clone();
        let acting = agent.to_owned();
        let request_id = id.to_owned();
        let (request, mut presence) = self
            .runtime
            .transact(move |ctx| {
                let request = owner.required(ctx, &acting, &request_id)?;
                let presence = owner.presence.user_input_state(ctx)?;
                if let Some(presence) = &presence {
                    validation::schema(
                        &owner.schemas,
                        "ownerUserInputPresence",
                        presence,
                        "user input presence state",
                    )?;
                }
                Ok((request, presence))
            })
            .await?;
        if request["status"] != "pending" {
            return Ok(request);
        }
        let created = request["createdAt"].as_u64().unwrap();
        let elapsed = || now().saturating_sub(created).min(validation::MAX_TIME);
        if let Some(deadline) = validation::deadline(&request).filter(|deadline| *deadline <= now())
        {
            let mut outcome =
                json!({"outcome":"timed_out","deadlineAt":deadline,"waitedMs":elapsed()});
            if let Some(presence) = presence {
                outcome["presence"] = presence;
            }
            return self.settle_wait(agent, id, outcome, false).await;
        }
        let (mut due, mut due_presence) = arm(&request, presence.as_ref());
        loop {
            if presence
                .as_ref()
                .is_some_and(|presence| presence["answerWaitMs"] == 0)
            {
                let outcome = json!({"outcome":"away","presence":presence,"waitedMs":elapsed()});
                return self.settle_wait(agent, id, outcome, false).await;
            }
            let owner = self.clone();
            let acting = agent.to_owned();
            let request_id = id.to_owned();
            let authoritative = self
                .runtime
                .transact(move |ctx| owner.required(ctx, &acting, &request_id))
                .await?;
            if authoritative["status"] != "pending" {
                return Ok(authoritative);
            }
            let timer = async {
                if let Some(due) = due {
                    tokio::time::sleep(Duration::from_millis(
                        due.saturating_sub(now()).min(2_147_483_647),
                    ))
                    .await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            tokio::select! {
                biased;
                _=cancel.cancelled()=>anyhow::bail!("The user input wait was interrupted."),
                changed=changes.changed()=>{anyhow::ensure!(changed.is_ok(),"The user input owner was closed.");changes.borrow_and_update();},
                changed=presence_changes.changed()=>{anyhow::ensure!(changed.is_ok(),"The presence owner was closed.");presence=presence_changes.borrow_and_update().clone();if let Some(presence)=&presence{validation::schema(&self.schemas,"ownerUserInputPresence",presence,"user input presence state")?;}(due,due_presence)=arm(&request,presence.as_ref());},
                _=timer=>{let deadline=due.unwrap();if now()<deadline{continue;}let mut outcome=json!({"outcome":"timed_out","deadlineAt":deadline,"waitedMs":elapsed()});if let Some(presence)=&due_presence{outcome["presence"]=presence.clone();}return self.settle_wait(agent,id,outcome,true).await;}
            }
        }
    }
    async fn settle_wait(
        self: &Arc<Self>,
        agent: &str,
        id: &str,
        outcome: Value,
        timer: bool,
    ) -> Result<Value> {
        let owner = self.clone();
        let acting = agent.to_owned();
        let id = id.to_owned();
        self.runtime
            .transact(move |ctx| {
                let request = owner.required(ctx, &acting, &id)?;
                if request["status"] != "pending" {
                    return Ok(request);
                }
                let request = owner.terminal(request, &outcome, timer)?;
                owner.persist(ctx, &acting, "user_input_completed", request)
            })
            .await
    }
}
fn arm(request: &Value, presence: Option<&Value>) -> (Option<u64>, Option<Value>) {
    let request_deadline = validation::deadline(request);
    let presence_deadline = presence
        .and_then(|presence| presence["answerWaitMs"].as_u64())
        .map(|wait| now().saturating_add(wait).min(validation::MAX_TIME));
    let due = match (request_deadline, presence_deadline) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (left, right) => left.or(right),
    };
    let due_presence = if presence_deadline
        .is_some_and(|deadline| request_deadline.is_none_or(|request| deadline <= request))
    {
        presence.cloned()
    } else {
        None
    };
    (due, due_presence)
}
