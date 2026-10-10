//! Exact-model account routing belongs to Config, which owns provider construction and lifetimes.
use anyhow::{Context as _, Result};
use async_trait::async_trait;
use happy_providers::{Compaction, ErrorKind, Event, HttpSession, Outcome, ProviderConfig, ProviderError, RunRequest, Session, SessionContext, ToolDefinition};
use serde_json::Value;
use std::{collections::{BTreeMap, BTreeSet}, sync::{Arc, Mutex, OnceLock}};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub(super) struct ModelRoute { pub model: Value, pub accounts: Vec<String>, pub region: Option<String> }
pub(super) struct SmartRoute { pub kind: String, pub models: Vec<ModelRoute> }
pub(super) struct RouteState { current: usize, failed: BTreeSet<usize>, terminal: Option<ProviderError> }
impl RouteState { pub fn new(count:usize)->Self {Self {current:random_index(count),failed:BTreeSet::new(),terminal:None}} }
pub(super) fn random_index(count:usize)->usize {if count<=1 {0} else {(rand::random::<u64>() % count as u64) as usize}}

pub(super) struct FrozenLifetime { signal:CancellationToken, watcher:tokio::task::AbortHandle }
impl FrozenLifetime {
    pub fn new(signals:Vec<CancellationToken>)->(CancellationToken,Arc<Self>) {
        let signal=CancellationToken::new();
        if signals.iter().any(CancellationToken::is_cancelled) {signal.cancel();}
        let output=signal.clone();
        let watcher=tokio::spawn(async move { futures_util::future::select_all(signals.into_iter().map(|signal| Box::pin(async move {signal.cancelled().await}))).await; output.cancel(); });
        (signal.clone(),Arc::new(Self {signal,watcher:watcher.abort_handle()}))
    }
}
impl Drop for FrozenLifetime {fn drop(&mut self){self.signal.cancel();self.watcher.abort();}}

#[derive(Clone)]
pub(super) struct Enablement {
    pub defaults:BTreeMap<String,bool>,
    pub overrides:Arc<Mutex<BTreeMap<String,bool>>>,
    pub signals:Arc<Mutex<BTreeMap<String,CancellationToken>>>,
    pub shutdown:CancellationToken,
}
impl Enablement {
    fn enabled(&self,id:&str)->bool {self.overrides.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(id).copied().or_else(||self.defaults.get(id).copied()).unwrap_or(false)}
    fn signal(&self,id:&str)->CancellationToken {self.signals.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(id).cloned().unwrap_or_else(||{let signal=CancellationToken::new();signal.cancel();signal})}
}
pub(super) struct BoundSession { pub inner:Box<dyn Session>, pub provider:String, pub enablement:Enablement }
#[async_trait]
impl Session for BoundSession {
    async fn run(&mut self,request:RunRequest,cancel:CancellationToken,events:mpsc::Sender<Event>) {
        let provider=self.enablement.signal(&self.provider);let run_cancel=cancel.child_token();
        if !self.enablement.enabled(&self.provider)||provider.is_cancelled()||self.enablement.shutdown.is_cancelled(){run_cancel.cancel();}
        let run=self.inner.run(request,run_cancel.clone(),events);tokio::pin!(run);
        tokio::select! { _=&mut run=>{},_=cancel.cancelled()=>{run_cancel.cancel();run.await;},_=provider.cancelled()=>{run_cancel.cancel();run.await;},_=self.enablement.shutdown.cancelled()=>{run_cancel.cancel();run.await;} }
    }
    async fn compact(&mut self,context:SessionContext,instructions:Option<String>,cancel:CancellationToken)->Compaction {
        let provider=self.enablement.signal(&self.provider);let compact_cancel=cancel.child_token();
        if !self.enablement.enabled(&self.provider)||provider.is_cancelled()||self.enablement.shutdown.is_cancelled(){compact_cancel.cancel();}
        let compact=self.inner.compact(context,instructions,compact_cancel.clone());tokio::pin!(compact);
        tokio::select! { result=&mut compact=>result,_=cancel.cancelled()=>{compact_cancel.cancel();compact.await},_=provider.cancelled()=>{compact_cancel.cancel();compact.await},_=self.enablement.shutdown.cancelled()=>{compact_cancel.cancel();compact.await} }
    }
    async fn destroy(&mut self){self.inner.destroy().await;}
}

