use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Authentication,
    OutOfTokens,
    RateLimit,
    ServerOverloaded,
    InternalServerError,
    ContextOverflow,
    EmptyResponse,
    Transport,
    Unclassified,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, thiserror::Error)]
#[error("{message}")]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip)]
    pub retryable: bool,
}
impl ProviderError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
            code: None,
            request_id: None,
            retry_after_ms: None,
            retryable: false,
        }
    }
    pub fn transport(message: impl Into<String>) -> Self {
        let mut error = Self::new(ErrorKind::Transport, message);
        error.retryable = true;
        error
    }
    pub fn response(status: u16, headers: &reqwest::header::HeaderMap, body: &[u8]) -> Self {
        let value: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
        let source = value.get("error").unwrap_or(&value);
        let code = source
            .get("code")
            .or_else(|| source.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let lower = source
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        let kind = if code.contains("context")
            || lower.contains("context length")
            || lower.contains("too many tokens")
        {
            ErrorKind::ContextOverflow
        } else if code.contains("usage_limit")
            || code.contains("insufficient_quota")
            || code.contains("billing")
        {
            ErrorKind::OutOfTokens
        } else {
            match status {
                401 | 403 => ErrorKind::Authentication,
                429 => ErrorKind::RateLimit,
                529 | 503 => ErrorKind::ServerOverloaded,
                500..=599 => ErrorKind::InternalServerError,
                _ => ErrorKind::Unclassified,
            }
        };
        let message = match kind {
            ErrorKind::Authentication => {
                "The provider rejected your credentials. Sign in again or check the selected API key."
            }
            ErrorKind::OutOfTokens => "This provider account has exhausted its token allowance.",
            ErrorKind::RateLimit => {
                "The provider is rate limiting this account. Try again after its limit resets."
            }
            ErrorKind::ServerOverloaded => "The provider is overloaded. Try again later.",
            ErrorKind::InternalServerError => {
                "The provider could not complete the request because of an internal error."
            }
            ErrorKind::ContextOverflow => {
                "The conversation exceeds this model’s context limit. Compact it before continuing."
            }
            _ => "The provider rejected the inference request.",
        };
        let mut error = Self::new(kind, message);
        error.retryable = matches!(
            error.kind,
            ErrorKind::RateLimit | ErrorKind::ServerOverloaded | ErrorKind::InternalServerError
        );
        if headers.get("x-should-retry").and_then(|v| v.to_str().ok()) == Some("false") {
            error.retryable = false;
        }
        error.status = Some(status);
        error.code = (!code.is_empty()).then(|| code.chars().take(128).collect());
        error.request_id = headers
            .get("x-request-id")
            .or_else(|| headers.get("request-id"))
            .and_then(|v| v.to_str().ok())
            .map(|s| s.chars().take(128).collect());
        error.retry_after_ms = headers
            .get("retry-after-ms")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .or_else(|| {
                headers
                    .get("retry-after")
                    .and_then(|v| v.to_str().ok())
                    .and_then(|s| s.parse::<u64>().ok())
                    .map(|s| s.saturating_mul(1000))
            });
        error
    }
}
