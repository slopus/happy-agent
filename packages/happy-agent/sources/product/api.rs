use super::{config::ConfigModule, lifecycle::LifecycleModule, runtime::RuntimeModule};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response, StatusCode, body::Incoming};
use serde_json::{Value, json};
use std::{
    convert::Infallible,
    sync::{Arc, Mutex, OnceLock},
};
use subtle::ConstantTimeEq;

pub struct ApiModule {
    _config: Arc<ConfigModule>,
    pub lifecycle: Arc<LifecycleModule>,
    token: OnceLock<String>,
    runtime: OnceLock<Arc<Mutex<RuntimeModule>>>,
}

impl ApiModule {
    pub fn new(config: Arc<ConfigModule>, lifecycle: Arc<LifecycleModule>) -> Self {
        Self {
            _config: config,
            lifecycle,
            token: OnceLock::new(),
            runtime: OnceLock::new(),
        }
    }
    pub fn prepare_token(&self) -> anyhow::Result<()> {
        let token = self._config.prepare_token()?;
        self.token
            .set(token)
            .map_err(|_| anyhow::anyhow!("The API credential has already been prepared."))
    }
    pub fn start(&self, runtime: Arc<Mutex<RuntimeModule>>) {
        let _ = self.runtime.set(runtime);
    }
    pub async fn close_runtime(&self) -> anyhow::Result<()> {
        if let Some(runtime) = self.runtime.get() {
            let runtime = runtime.clone();
            tokio::task::spawn_blocking(move || {
                runtime
                    .lock()
                    .map_err(|_| anyhow::anyhow!("The runtime database lock is unavailable."))?
                    .close()
            })
            .await??;
        }
        Ok(())
    }
    fn authorized(&self, request: &Request<Incoming>) -> bool {
        let mut headers = request
            .headers()
            .get_all(hyper::header::AUTHORIZATION)
            .iter();
        let Some(header) = headers.next() else {
            return false;
        };
        if headers.next().is_some() {
            return false;
        }
        let Some(supplied) = header
            .to_str()
            .ok()
            .and_then(|header| header.strip_prefix("Bearer "))
        else {
            return false;
        };
        let Some(token) = self.token.get() else {
            return false;
        };
        supplied.len() == token.len() && bool::from(supplied.as_bytes().ct_eq(token.as_bytes()))
    }
    pub async fn handle(
        self: Arc<Self>,
        request: Request<Incoming>,
    ) -> Result<Response<Full<Bytes>>, Infallible> {
        let method = request.method().as_str();
        let path = request.uri().path();
        let authorized = self.authorized(&request);
        if method == "GET" && path == "/v0/authentication" {
            return Ok(response(
                200,
                json!({"authenticated":authorized,"userId":null,"methods":[]}),
            ));
        }
        if !authorized {
            return Ok(error(401, "unauthorized", "Unauthorized"));
        }
        if method == "GET" && path == "/v0/health" {
            return Ok(response(200, self.lifecycle.health()));
        }
        if !self.lifecycle.is_ready() {
            return Ok(error(
                503,
                "not_initialized",
                "Happy Agent is still starting.",
            ));
        }
        let mutating = !(["GET", "HEAD", "OPTIONS"].contains(&method)
            || method == "POST" && ["/v0/drain", "/v0/shutdown"].contains(&path));
        if self.lifecycle.is_draining() && mutating {
            return Ok(error(
                503,
                "draining",
                "Happy Agent is draining and no longer accepts mutations.",
            ));
        }
        let result = match (method, path) {
            ("GET", "/") => response(200, json!({"text":"Welcome to Happy Agent!"})),
            ("POST", "/v0/drain") => match self.lifecycle.begin_drain() {
                Ok(()) => response(202, json!({"draining":true,"pid":std::process::id()})),
                Err(failure) => {
                    eprintln!("Could not persist drain status: {failure:#}");
                    error(500, "internal", "An internal error occurred.")
                }
            },
            ("POST", "/v0/shutdown") => {
                self.lifecycle.begin_shutdown();
                response(202, json!({"shuttingDown":true,"pid":std::process::id()}))
            }
            ("POST" | "DELETE", "/v0/debug/inspector") => {
                error(409, "conflict", "This daemon cannot start a debugger.")
            }
            _ => error(404, "not_found", "Not found."),
        };
        Ok(result)
    }
}

fn response(status: u16, value: Value) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from(value.to_string())));
    *response.status_mut() =
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    response.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json; charset=utf-8"),
    );
    response.headers_mut().insert(
        hyper::header::CACHE_CONTROL,
        hyper::header::HeaderValue::from_static("no-store"),
    );
    response
}

fn error(status: u16, code: &str, message: &str) -> Response<Full<Bytes>> {
    response(status, json!({"error":message,"code":code}))
}
