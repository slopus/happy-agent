//! Semantic URL and verified-token checks over the original TypeBox contracts.
use crate::product::{identity::now, schemas::Schemas};
use anyhow::{Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;

pub(super) enum Callback {
    Code(String),
    Error(String),
}
#[derive(Clone)]
pub(super) struct Token {
    pub access_token: String,
    pub issued_at: u64,
    pub expires_at: u64,
}
pub(super) fn redirect(value: &str) -> Option<String> {
    if value.is_empty() || value.encode_utf16().count() > 2048 {
        return None;
    }
    let parsed = Url::parse(value).ok()?;
    let host = parsed.host_str().unwrap_or("");
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]")
        || host
            .parse::<std::net::Ipv4Addr>()
            .is_ok_and(|address| address.octets()[0] == 127);
    let allowed = parsed.scheme() == "https"
        || (parsed.scheme() == "http" && loopback)
        || (!matches!(
            parsed.scheme(),
            "http" | "https" | "about" | "blob" | "data" | "file" | "javascript" | "mailto"
        ) && (!host.is_empty() || !parsed.path().is_empty()));
    if !allowed
        || !parsed.username().is_empty()
        || parsed.password().is_some_and(|value| !value.is_empty())
        || parsed
            .fragment()
            .is_some_and(|fragment| !fragment.is_empty())
    {
        return None;
    }
    Some(value.to_owned())
}
pub(super) fn callback(value: &str, redirect: &str, state: &str) -> Option<Callback> {
    if value.is_empty() || value.encode_utf16().count() > 4096 {
        return None;
    }
    let callback = Url::parse(value).ok()?;
    let redirect = Url::parse(redirect).ok()?;
    if callback
        .fragment()
        .is_some_and(|fragment| !fragment.is_empty())
        || !callback.username().is_empty()
        || callback.password().is_some_and(|value| !value.is_empty())
        || callback.scheme() != redirect.scheme()
        || callback.host_str() != redirect.host_str()
        || callback.port() != redirect.port()
        || callback.path() != redirect.path()
    {
        return None;
    }
    let pairs: Vec<_> = callback.query_pairs().collect();
    let states: Vec<_> = pairs
        .iter()
        .filter(|(key, _)| key == "state")
        .map(|(_, value)| value.as_ref())
        .collect();
    if states.len() != 1
        || states[0].is_empty()
        || !bool::from(states[0].as_bytes().ct_eq(state.as_bytes()))
    {
        return None;
    }
    let codes: Vec<_> = pairs
        .iter()
        .filter(|(key, _)| key == "code")
        .map(|(_, value)| value.as_ref())
        .collect();
    let errors: Vec<_> = pairs
        .iter()
        .filter(|(key, _)| key == "error")
        .map(|(_, value)| value.as_ref())
        .collect();
    if codes.len() == 1 && !codes[0].is_empty() && errors.is_empty() {
        Some(Callback::Code(codes[0].to_owned()))
    } else if errors.len() == 1 && !errors[0].is_empty() && codes.is_empty() {
        Some(Callback::Error(errors[0].to_owned()))
    } else {
        None
    }
}
pub(super) fn endpoint(schemas: &Schemas, value: &str) -> Option<String> {
    if !schemas
        .valid("cloudTeamEndpointInput", &json!(value))
        .ok()?
    {
        return None;
    }
    let url = Url::parse(value).ok()?;
    if !matches!(url.scheme(), "http" | "https" | "tailcat" | "ws" | "wss")
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some_and(|value| !value.is_empty())
        || url.fragment().is_some_and(|fragment| !fragment.is_empty())
    {
        return None;
    }
    let normalized = url.to_string();
    schemas
        .valid("cloudTeamEndpoint", &json!(normalized))
        .ok()?
        .then_some(normalized)
}
pub(super) fn email(schemas: &Schemas, value: &str) -> Option<String> {
    if !schemas
        .valid("cloudInvitationEmailInput", &json!(value))
        .ok()?
    {
        return None;
    }
    let normalized = value.trim().to_lowercase();
    schemas
        .valid("cloudInvitationEmail", &json!(normalized))
        .ok()?
        .then_some(normalized)
}
pub(super) fn token(
    schemas: &Schemas,
    access_token: &str,
    organization: &str,
    user: &str,
    client: &str,
    short: bool,
) -> Result<Token> {
    let segments: Vec<_> = access_token.split('.').collect();
    ensure!(
        segments.len() == 3 && !segments[1].is_empty(),
        "WorkOS returned an invalid access token; no token was released."
    );
    let bytes = URL_SAFE_NO_PAD.decode(segments[1]).map_err(|_| {
        anyhow::anyhow!("WorkOS returned an invalid access token; no token was released.")
    })?;
    let claims: Value = serde_json::from_slice(&bytes).map_err(|_| {
        anyhow::anyhow!("WorkOS returned an invalid access token; no token was released.")
    })?;
    ensure!(
        schemas.valid(
            if short {
                "cloudShortLivedClaims"
            } else {
                "cloudOrganizationClaims"
            },
            &claims
        )? && claims["org_id"] == organization
            && claims["sub"] == user
            && claims["client_id"] == client
            && claims["iss"] == format!("https://api.workos.com/user_management/{client}"),
        "WorkOS returned unexpected access token claims; no token was released."
    );
    let issued = claims["iat"].as_u64().ok_or_else(|| {
        anyhow::anyhow!(
            "WorkOS returned an access token that is not currently valid; no token was released."
        )
    })?;
    let expires = claims["exp"].as_u64().ok_or_else(|| {
        anyhow::anyhow!(
            "WorkOS returned an access token that is not currently valid; no token was released."
        )
    })?;
    let current = now();
    let issued_at = issued.checked_mul(1000).ok_or_else(|| {
        anyhow::anyhow!(
            "WorkOS returned an access token that is not currently valid; no token was released."
        )
    })?;
    let expires_at = expires.checked_mul(1000).ok_or_else(|| {
        anyhow::anyhow!(
            "WorkOS returned an access token that is not currently valid; no token was released."
        )
    })?;
    ensure!(
        issued_at <= current && expires_at > current && expires > issued,
        "WorkOS returned an access token that is not currently valid; no token was released."
    );
    ensure!(
        !short || (expires - issued <= 300 && expires_at - current <= 300_000),
        "WorkOS issued an access token lasting longer than five minutes; no token was released. Set Access token duration to five minutes or less in the WorkOS application's Sessions settings before trying again."
    );
    Ok(Token {
        access_token: access_token.to_owned(),
        issued_at,
        expires_at,
    })
}