pub(super) struct RoutedSession {
    agent:String,model:String,candidates:Vec<(String,ProviderConfig)>,tools:Vec<ToolDefinition>,
    state:Arc<Mutex<RouteState>>,enablement:Enablement,sessions:BTreeMap<usize,Box<dyn Session>>,destroyed:bool,
}
impl RoutedSession {
    pub fn new(agent:String,model:String,candidates:Vec<(String,ProviderConfig)>,tools:Vec<ToolDefinition>,state:Arc<Mutex<RouteState>>,enablement:Enablement)->Self {Self {agent,model,candidates,tools,state,enablement,sessions:BTreeMap::new(),destroyed:false}}
    fn available(&self)->Option<usize> {let state=self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);let count=self.candidates.len();(0..count).map(|offset|(state.current+offset)%count).find(|index| !state.failed.contains(index)&&self.enablement.enabled(&self.candidates[*index].0))}
    async fn session_at(&mut self,index:usize)->Result<&mut Box<dyn Session>> {
        if !self.sessions.contains_key(&index) {
            let (id,configuration)=self.candidates.get(index).context("The routed provider account is missing.")?;
            anyhow::ensure!(self.enablement.enabled(id),"The routed provider account is disabled.");
            let session=HttpSession::new(self.agent.clone(),configuration.clone(),self.tools.clone()).await?;
            self.sessions.insert(index,Box::new(BoundSession {inner:Box::new(session),provider:id.clone(),enablement:self.enablement.clone()}));
        }
        Ok(self.sessions.get_mut(&index).unwrap())
    }
    async fn fail(&mut self,index:usize,error:ProviderError)->bool {
        {self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).failed.insert(index);}
        if let Some(mut session)=self.sessions.remove(&index){session.destroy().await;}
        let count=self.candidates.len();
        let mut state=self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(next)=(1..=count).map(|offset|(index+offset)%count).find(|next| !state.failed.contains(next)&&self.enablement.enabled(&self.candidates[*next].0)) {state.current=next;true} else {state.terminal=Some(error);false}
    }
    fn terminal(&self)->Option<ProviderError>{self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).terminal.clone()}
}
enum Attempt { Complete, Failed(ProviderError) }
#[async_trait]
impl Session for RoutedSession {
    async fn run(&mut self,mut request:RunRequest,cancel:CancellationToken,events:mpsc::Sender<Event>) {
        if self.destroyed {let _=events.send(failed("The routed provider session is closed.")).await;return;}
        if let Some(error)=self.terminal(){let _=events.send(Event::Done {outcome:Outcome::Error {error}}).await;return;}
        request.model=Some(self.model.clone());
        for _ in 0..self.candidates.len() {
            let Some(index)=self.available() else {let _=events.send(failed("No compatible provider account is currently available.")).await;return;};
            self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current=index;
            let session=match self.session_at(index).await {Ok(session)=>session,Err(error)=>{let message=error.to_string();if let Some(failure)=failure_from_message(&message) {if self.fail(index,failure.clone()).await {continue;}let _=events.send(Event::Done {outcome:Outcome::Error {error:failure}}).await;} else {let _=events.send(failed(&message)).await;}return;}};
            let attempt={
                let (sender,mut receiver)=mpsc::channel(64);let run_cancel=cancel.child_token();
                let run=session.run(request.clone(),run_cancel.clone(),sender);tokio::pin!(run);
                let mut buffered=Vec::new();let mut bytes=0usize;let mut visible=false;let mut completed=false;
                let result=loop {
                    let event=tokio::select! {_=cancel.cancelled()=>{let _=events.send(Event::Done {outcome:Outcome::Cancelled}).await;break Attempt::Complete;},_=events.closed()=>break Attempt::Complete,_=&mut run,if !completed=>{completed=true;continue;},event=receiver.recv()=>event};
                    let Some(event)=event else {for event in buffered.drain(..){if !forward(&events,event,&cancel).await {break;}}break Attempt::Complete;};
                    if !visible {
                        bytes=bytes.saturating_add(serde_json::to_vec(&event).map_or(1024*1024+1,|bytes|bytes.len()));
                        if bytes>1024*1024 {let _=events.send(failed("The routed provider exceeded its startup event limit.")).await;break Attempt::Complete;}
                        let is_visible=visible_event(&event);let done=matches!(event,Event::Done {..});
                        if let Event::Done {outcome:Outcome::Error {error}}=&event {if matches!(error.kind,ErrorKind::Authentication|ErrorKind::OutOfTokens) {break Attempt::Failed(error.clone());}}
                        buffered.push(event);
                        if is_visible||done {visible=is_visible;for event in buffered.drain(..){if !forward(&events,event,&cancel).await {run_cancel.cancel();break;}}if done {break Attempt::Complete;}}
                    } else {let done=matches!(event,Event::Done {..});if !forward(&events,event,&cancel).await||done {break Attempt::Complete;}}
                };
                run_cancel.cancel();drop(receiver);if !completed {run.await;}result
            };
            match attempt {Attempt::Complete=>return,Attempt::Failed(error)=>{if !self.fail(index,error.clone()).await {let _=events.send(Event::Done {outcome:Outcome::Error {error}}).await;return;}}}
        }
        let _=events.send(Event::Done {outcome:Outcome::Error {error:self.terminal().unwrap_or_else(||ProviderError::new(ErrorKind::Unclassified,"No compatible provider account is available."))}}).await;
    }
    async fn compact(&mut self,context:SessionContext,instructions:Option<String>,cancel:CancellationToken)->Compaction {
        if self.destroyed {return Compaction::Failed {error:ProviderError::new(ErrorKind::Unclassified,"The routed provider session is closed.")};}
        if let Some(error)=self.terminal(){return Compaction::Failed {error};}
        for _ in 0..self.candidates.len() {
            let Some(index)=self.available() else {return Compaction::Failed {error:ProviderError::new(ErrorKind::Unclassified,"No compatible provider account is currently available.")};};
            self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner).current=index;
            let result=match self.session_at(index).await {Ok(session)=>session.compact(context.clone(),instructions.clone(),cancel.clone()).await,Err(error)=>Compaction::Failed {error:failure_from_message(&error.to_string()).unwrap_or_else(||ProviderError::new(ErrorKind::Unclassified,error.to_string()))}};
            if cancel.is_cancelled(){return Compaction::Cancelled {context};}
            if let Compaction::Failed {error}=&result {if let Some(failure)=failure_from_message(&error.message) {if self.fail(index,failure).await {continue;}}}return result;
        }
        Compaction::Failed {error:ProviderError::new(ErrorKind::Unclassified,"No compatible provider account is available.")}
    }
    async fn destroy(&mut self){if self.destroyed{return;}self.destroyed=true;for (_,mut session) in std::mem::take(&mut self.sessions){session.destroy().await;}}
}
fn visible_event(event:&Event)->bool {matches!(event,Event::TextDelta {..}|Event::ReasoningDelta {..}|Event::ToolCallStart {..}|Event::ToolCallDelta {..}|Event::ToolCallEnd {..}|Event::ToolCallResultStart {..}|Event::ToolCallResultDelta {..}|Event::ToolCallResultEnd {..})}
async fn forward(events:&mpsc::Sender<Event>,event:Event,cancel:&CancellationToken)->bool {tokio::select!{result=events.send(event)=>result.is_ok(),_=cancel.cancelled()=>false}}
fn failed(message:&str)->Event {Event::Done {outcome:Outcome::Error {error:ProviderError::new(ErrorKind::Unclassified,message)}}}
fn failure_from_message(message:&str)->Option<ProviderError> {
    static AUTH:OnceLock<regex_lite::Regex>=OnceLock::new();static TOKENS:OnceLock<regex_lite::Regex>=OnceLock::new();
    let kind=if AUTH.get_or_init(||regex_lite::Regex::new(r"(?i)auth(?:entication|orization)?|credential|forbidden|log(?:ged)?\s*out|signed\s*out|unauthorized").unwrap()).is_match(message) {ErrorKind::Authentication} else if TOKENS.get_or_init(||regex_lite::Regex::new(r"(?i)account.+tokens|billing|budget|credit|insufficient[_\s-]*quota|out of tokens|quota|usage limit").unwrap()).is_match(message) {ErrorKind::OutOfTokens} else {return None;};
    Some(ProviderError::new(kind,message))
}

#[cfg(test)]
mod tests;