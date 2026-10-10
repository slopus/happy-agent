//! Idle maintenance uses exactly the credential selection used by inference.
use super::ConfigModule;
use futures_util::StreamExt;
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

impl ConfigModule {
    pub async fn refresh_provider_credentials(&self, cancel: &CancellationToken) {
        let accounts = self.provider_ids().into_iter().filter(|account| {
            matches!(self.provider_type(account), Some("codex" | "grok"))
                && self.values["providers"][account].get("api_key").is_none()
                && self.provider_enabled(account)
        });
        futures_util::stream::iter(accounts).for_each_concurrent(8, |account| async move {
            if cancel.is_cancelled() || self.provider_lifetime.is_cancelled() || !self.provider_enabled(&account) { return; }
            let account_lifetime = self.provider_signal(&account);
            let refresh = async {
                let kind = self.provider_type(&account).ok_or(())?;
                let model = self.catalogs[kind][0]["id"].as_str().ok_or(())?;
                let (_, configuration) = self.concrete_configuration(&json!({"provider":account,"model":model}), false).map_err(|_| ())?;
                let credential = happy_providers::Credential::load(configuration.credential, &configuration.region).await.map_err(|_| ())?;
                if !self.provider_enabled(&account) || !credential.supports_maintenance().await { return Ok(()); }
                // A static credential has no maintenance work. The provider owns
                // deciding whether its loaded credential can renew a session.
                if !credential.refresh_for_maintenance(cancel).await.map_err(|_| ())? { return Err(()); }
                Ok::<_, ()>(())
            };
            let failed = tokio::select! {
                _ = cancel.cancelled() => false,
                _ = self.provider_lifetime.cancelled() => false,
                _ = account_lifetime.cancelled() => false,
                result = tokio::time::timeout(Duration::from_secs(30), refresh) => !matches!(result, Ok(Ok(()))),
            };
            if failed && !cancel.is_cancelled() && !self.provider_lifetime.is_cancelled() && self.provider_enabled(&account) {
                // Credential parse errors and upstream diagnostics can contain
                // tokens, so only the configured account name reaches the log.
                eprintln!("Could not refresh the sign-in for provider \"{account}\" in the background.");
            }
        }).await;
    }
}
