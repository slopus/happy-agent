//! Source's synchronous public process events and bounded canonical count updates.
use super::*;
use crate::product::tools::ProcessSubscription;
use anyhow::{Context as _, Result};
use std::{collections::BTreeMap, sync::Mutex};
use tokio::{sync::Notify, task::JoinHandle};
use tokio_util::sync::CancellationToken;

const PENDING_OWNERS: usize = 128;
#[derive(Default)]
struct Pending {
    counts: BTreeMap<String, usize>,
    reconcile: bool,
}
pub(super) struct ProcessEvents {
    _subscription: ProcessSubscription,
    cancel: CancellationToken,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}
impl ApiModule {
    pub(super) fn start_process_events(self: &Arc<Self>) -> Result<()> {
        let pending = Arc::new(Mutex::new(Pending {
            reconcile: true,
            ..Pending::default()
        }));
        let notify = Arc::new(Notify::new());
        let cancel = self.lifecycle.shutdown.child_token();
        let weak = Arc::downgrade(self);
        let counts = pending.clone();
        let changed = notify.clone();
        let stopped = cancel.clone();
        let subscription = self.tools.on_process_event(Arc::new(move |event| {
            if stopped.is_cancelled() { return; }
            let Some(api) = weak.upgrade() else { return; };
            // The owner already checked the actual Source TypeBox event. Publish
            // synchronously, so process.exited precedes an abort's hard kill.
            let kind = match event["type"].as_str() {
                Some("process_started") => "process.started",
                Some("process_updated") => "process.updated",
                Some("process_exited") => "process.exited",
                _ => return,
            };
            let payload = if kind == "process.started" { json!({"process":event["process"]}) }
                else { json!({"processId":event["processId"],"previousVersion":event["previousVersion"],"version":event["version"],"changes":event["changes"]}) };
            if api.events.publish_ephemeral_process(kind, payload).is_err() { return; }
            let agent = event["agentId"].as_str().expect("validated process owner").to_owned();
            let count = event["runningProcesses"].as_u64().expect("validated process count") as usize;
            let mut pending = counts.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if pending.counts.len() < PENDING_OWNERS || pending.counts.contains_key(&agent) { pending.counts.insert(agent, count); }
            else { pending.reconcile = true; }
            drop(pending);
            changed.notify_one();
        }))?;
        let runtime = self.runtime.clone();
        let agents = self.agents.clone();
        let lifecycle = self.lifecycle.clone();
        let lifetime = cancel.clone();
        let task = tokio::spawn(async move {
            // This worker belongs to the API lifetime, never to a tool or request.
            while !lifecycle.is_ready() {
                tokio::select! { biased; _ = lifetime.cancelled() => return, _ = tokio::time::sleep(Duration::from_millis(20)) => {} }
            }
            notify.notify_one();
            loop {
                tokio::select! { biased; _ = lifetime.cancelled() => break, _ = notify.notified() => {} }
                let mut failures = 0;
                loop {
                    let batch = {
                        let mut pending = pending
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        if pending.counts.is_empty() && !pending.reconcile {
                            break;
                        }
                        std::mem::take(&mut *pending)
                    };
                    let module = agents.clone();
                    let update = runtime.transact(move |ctx| {
                        if batch.reconcile {
                            module.reconcile_process_counts(ctx)?;
                        } else {
                            for (agent, count) in batch.counts {
                                module.update_process_count(ctx, &agent, count)?;
                            }
                        }
                        Ok(())
                    });
                    let result = tokio::select! { biased; _ = lifetime.cancelled() => return, result = tokio::time::timeout(Duration::from_secs(3), update) => result };
                    if matches!(result, Ok(Ok(()))) {
                        failures = 0;
                        continue;
                    }
                    pending
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .reconcile = true;
                    failures += 1;
                    if failures >= 3 {
                        eprintln!(
                            "Agent process counts could not be reconciled; a later process event will retry."
                        );
                        break;
                    }
                    tokio::select! { biased; _ = lifetime.cancelled() => return, _ = tokio::time::sleep(Duration::from_millis(100)) => {} }
                }
            }
        });
        let observer = ProcessEvents {
            _subscription: subscription,
            cancel,
            task: tokio::sync::Mutex::new(Some(task)),
        };
        self.process_events
            .set(observer)
            .map_err(|_| anyhow::anyhow!("The API process observer has already been started."))
    }
    pub(super) async fn close_process_events(&self) {
        let Some(observer) = self.process_events.get() else {
            return;
        };
        observer.cancel.cancel();
        if let Some(mut task) = observer.task.lock().await.take() {
            if tokio::time::timeout(Duration::from_secs(2), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }
    pub(super) async fn process_route(
        self: &Arc<Self>,
        request: Request<Incoming>,
    ) -> Response<Body> {
        let path = request.uri().path().to_owned();
        static PATH: OnceLock<regex_lite::Regex> = OnceLock::new();
        let Some(captures) = PATH
            .get_or_init(|| {
                regex_lite::Regex::new(
                    r"^/v0/agents/([a-z][a-z0-9]*)/(activity|processes/([a-z][a-z0-9]*))$",
                )
                .unwrap()
            })
            .captures(&path)
        else {
            return error(
                404,
                "not_found",
                "The requested process endpoint does not exist.",
            );
        };
        let agent = captures[1].to_owned();
        if &captures[2] == "activity" && request.method() == hyper::Method::GET {
            return match self.agents.activity(agent).await {
                Ok(Some(activity)) => response(200, activity),
                Ok(None) => error(404, "not_found", "The agent was not found."),
                Err(failure) => internal(failure),
            };
        }
        if request.method() != hyper::Method::DELETE || captures.get(3).is_none() {
            return error(
                404,
                "not_found",
                "The requested process endpoint does not exist.",
            );
        }
        match self.agents.focused(agent.clone()).await {
            Ok(Some(_)) => {}
            Ok(None) => return error(404, "not_found", "The agent was not found."),
            Err(failure) => return internal(failure),
        }
        let process = captures
            .get(3)
            .context("The process identity is missing.")
            .map(|capture| capture.as_str().to_owned())
            .expect("matched process path");
        match self.tools.stop_process(&agent, &process).await {
            Ok(Some(process)) => response(200, json!({"process":process})),
            Ok(None) => error(404, "not_found", "The process was not found."),
            Err(failure) => internal(failure),
        }
    }
}
