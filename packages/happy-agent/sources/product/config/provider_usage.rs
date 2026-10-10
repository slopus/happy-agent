//! Config selects the subscription account without borrowing an explicit API key.
use super::*;
impl ConfigModule {
    pub async fn read_provider_usage_unchecked(&self,provider:&str,cancel:&tokio_util::sync::CancellationToken)->Result<Option<()>> {
        let kind=self.provider_type(provider).context("The provider is not configured.")?;
        if !matches!(kind,"codex"|"claude"|"grok"){return Ok(None);}
        let entry=&self.values["providers"][provider];if entry.get("api_key").is_some(){return Ok(None);}
        let model=self.catalogs[kind][0]["id"].as_str().context("The provider catalog is empty.")?;
        let (_,configuration)=self.concrete_configuration(&serde_json::json!({"provider":provider,"model":model}),false)?;
        let base=if kind=="claude"{std::env::var("ANTHROPIC_BASE_URL").ok()}else{None};
        happy_providers::probe_account_authentication(kind,configuration.credential,base.as_deref(),cancel).await
    }
}