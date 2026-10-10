//! The original revisioned desktop channel, independent of coding-agent tools.
use super::*;

fn session_key(target: &Value) -> String {
    json!([
        target["connectionId"],
        target["groupId"],
        target["sessionId"]
    ])
    .to_string()
}
fn prefix(value: &str, maximum: usize) -> String {
    let mut count = 0;
    value
        .chars()
        .take_while(|character| {
            count += character.len_utf16();
            count <= maximum
        })
        .collect()
}
impl LiveModule {
    pub async fn prepare_control(
        self: &Arc<Self>,
        owner: &str,
        id: &str,
        window: &str,
    ) -> Result<PreparedControl> {
        let module = self.clone();
        let owner = owner.to_owned();
        let id_owned = id.to_owned();
        let session = self
            .runtime
            .transact(move |ctx| module.get(ctx, &owner, &id_owned))
            .await?;
        let call = self.call(id).ok_or_else(|| {
            LiveError::new(
                409,
                "conflict",
                "This voice session cannot attach to that window or already has a controller.",
                None,
            )
        })?;
        let mut state = call
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        anyhow::ensure!(
            session["windowId"] == window
                && !terminal(&session)
                && matches!(state.control, ControlState::Unclaimed),
            LiveError::new(
                409,
                "conflict",
                "This voice session cannot attach to that window or already has a controller.",
                None
            )
        );
        state.control = ControlState::Claimed;
        drop(state);
        Ok(PreparedControl {
            owner: Arc::downgrade(self),
            call,
            window: window.to_owned(),
            consumed: false,
        })
    }
    pub(super) fn send(self: &Arc<Self>, call: &Arc<Call>, message: Value) -> Result<()> {
        let (sender, bytes) = {
            let state = call
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match &state.control {
                ControlState::Attached { sender, bytes } => (sender.clone(), bytes.clone()),
                _ => return Ok(()),
            }
        };
        anyhow::ensure!(
            self.schemas.valid("ownerLiveServerMessage", &message)?,
            "The voice control response is invalid."
        );
        let text = message.to_string();
        let size = text.len();
        anyhow::ensure!(
            size <= 256 * 1024,
            "The voice control response is too large."
        );
        bytes
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                current
                    .checked_add(size)
                    .filter(|bytes| *bytes <= 1024 * 1024)
            })
            .map_err(|_| anyhow::anyhow!("The desktop control connection could not keep up."))?;
        sender
            .try_send(QueuedFrame {
                frame: LiveControlFrame::Message(text),
                budget: FrameBudget { bytes, size },
            })
            .map_err(|_| anyhow::anyhow!("The desktop control connection could not keep up."))?;
        Ok(())
    }
    pub(super) async fn provider_event(
        self: &Arc<Self>,
        call: &Arc<Call>,
        event: Value,
    ) -> Result<()> {
        if terminal(&call.session()) {
            return Ok(());
        }
        anyhow::ensure!(
            self.schemas.valid("ownerLiveProviderEvent", &event)?,
            "The voice provider event is invalid."
        );
        match event["type"].as_str().unwrap() {
            "ready" => {
                if call.session()["status"] == "starting" {
                    self.change(call, json!({"status":"active"})).await?;
                }
            }
            "usage" => {
                self.change(
                    call,
                    json!({"usage":{"seconds":event["seconds"],"final":event["final"]}}),
                )
                .await?
            }
            "ended" => {
                let lost = call
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .controller_lost;
                let orderly = event["orderly"] == true;
                let error = if lost {
                    json!("The desktop controller disconnected.")
                } else if orderly {
                    Value::Null
                } else {
                    event
                        .get("error")
                        .filter(|value| !value.is_null())
                        .cloned()
                        .unwrap_or(json!("The voice connection ended unexpectedly."))
                };
                self.change(call,json!({"status":if orderly&&!lost{"closed"}else{"failed"},"error":error,"endedAt":super::super::identity::now()})).await?;
                let code = match event["code"].as_str() {
                    Some("forbidden") => "forbidden",
                    Some("unsupported") => "unsupported",
                    _ => "live_unavailable",
                };
                let status = if code == "forbidden" {
                    403
                } else if code == "unsupported" {
                    501
                } else {
                    503
                };
                call.allocation.send_if_modified(|allocation| {
                    if allocation.is_none() {
                        *allocation = Some(Err(LiveError::new(
                            status,
                            code,
                            event["error"]
                                .as_str()
                                .unwrap_or("Voice ended before startup completed."),
                            Some(call.session()),
                        )));
                        true
                    } else {
                        false
                    }
                });
                self.dispose(call);
            }
            "transcript" => {
                let mut fragment = json!({"type":"transcript","transcriptId":cuid2::create_id(),"role":event["role"],"text":event["text"]});
                if let Some(start) = event.get("startMs") {
                    fragment["startMs"] = start.clone();
                    fragment["endMs"] = event["endMs"].clone();
                }
                anyhow::ensure!(
                    self.schemas.valid("ownerLiveServerMessage", &fragment)?,
                    "The voice transcript exceeded its protocol limits."
                );
                {
                    let mut state = call
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    state.fragments.push_back(fragment.clone());
                    while state.fragments.len() > 32
                        || serde_json::to_vec(&state.fragments)?.len() > 65536
                    {
                        state.fragments.pop_front();
                    }
                }
                self.send(call, fragment)?;
            }
            "delegation" => {
                let delegation = event["delegationId"].as_str().unwrap().to_owned();
                let snapshot = {
                    let mut state = call
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    anyhow::ensure!(
                        state.session["status"] == "active"
                            && matches!(state.control, ControlState::Attached { .. }),
                        "Voice requested an action before the desktop was ready."
                    );
                    if state.delegations.contains(&delegation) {
                        return Ok(());
                    }
                    anyhow::ensure!(
                        state.delegations.len() < 256,
                        "Voice exceeded its bounded delegation capacity."
                    );
                    state.delegations.insert(delegation.clone());
                    if matches!(state.controller, ControllerState::Running) {
                        None
                    } else {
                        state.controller = ControllerState::Running;
                        Some((
                            state.context.clone(),
                            state.fragments.iter().cloned().collect::<Vec<_>>(),
                            state.updates.values().cloned().collect::<Vec<_>>(),
                        ))
                    }
                };
                if let Some((context, fragments, updates)) = snapshot {
                    let module = self.clone();
                    let call = call.clone();
                    let route = call.route.clone();
                    let text = event["text"].as_str().map(str::to_owned);
                    let cancel = call.controller_abort.clone();
                    tokio::spawn(async move {
                        let outcome = controller::run(
                            module.clone(),
                            call.clone(),
                            route,
                            context,
                            fragments,
                            updates,
                            text,
                            cancel,
                        )
                        .await
                        .map_err(|error| {
                            error
                                .downcast_ref::<controller::Failure>()
                                .copied()
                                .unwrap_or(controller::Failure::Inference)
                        });
                        module.enqueue(
                            &call,
                            Command::ControllerComplete {
                                delegation,
                                outcome,
                            },
                            0,
                        );
                    });
                } else if let Some(transport) = call.transport() {
                    let _=transport.append(json!({"delegationId":delegation,"text":"The desktop controller is busy with the previous request. Ask again when it finishes.","speakable":call.credential_kind==LiveCredentialKind::CodexSubscription})).await;
                }
            }
            _ => unreachable!("The captured provider event union is closed."),
        }
        Ok(())
    }
    pub(super) async fn controller_complete(
        self: &Arc<Self>,
        call: &Arc<Call>,
        delegation: &str,
        outcome: std::result::Result<String, controller::Failure>,
    ) -> Result<()> {
        call.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .controller = ControllerState::Idle;
        if call.session()["status"] != "active" {
            return Ok(());
        }
        let text = match outcome {
            Ok(text) => {
                if text.is_empty() {
                    "The desktop request has completed.".to_owned()
                } else {
                    text
                }
            }
            Err(error) => {
                if call.route.signal.is_cancelled() {
                    return self
                        .fail(
                            call,
                            "The configured desktop controller account is no longer available.",
                            None,
                        )
                        .await;
                }
                self.expire_actions(call);
                tracing::warn!(session_id=%call.id,delegation_id=delegation,category=error.category(),actions=call.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).actions.len(),"The live controller request failed.");
                if matches!(error, controller::Failure::Capacity) {
                    return self.fail(call, error.message(), None).await;
                }
                error.voice_context()
            }
        };
        let Some(transport) = call.transport() else {
            return self.fail(call,"Voice could not deliver the desktop controller's response. Its outcome was not retried.",None).await;
        };
        if transport
            .append(json!({"delegationId":delegation,"text":text,"speakable":true}))
            .await
            .is_err()
        {
            self.fail(call,"Voice could not deliver the desktop controller's response. Its outcome was not retried.",None).await?;
        }
        Ok(())
    }
    pub(super) fn cancel_actions(&self, call: &Arc<Call>) {
        let mut state = call
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for pending in state.actions.values_mut() {
            if pending.result.is_none()
                && let Some(reply) = pending.reply.take()
            {
                let _=reply.send(Ok(json!({"status":"cancelled","code":"ended","message":"Voice has ended; already-started actions may still complete."})));
            }
        }
    }
    fn expire_actions(&self, call: &Arc<Call>) {
        let mut state = call
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        for pending in state.actions.values_mut() {
            if pending.result.is_none() {
                pending.expired = true;
                if let Some(reply) = pending.reply.take() {
                    let _=reply.send(Ok(json!({"status":"failed","code":"failed","message":"The controller request ended before the action's outcome was confirmed."})));
                }
            }
        }
    }
    pub(super) async fn action(
        self: &Arc<Self>,
        call: &Arc<Call>,
        action: Value,
        transcripts: Vec<String>,
    ) -> Result<Value> {
        anyhow::ensure!(
            self.schemas.valid("ownerLiveDesktopAction", &action)?,
            controller::Failure::InvalidAction
        );
        let id = cuid2::create_id();
        let (reply, answer) = oneshot::channel();
        let revision;
        {
            let mut state = call
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            anyhow::ensure!(
                !terminal(&state.session)
                    && state.session["status"] == "active"
                    && matches!(state.control, ControlState::Attached { .. }),
                "Voice cannot start another desktop action."
            );
            anyhow::ensure!(state.actions.len() < 256, controller::Failure::Capacity);
            if action["type"] == "sessionWatch"
                && action["enabled"] == true
                && !state.watched.contains(&session_key(&action["target"]))
                && state.watched.len() >= 5
            {
                return Ok(
                    json!({"status":"refused","code":"unavailable","message":"At most five conversations can be watched."}),
                );
            }
            revision = state.session["contextRevision"].clone();
            state.actions.insert(
                id.clone(),
                ActionState {
                    action: action.clone(),
                    result: None,
                    expired: false,
                    reply: Some(reply),
                },
            );
        }
        self.send(call,json!({"type":"actionRequested","actionId":id,"contextRevision":revision,"inputTranscriptIds":transcripts,"action":action}))?;
        match tokio::time::timeout(Duration::from_secs(60), answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(controller::Failure::UncertainAction.into()),
            Err(_) => {
                if let Some(pending) = call
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .actions
                    .get_mut(&id)
                {
                    pending.expired = true;
                    pending.reply.take();
                }
                Err(controller::Failure::UncertainAction.into())
            }
        }
    }
    pub(super) async fn desktop_message(
        self: &Arc<Self>,
        call: &Arc<Call>,
        text: &str,
    ) -> Result<()> {
        if terminal(&call.session()) {
            return Ok(());
        }
        anyhow::ensure!(
            text.len() <= 256 * 1024,
            "The desktop control message exceeded its size limit."
        );
        let message: Value = serde_json::from_str(text)?;
        anyhow::ensure!(
            self.schemas.valid("ownerLiveClientMessage", &message)?,
            "The desktop control message was invalid."
        );
        match message["type"].as_str().unwrap() {
            "desktopContext" => {
                let changed = {
                    let mut state = call
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    anyhow::ensure!(
                        message["context"]["windowId"] == state.session["windowId"],
                        "The desktop context belongs to a different window."
                    );
                    let revision = message["revision"].as_u64().unwrap();
                    let previous = state.session["contextRevision"].as_u64().unwrap();
                    if revision < previous {
                        return Ok(());
                    }
                    if revision == previous {
                        anyhow::ensure!(
                            message["context"] == state.context,
                            "Conflicting desktop contexts used the same revision."
                        );
                        return Ok(());
                    }
                    state.context = message["context"].clone();
                    let selected = (!state.context["activeSession"].is_null())
                        .then(|| session_key(&state.context["activeSession"]["target"]));
                    let watched = state.watched.clone();
                    state
                        .updates
                        .retain(|key, _| selected.as_deref() == Some(key) || watched.contains(key));
                    true
                };
                if changed {
                    self.change(call, json!({"contextRevision":message["revision"]}))
                        .await?;
                }
            }
            "actionResult" => {
                let mut state = call
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let id = message["actionId"].as_str().unwrap();
                let (action, result) = {
                    let pending = state
                        .actions
                        .get_mut(id)
                        .context("The desktop answered an unknown action.")?;
                    if pending.expired {
                        return Ok(());
                    }
                    if let Some(result) = &pending.result {
                        anyhow::ensure!(
                            result == &message["result"],
                            "The desktop changed a completed action result."
                        );
                        return Ok(());
                    }
                    let result = &message["result"];
                    if result["status"] == "pending" {
                        anyhow::ensure!(
                            pending.action["type"] != "sessionSend",
                            "Message staging cannot wait for human confirmation as a pending action."
                        );
                        return Ok(());
                    }
                    if result["status"] == "succeeded" {
                        anyhow::ensure!(
                            (result["output"]["type"] == "staged")
                                == (pending.action["type"] == "sessionSend"),
                            "The desktop returned an invalid staging result."
                        );
                    }
                    (pending.action.clone(), result.clone())
                };
                if result["status"] == "succeeded" && action["type"] == "sessionWatch" {
                    let key = session_key(&action["target"]);
                    if action["enabled"] == true {
                        state.watched.insert(key);
                    } else {
                        state.watched.remove(&key);
                        if state.context["activeSession"].is_null()
                            || session_key(&state.context["activeSession"]["target"]) != key
                        {
                            state.updates.remove(&key);
                        }
                    }
                }
                let pending = state.actions.get_mut(id).unwrap();
                pending.result = Some(result.clone());
                if let Some(reply) = pending.reply.take() {
                    let _ = reply.send(Ok(result));
                }
            }
            "sessionUpdate" => {
                let append = {
                    let mut state = call
                        .state
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let key = session_key(&message["target"]);
                    let active = (!state.context["activeSession"].is_null())
                        .then(|| session_key(&state.context["activeSession"]["target"]));
                    anyhow::ensure!(
                        active.as_deref() == Some(key.as_str()) || state.watched.contains(&key),
                        "The desktop updated an unselected conversation."
                    );
                    let accessible = state.context["sessions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| session_key(&item["target"]) == key)
                        || state.context["bots"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|item| session_key(&item["target"]) == key)
                        || active.as_deref() == Some(key.as_str());
                    anyhow::ensure!(
                        accessible,
                        "The desktop updated an inaccessible conversation."
                    );
                    let previous = state.updates.get(&key);
                    if previous == Some(&message) {
                        return Ok(());
                    }
                    let prior = previous
                        .and_then(|message| message["status"].as_str())
                        .or_else(|| {
                            (active.as_deref() == Some(key.as_str()))
                                .then(|| state.context["activeSession"]["status"].as_str())
                                .flatten()
                        })
                        .map(str::to_owned);
                    let status = message["status"].as_str().unwrap();
                    let speakable = Some(status) != prior.as_deref()
                        && (matches!(status, "error" | "awaitingInput")
                            || (status == "idle"
                                && prior
                                    .as_deref()
                                    .is_some_and(|prior| matches!(prior, "running" | "waiting"))));
                    state.updates.insert(key.clone(), message.clone());
                    anyhow::ensure!(
                        state.updates.len() <= 6
                            && serde_json::to_vec(&state.updates.values().collect::<Vec<_>>())?
                                .len()
                                <= 128 * 1024,
                        "Voice exceeded its selected conversation context limit."
                    );
                    if Some(status) == prior.as_deref() {
                        return Ok(());
                    }
                    let title = state.context["sessions"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|item| session_key(&item["target"]) == key)
                        .and_then(|item| item["title"].as_str())
                        .or_else(|| {
                            state.context["bots"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .find(|item| session_key(&item["target"]) == key)
                                .and_then(|item| item["name"].as_str())
                        });
                    let assistant = message["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .rev()
                        .find(|item| item["role"] == "assistant")
                        .and_then(|item| item["text"].as_str());
                    json!({"delegationId":null,"speakable":speakable,"text":json!({"title":title.map(|title|prefix(title,256)).unwrap_or_else(||"Selected conversation".to_owned()),"status":status,"lastAssistantMessage":assistant.map(|text|prefix(text,1600))}).to_string()})
                };
                if let Some(transport) = call.transport() {
                    let _ = transport.append(append).await;
                }
            }
            _ => unreachable!("The captured desktop message union is closed."),
        }
        Ok(())
    }
}
impl PreparedControl {
    pub fn failed(mut self) {
        self.consumed = true;
        if let Some(owner) = self.owner.upgrade() {
            owner.fail_async(
                self.call.clone(),
                "The desktop controller connection could not be established.".to_owned(),
            );
        }
    }
    pub fn attach(mut self) -> Result<LiveControl> {
        self.consumed = true;
        let owner = self
            .owner
            .upgrade()
            .context("The voice module was closed.")?;
        let (sender, receiver) = mpsc::channel(64);
        let bytes = Arc::new(AtomicUsize::new(0));
        let session = self.call.session();
        if terminal(&session) {
            let _ = sender.try_send(QueuedFrame {
                frame: LiveControlFrame::Close {
                    code: 1008,
                    reason: "Voice has ended.".to_owned(),
                },
                budget: FrameBudget {
                    bytes: bytes.clone(),
                    size: 0,
                },
            });
        } else {
            {
                let mut state = self
                    .call
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                anyhow::ensure!(
                    matches!(state.control, ControlState::Claimed),
                    "The desktop controller has already attached."
                );
                state.control = ControlState::Attached { sender, bytes };
            }
            self.call.attached.cancel();
            owner.send(&self.call,json!({"type":"hello","sessionId":self.call.id,"windowId":self.window,"contextRevision":session["contextRevision"]}))?;
            owner.send(
                &self.call,
                json!({"type":"status","status":session["status"],"error":session["error"]}),
            )?;
            let fragments = self
                .call
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .fragments
                .iter()
                .cloned()
                .collect::<Vec<_>>();
            for fragment in fragments {
                owner.send(&self.call, fragment)?;
            }
        }
        Ok(LiveControl {
            owner: self.owner.clone(),
            call: self.call.clone(),
            receiver,
            closed: terminal(&session),
        })
    }
}
impl Drop for PreparedControl {
    fn drop(&mut self) {
        if !self.consumed
            && let Some(owner) = self.owner.upgrade()
        {
            owner.fail_async(
                self.call.clone(),
                "The desktop controller connection could not be established.".to_owned(),
            );
        }
    }
}
impl LiveControl {
    pub fn cancellation(&self) -> CancellationToken {
        self.call.abort.clone()
    }
    pub fn message(&self, text: &str) -> Result<()> {
        let owner = self
            .owner
            .upgrade()
            .context("The voice module was closed.")?;
        owner.enqueue(
            &self.call,
            Command::Desktop(text.to_owned()),
            text.encode_utf16().count().saturating_mul(3),
        );
        Ok(())
    }
    pub async fn recv(&mut self) -> Option<LiveControlFrame> {
        let message = self.receiver.recv().await?;
        drop(message.budget);
        Some(message.frame)
    }
    pub fn closed(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        if let Some(owner) = self.owner.upgrade() {
            let session = self.call.session();
            if !terminal(&session) && session["status"] != "closing" {
                self.call
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .control = ControlState::Closed;
                owner.enqueue(&self.call, Command::ConnectionLost, 0);
            }
        }
    }
}
impl Drop for LiveControl {
    fn drop(&mut self) {
        self.closed();
    }
}
