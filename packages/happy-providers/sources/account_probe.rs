//! The shipped account endpoints' null/non-null authentication result.
//! Quota projection is independent of the explicit verification decision.
use crate::{Credential,CredentialSource};
use anyhow::{Context,Result};
use serde_json::json;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use futures_util::StreamExt;
pub async fn probe_account_authentication(kind:&str,source:CredentialSource,base_url:Option<&str>,cancel:&CancellationToken)->Result<Option<()>> {
    let probe=async {
        let credential=match Credential::account(source).await {Ok(Some(credential))=>credential,Ok(None)=>return Ok(None),Err(error) if error.downcast_ref::<crate::CredentialUnavailable>().is_some()=>return Ok(None),Err(error)=>return Err(error)};
        let client=reqwest::Client::builder().timeout(Duration::from_secs(if kind=="grok"{15}else{10})).build()?;
        let base=base_url.unwrap_or(match kind{"codex"=>"https://chatgpt.com/backend-api","grok"=>"https://cli-chat-proxy.grok.com/v1",_=>"https://api.anthropic.com"}).trim_end_matches('/');
        let headers=credential.headers("GET",base,b"","","").await.map_err(anyhow::Error::new)?;
        if kind=="codex" {let response=client.get(format!("{base}/wham/usage")).headers(headers).send().await?;if !response.status().is_success(){return Ok(None);}body_json(response).await?;return Ok(Some(()));}
        if kind=="grok" {
            let mut headers=headers;headers.insert("x-xai-token-auth","xai-grok-cli".parse()?);headers.insert("x-grok-client-version","1.0.46".parse()?);if let Some(user)=credential.grok_user_id().await{headers.insert("x-userid",user.parse()?);}
            let (billing,user)=tokio::join!(client.get(format!("{base}/billing?format=credits")).headers(headers.clone()).send(),client.get(format!("{base}/user?include=subscription")).headers(headers).send());
            if let Ok(response)=user{let _=body_json(response).await;}let billing=billing?;if !billing.status().is_success(){return Ok(None);}body_json(billing).await?;return Ok(Some(()));
        }
        let mut headers=headers;headers.insert("anthropic-beta","oauth-2025-04-20".parse()?);headers.insert("content-type","application/json".parse()?);headers.insert("user-agent","claude-cli/2.0.0 (external, cli)".parse()?);
        let (usage,profile)=tokio::join!(client.get(format!("{base}/api/oauth/usage")).headers(headers.clone()).send(),client.get(format!("{base}/api/oauth/profile")).headers(headers.clone()).send());
        if let Ok(response)=profile{let _=body_json(response).await;}let usage=usage?;
        if !matches!(usage.status().as_u16(),403|404){anyhow::ensure!(usage.status().is_success(),"The provider usage request failed.");body_json(usage).await?;return Ok(Some(()));}
        headers.insert("anthropic-version","2023-06-01".parse()?);
        let response=client.post(format!("{base}/v1/messages")).headers(headers).json(&json!({"model":"claude-haiku-4-5-20251001","max_tokens":1,"system":[{"type":"text","text":"You are Claude Code, Anthropic's official CLI for Claude."}],"messages":[{"role":"user","content":"hi"}]})).send().await?;
        if response.headers().contains_key("anthropic-ratelimit-unified-status"){return Ok(Some(()));}anyhow::ensure!(response.status().is_success(),"The provider usage request failed.");Ok(None)
    };
    let result=tokio::select!{_ = cancel.cancelled()=>Err(anyhow::anyhow!("The provider verification was stopped.")),result=probe=>result};
    // Codex and Grok intentionally return null for unreadable account endpoints.
    if matches!(kind,"codex"|"grok") {Ok(result.unwrap_or(None))}else{result}
}
async fn body_json(response:reqwest::Response)->Result<serde_json::Value>{let mut bytes=Vec::new();let mut stream=response.bytes_stream();while let Some(chunk)=stream.next().await{let chunk=chunk.context("The provider usage response could not be read.")?;anyhow::ensure!(bytes.len()+chunk.len()<=1_048_576,"The provider usage response exceeds its size limit.");bytes.extend_from_slice(&chunk);}Ok(serde_json::from_slice(&bytes)?)}