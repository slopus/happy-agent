//! Config owns provider identity and generated runtime-file state.
use super::*;
use serde_json::{Value,json};
impl ConfigModule {
    pub fn provider_ids(&self)->Vec<String> {self.values.get("providers").and_then(toml::Value::as_table).into_iter().flatten().filter(|(id,_)|self.provider_type(id).is_some()).map(|(id,_)|id.clone()).collect()}
    pub fn provider_kind(&self,id:&str)->Option<String>{self.compatible_provider_type(id)}
    pub fn configured_provider_override(&self,id:&str)->Option<bool> {
        let runtime=self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut default=None;let mut provider=None;
        for values in [&self.global_values,&*runtime] {
            if let Some(enabled)=values.get("providers").and_then(|values|values.get("default_enable")).or_else(||values.get("provider_default_enable")).and_then(toml::Value::as_bool){default=Some(enabled);}
            if let Some(enabled)=values.get("providers").and_then(|values|values.get(id)).and_then(|values|values.get("enabled")).and_then(toml::Value::as_bool){provider=Some(enabled);}
        }
        provider.or(default)
    }
    pub fn provider_auto_enable(&self,id:&str)->Option<bool> {
        let runtime=self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        runtime.get("providers").and_then(|values|values.get(id)).and_then(|values|values.get("auto_enable")).or_else(||self.values.get("providers").and_then(|values|values.get(id)).and_then(|values|values.get("auto_enable"))).and_then(toml::Value::as_bool)
    }
    pub async fn update_runtime_provider_states(&self,updates:&BTreeMap<String,Value>)->Result<()> {
        let schemas=super::super::schemas::Schemas::new()?;
        for (id,update) in updates {anyhow::ensure!(self.provider_type(id).is_some(),"Provider \"{id}\" is not configured.");anyhow::ensure!(schemas.valid("ownerRuntimeProviderState",update)?,"The provider state update is invalid.");}
        if updates.is_empty(){return Ok(());}
        let _writer=self.runtime_writer.lock().await;
        let mut next=self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        for (id,update) in updates {
            let providers=next.as_table_mut().context("The runtime configuration is invalid.")?.entry("providers").or_insert_with(||toml::Value::Table(toml::map::Map::new())).as_table_mut().context("The runtime providers are invalid.")?;
            let entry=providers.entry(id.clone()).or_insert_with(||toml::Value::Table(toml::map::Map::new())).as_table_mut().context("The runtime provider state is invalid.")?;
            if !["bedrock","claude","codex","grok"].contains(&id.as_str())&&entry.get("type").is_none(){entry.insert("type".into(),toml::Value::String(self.provider_type(id).context("The provider type is unavailable.")?.to_owned()));}
            for (input,output) in [("enabled","enabled"),("autoEnable","auto_enable")] {if let Some(value)=update.get(input){entry.insert(output.into(),toml::Value::try_from(value)?);}}
        }
        validate_configuration(&next)?;
        let text=toml::to_string_pretty(&next)?;anyhow::ensure!(text.len()<=1_048_576,"The generated runtime configuration exceeds its size limit.");
        let path=self.paths.directory.join("runtime.toml");tokio::task::spawn_blocking(move||atomic_private(&path,text.as_bytes())).await??;
        *self.runtime_values.lock().unwrap_or_else(std::sync::PoisonError::into_inner)=next;Ok(())
    }
    pub fn offered_models(&self)->Result<Vec<Value>> {
        Ok(self.configured_models()?.into_iter().filter(|model| {
            let provider=model["providerId"].as_str().unwrap_or_default();let id=model["id"].as_str().unwrap_or_default();
            self.model_allowed(provider,id)
        }).map(|mut model|{model.as_object_mut().expect("captured model").remove("enabled");model}).collect())
    }
    pub async fn verification_session(&self,id:&str,provider:&str,model:&str)->Result<Box<dyn happy_providers::Session>> {
        if self.provider_type(provider)==Some("smart"){return self.session_internal(id,&json!({"provider":provider,"model":model}),Vec::new(),Some(0),false).await;}
        anyhow::ensure!(self.model_allowed(provider,model)&&self.model_available_on_account(provider,model),"The selected verification model is unavailable.");
        let (_,mut configuration)=self.concrete_configuration(&json!({"provider":provider,"model":model}),false)?;configuration.inference_max_retries=0;
        Ok(Box::new(happy_providers::HttpSession::new(id.to_owned(),configuration,Vec::new()).await?))
    }
}