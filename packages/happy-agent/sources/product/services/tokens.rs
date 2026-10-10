//! Daemon-lifetime establishment credentials. A signature never revives a stopped service.
use crate::product::{identity::now, schemas::Schemas};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

pub(super) struct AccessTokens {
    key: [u8; 32],
}
impl AccessTokens {
    pub fn new() -> Self {
        let mut key = [0u8; 32];
        rand::rng().fill_bytes(&mut key);
        Self { key }
    }
    pub fn issue(&self, schemas: &Schemas, scope: &Value) -> Result<Value> {
        ensure!(
            schemas.valid("serviceAccessScope", scope)?,
            "The service access credential belongs to a different scope."
        );
        let issued = now();
        let expires = issued + 300_000;
        let mut nonce = [0u8; 16];
        rand::rng().fill_bytes(&mut nonce);
        let mut payload = scope.clone();
        payload["version"] = json!(1);
        payload["issuedAt"] = json!(issued);
        payload["expiresAt"] = json!(expires);
        payload["nonce"] = json!(URL_SAFE_NO_PAD.encode(nonce));
        ensure!(
            schemas.valid("serviceAccessPayload", &payload)?,
            "The service access credential is invalid."
        );
        let encoded = URL_SAFE_NO_PAD.encode(payload.to_string());
        let signature = URL_SAFE_NO_PAD.encode(hmac(&self.key, encoded.as_bytes()));
        let token = format!("{encoded}.{signature}");
        ensure!(
            schemas.valid("serviceAccessToken", &json!(token))?,
            "The service access credential is invalid."
        );
        Ok(json!({"accessToken":token,"expiresAt":expires}))
    }
    pub fn authorize(&self, schemas: &Schemas, scope: &Value, token: Option<&str>) -> Result<()> {
        ensure!(
            schemas.valid("serviceAccessScope", scope)?,
            "The service access credential belongs to a different scope."
        );
        let invalid = "The service access credential is missing, invalid, or expired.";
        let token = token.unwrap_or("");
        ensure!(
            schemas.valid("serviceAccessToken", &json!(token))?,
            "{invalid}"
        );
        let (encoded, signature) = token
            .split_once('.')
            .ok_or_else(|| anyhow::anyhow!(invalid))?;
        let decoded = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| anyhow::anyhow!(invalid))?;
        ensure!(
            decoded.len() == 32
                && URL_SAFE_NO_PAD.encode(&decoded) == signature
                && bool::from(
                    decoded
                        .as_slice()
                        .ct_eq(&hmac(&self.key, encoded.as_bytes()))
                ),
            "{invalid}"
        );
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| anyhow::anyhow!(invalid))?;
        let payload: Value =
            serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!(invalid))?;
        ensure!(
            schemas.valid("serviceAccessPayload", &payload)?,
            "{invalid}"
        );
        let issued = payload["issuedAt"].as_u64().expect("validated token");
        let expires = payload["expiresAt"].as_u64().expect("validated token");
        ensure!(
            issued <= now() && expires > now() && expires.checked_sub(issued) == Some(300_000),
            "{invalid}"
        );
        for field in ["principalId", "workspaceId", "serviceId", "executionId"] {
            ensure!(
                payload[field] == scope[field],
                "The service access credential belongs to a different scope."
            );
        }
        Ok(())
    }
}
fn hmac(key: &[u8; 32], message: &[u8]) -> [u8; 32] {
    let mut inner = [0x36u8; 64];
    let mut outer = [0x5cu8; 64];
    for index in 0..32 {
        inner[index] ^= key[index];
        outer[index] ^= key[index];
    }
    let mut digest = Sha256::new();
    digest.update(inner);
    digest.update(message);
    let result = digest.finalize();
    let mut digest = Sha256::new();
    digest.update(outer);
    digest.update(result);
    digest.finalize().into()
}
