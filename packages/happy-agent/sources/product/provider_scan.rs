//! Local discovery and explicit verification own the shared provider gate.
use super::{config::ConfigModule,durable::DurableFunctionsModule,identity::now,lifecycle::LifecycleModule,schemas::Schemas};
use anyhow::{Context as _,Result};
use futures_util::StreamExt;
use happy_providers::{Message,RunRequest,SessionContext,Event,Outcome,Effort};
use serde_json::{Value,json};
use std::{collections::{BTreeMap,BTreeSet},sync::{Arc,Mutex},time::Duration};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
mod tests;
pub struct ProviderScanModule {
    config:Arc<ConfigModule>,_durable:Arc<DurableFunctionsModule>,lifecycle:Arc<LifecycleModule>,schemas:Schemas,
    state:tokio::sync::Mutex<State>,running:Mutex<Option<watch::Receiver<Option<std::result::Result<Value,String>>>>>,
    verifications:Mutex<BTreeMap<String,BTreeMap<String,CancellationToken>>>,
}
#[derive(Default)]
struct State{loaded:bool,remembered:BTreeSet<String>}
impl ProviderScanModule {
    pub fn new(config:Arc<ConfigModule>,durable:Arc<DurableFunctionsModule>,lifecycle:Arc<LifecycleModule>)->Result<Arc<Self>> {
        Ok(Arc::new(Self{config,_durable:durable,lifecycle,schemas:Schemas::new()?,state:tokio::sync::Mutex::new(State::default()),running:Mutex::new(None),verifications:Mutex::new(BTreeMap::new())}))
    }
    async fn load(&self)->Result<()> {
        let mut state=self.state.lock().await;if state.loaded{return Ok(());}
        for provider in self.config.provider_ids(){if self.config.provider_auto_enable(&provider)==Some(true){state.remembered.insert(provider.clone());}self.config.set_provider_enabled(&provider,self.config.configured_provider_override(&provider).unwrap_or(false))?;}
        state.loaded=true;Ok(())
    }
    pub async fn open(self:&Arc<Self>)->Result<Value>{self.load().await?;self.scan().await}
    pub async fn scan(self:&Arc<Self>)->Result<Value> {
        self.load().await?;
        let mut receiver={let mut running=self.running.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(receiver)=running.as_ref().filter(|receiver|receiver.borrow().is_none()){receiver.clone()}else{
                let (sender,receiver)=watch::channel(None);*running=Some(receiver.clone());let owner=self.clone();
                tokio::spawn(async move{let outcome=owner.perform_scan().await.map_err(|error|error.to_string());sender.send_replace(Some(outcome));});receiver
            }};
        loop {if let Some(outcome)=receiver.borrow().clone(){return outcome.map_err(anyhow::Error::msg);}receiver.changed().await.context("The provider scan stopped before completing.")?;}
    }
    async fn probe(&self,provider:&str)->&'static str {
        tokio::select!{_ = self.lifecycle.shutdown.cancelled()=>"error",outcome=tokio::time::timeout(Duration::from_secs(10),self.config.probe_local_provider_credentials(provider))=>match outcome{Ok(Ok(true))=>"available",Ok(Ok(false))=>"missing",_=>"error"}}
    }
    async fn perform_scan(&self)->Result<Value> {
        let mut providers=self.config.provider_ids();providers.sort();
        let outcomes=futures_util::stream::iter(providers).map(|provider|async move{let status=self.probe(&provider).await;(provider,status)}).buffered(32).collect::<Vec<_>>().await;
        let mut state=self.state.lock().await;let mut updates=BTreeMap::new();
        for (provider,status) in &outcomes {if *status=="available"&&!state.remembered.contains(provider)&&self.config.provider_auto_enable(provider).is_none(){updates.insert(provider.clone(),json!({"autoEnable":true}));}}
        if !updates.is_empty(){self.config.update_runtime_provider_states(&updates).await?;state.remembered.extend(updates.keys().cloned());}
        let mut results=Vec::new();for (provider,credentials) in outcomes{self.apply_effective(&provider)?;let explicit=self.config.configured_provider_override(&provider);let remembered=state.remembered.contains(&provider);results.push(json!({"credentials":credentials,"enabled":self.config.provider_enabled(&provider),"enablement":if explicit.is_some()||self.config.provider_auto_enable(&provider)==Some(false){"explicit"}else if remembered{"scan"}else{"default"},"providerId":provider,"remembered":remembered}));}
        let result=json!({"completedAt":now(),"providers":results});anyhow::ensure!(self.schemas.valid("ownerProviderScanResponse",&result)?,"The provider scan result is invalid.");Ok(result)
    }
    fn assert_provider(&self,provider:&str)->Result<()> {anyhow::ensure!(self.config.provider_ids().iter().any(|id|id==provider),"Provider \"{provider}\" is not configured.");Ok(())}
    fn apply_effective(&self,provider:&str)->Result<()> {self.config.set_provider_enabled(provider,self.config.configured_provider_override(provider).unwrap_or(self.config.provider_auto_enable(provider)==Some(true)))}
    pub async fn set_overrides(&self,providers:&Value)->Result<()> {
        self.load().await?;let providers=providers.as_object().context("The provider changes are invalid.")?;for provider in providers.keys(){self.assert_provider(provider)?;}
        let _state=self.state.lock().await;let updates=providers.iter().map(|(id,value)|(id.clone(),value.clone())).collect();self.config.update_runtime_provider_states(&updates).await?;
        for (id,value) in providers{let enabled=value["enabled"].as_bool().context("The provider enablement is invalid.")?;self.config.set_provider_enabled(id,enabled)?;if !enabled{if let Some(active)=self.verifications.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(id){for token in active.values(){token.cancel();}}}}
        Ok(())
    }
    async fn remember(&self,provider:&str)->Result<()> {
        let mut state=self.state.lock().await;if !state.remembered.contains(provider)&&self.config.provider_auto_enable(provider)!=Some(false){self.config.update_runtime_provider_states(&BTreeMap::from([(provider.to_owned(),json!({"autoEnable":true}))])).await?;state.remembered.insert(provider.to_owned());}self.apply_effective(provider)
    }
    pub async fn verify(&self,provider:&str,level:&str)->Result<Value> {
        self.load().await?;self.assert_provider(provider)?;anyhow::ensure!(self.schemas.valid("ownerProviderVerificationRequest",&json!({"level":level}))?,"The verification level is invalid.");
        let id=cuid2::create_id();let token=self.lifecycle.shutdown.child_token();self.verifications.lock().unwrap_or_else(std::sync::PoisonError::into_inner).entry(provider.to_owned()).or_default().insert(id.clone(),token.clone());
        let mut performed=level;let mut model=None;let operation=async {if self.probe(provider).await!="available"{return false;}match level {
            "credentials"=>true,
            "authentication"=>match self.config.read_provider_usage_unchecked(provider,&token).await{Ok(Some(_))=>true,Ok(None)=>{performed="inference";let inference=self.verify_inference(provider,&token).await;model=inference.0;inference.1},Err(_)=>false},
            "inference"=>{let inference=self.verify_inference(provider,&token).await;model=inference.0;inference.1},_=>false
        }};
        let passed=tokio::select!{_ = token.cancelled()=>false,result=tokio::time::timeout(Duration::from_secs(30),operation)=>result.unwrap_or(false)};
        {let mut active=self.verifications.lock().unwrap_or_else(std::sync::PoisonError::into_inner);if let Some(active)=active.get_mut(provider){active.remove(&id);}if active.get(provider).is_some_and(BTreeMap::is_empty){active.remove(provider);}}
        if passed{self.remember(provider).await?;}
        let response=json!({"checkedAt":now(),"modelId":model,"performedLevel":performed,"providerId":provider,"requestedLevel":level,"status":if passed{"passed"}else{"failed"}});anyhow::ensure!(self.schemas.valid("ownerProviderVerificationResponse",&response)?,"The provider verification result is invalid.");Ok(response)
    }
    async fn verify_inference(&self,provider:&str,token:&CancellationToken)->(Option<String>,bool) {
        let models=match self.config.offered_models(){Ok(models)=>models,Err(_)=>return(None,false)};let preferred=match self.config.provider_kind(provider).as_deref(){Some("bedrock")=>"anthropic/fable-5",Some("claude")=>"anthropic/sonnet-5",Some("codex")=>"openai/gpt-5.6-luna",Some("grok")=>"xai/grok-composer-2.5-fast",_=>""};
        let routes=models.iter().filter(|model|model["providerId"]==provider).collect::<Vec<_>>();let Some(model)=routes.iter().find(|model|model["id"]==preferred).copied().or_else(||routes.first().copied())else{return(None,false);};let Some(id)=model["id"].as_str()else{return(None,false);};
        let selected=Some(id.to_owned());let mut session=match self.config.verification_session(&format!("provider-verification:{}",cuid2::create_id()),provider,id).await{Ok(session)=>session,Err(_)=>return(selected,false)};
        let effort=match model["effortLevels"][0].as_str().unwrap_or("low"){"off"=>Effort::Off,"minimal"=>Effort::Minimal,"medium"=>Effort::Medium,"high"=>Effort::High,"xhigh"=>Effort::Xhigh,"max"=>Effort::Max,_=>Effort::Low};let request=RunRequest{context:SessionContext{instructions:"Reply with OK.".to_owned(),messages:vec![Message::user("Reply with OK.")]},model:Some(id.to_owned()),effort:Some(effort),..Default::default()};
        let (sender,mut events)=tokio::sync::mpsc::channel(64);let consume=async{while let Some(event)=events.recv().await{if let Event::Done{outcome}=event{return matches!(outcome,Outcome::Normal{..});}}false};
        let (_,passed)=tokio::join!(session.run(request,token.clone(),sender),consume);
        session.destroy().await;(selected,passed)
    }
}