//! Seven public secret routes; target admission and catalog mutations share a transaction.
use super::*;
use crate::product::{
    runtime::Context,
    secrets::{SecretConflictError, SecretInputError},
};
use anyhow::{Context as _, Result};
#[cfg(test)]
mod tests;

#[derive(Debug)]
struct RouteError {
    status: u16,
    code: &'static str,
    message: &'static str,
}
impl std::fmt::Display for RouteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message)
    }
}
impl std::error::Error for RouteError {}
fn reject(status: u16, code: &'static str, message: &'static str) -> anyhow::Error {
    RouteError {
        status,
        code,
        message,
    }
    .into()
}
fn failure(failure: anyhow::Error) -> Response<Body> {
    if let Some(failure) = failure.downcast_ref::<RouteError>() {
        return error(failure.status, failure.code, failure.message);
    }
    if let Some(failure) = failure.downcast_ref::<SecretInputError>() {
        return error(400, "invalid_request", &failure.0);
    }
    if let Some(failure) = failure.downcast_ref::<SecretConflictError>() {
        let mut value = json!({"error":failure.message,"code":"conflict"});
        if let Some(current) = &failure.current {
            value["currentVersion"] = current["version"].clone();
            value["secret"] = current.clone();
        }
        return response(409, value);
    }
    internal(failure)
}
fn decode(value: &str) -> Result<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let digit = |value: u8| (value as char).to_digit(16).map(|v| v as u8);
            let a = bytes
                .get(index + 1)
                .copied()
                .and_then(digit)
                .context("The secret path encoding is invalid.")?;
            let b = bytes
                .get(index + 2)
                .copied()
                .and_then(digit)
                .context("The secret path encoding is invalid.")?;
            output.push(a * 16 + b);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output)
        .map_err(|_| SecretInputError("The secret path encoding is invalid.".into()).into())
}
fn query(request: &Request<Incoming>, attachments: bool) -> Result<Value> {
    let pairs =
        form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes()).collect::<Vec<_>>();
    let allowed = if attachments {
        &["cursor", "limit"][..]
    } else {
        &["cursor", "limit", "targetId", "targetType"][..]
    };
    if pairs
        .iter()
        .any(|(key, _)| !allowed.contains(&key.as_ref()))
    {
        return Err(SecretInputError("The secret query parameter is not supported.".into()).into());
    }
    let get = |key: &str| {
        pairs
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_ref())
    };
    let mut result = json!({"limit":50});
    if let Some(limit) = get("limit") {
        if limit.is_empty()
            || !limit.bytes().all(|v| v.is_ascii_digit())
            || limit.len() > 1 && limit.starts_with('0')
        {
            return Err(SecretInputError("A numeric query parameter is invalid.".into()).into());
        }
        result["limit"] = json!(limit.parse::<u64>().map_err(|_| SecretInputError(
            "A numeric query parameter is outside its allowed range.".into()
        ))?);
    }
    if let Some(cursor) = get("cursor") {
        result["cursor"] = json!(cursor);
    }
    if !attachments {
        match (get("targetType"), get("targetId")) {
            (None, None) => {}
            (Some(kind), Some(id)) => result["target"] = json!({"type":kind,"id":id}),
            _ => {
                return Err(SecretInputError(
                    "Secret targetType and targetId must be supplied together.".into(),
                )
                .into());
            }
        }
    }
    Ok(result)
}
fn mutation(body: &mut Value) -> Option<Value> {
    body.as_object_mut()
        .expect("validated object")
        .remove("mutationId")
}
impl ApiModule {
    fn secret_target(&self, ctx: &Context<'_>, target: &Value, active: bool) -> Result<()> {
        if !self.schemas.valid("secretTarget", target)? {
            return Err(SecretInputError("The secret attachment target is invalid.".into()).into());
        }
        let id = target["id"].as_str().expect("target id");
        match target["type"].as_str().expect("type") {
            "project" => {
                let project = self.projects.get(ctx, id)?.ok_or_else(|| {
                    reject(
                        404,
                        "not_found",
                        "The secret attachment project was not found.",
                    )
                })?;
                if active && project["status"] != "active" {
                    return Err(reject(
                        409,
                        "conflict",
                        "The secret attachment project is archived.",
                    ));
                }
            }
            "workspace" => {
                if let Some(bot) = self.bots.for_workspace(ctx, id)? {
                    if active && bot["status"] != "active" {
                        return Err(reject(
                            409,
                            "conflict",
                            "The secret attachment workspace is archived.",
                        ));
                    }
                    return Ok(());
                }
                if let Some(project) = self.projects.get(ctx, id)? {
                    if active && project["status"] != "active" {
                        return Err(reject(
                            409,
                            "conflict",
                            "The secret attachment workspace is archived.",
                        ));
                    }
                    return Ok(());
                }
                let workspace = self.workspaces.get(ctx, id)?.ok_or_else(|| {
                    reject(
                        404,
                        "not_found",
                        "The secret attachment workspace was not found.",
                    )
                })?;
                if active && workspace["status"] != "ready" {
                    return Err(reject(
                        409,
                        "conflict",
                        "The secret attachment workspace is unavailable.",
                    ));
                }
            }
            "agent" => {
                let agent = self.agents.configuration(ctx, id)?.ok_or_else(|| {
                    reject(
                        404,
                        "not_found",
                        "The secret attachment agent was not found.",
                    )
                })?;
                if active && agent["metadata"]["archivedAt"].is_number() {
                    return Err(reject(
                        409,
                        "conflict",
                        "The secret attachment agent is archived.",
                    ));
                }
            }
            _ => unreachable!("validated target"),
        }
        Ok(())
    }
    fn secret_current(&self, ctx: &Context<'_>, id: &str) -> Result<Value> {
        self.secrets
            .get(ctx, id)?
            .ok_or_else(|| reject(404, "not_found", "The secret was not found."))
    }
    pub(super) async fn secret_route(
        self: &Arc<Self>,
        request: Request<Incoming>,
    ) -> Response<Body> {
        let method = request.method().as_str().to_owned();
        let path = request.uri().path().to_owned();
        let parts = path
            .strip_prefix("/v0/secrets")
            .unwrap_or("")
            .split('/')
            .collect::<Vec<_>>();
        if path == "/v0/secrets" && method == "GET" {
            let query = match query(&request, false) {
                Ok(query) => query,
                Err(error) => return failure(error),
            };
            if !self.schemas.valid("secretList", &query).unwrap_or(false) {
                return error(
                    400,
                    "invalid_request",
                    "The secret catalog query is invalid.",
                );
            }
            let owner = self.clone();
            return match self
                .runtime
                .transact(move |ctx| {
                    if let Some(target) = query.get("target") {
                        owner.secret_target(ctx, target, false)?;
                    }
                    owner.secrets.list(ctx, &query)
                })
                .await
            {
                Ok(value) => response(200, value),
                Err(error) => failure(error),
            };
        }
        if path == "/v0/secrets" && method == "POST" {
            let mut body = match read_json(request).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            if !self
                .schemas
                .valid("secretCreateRequest", &body)
                .unwrap_or(false)
            {
                return error(
                    400,
                    "invalid_request",
                    "The secret creation request is invalid.",
                );
            }
            let mutation = mutation(&mut body);
            let owner = self.clone();
            return match self
                .runtime
                .transact(move |ctx| owner.secrets.create(ctx, &body, mutation.as_ref()))
                .await
            {
                Ok(secret) => response(201, json!({"secret":secret})),
                Err(error) => failure(error),
            };
        }
        let single = parts.len() == 2 && !parts[1].is_empty();
        let attachments = parts.len() == 3 && parts[2] == "attachments" && !parts[1].is_empty();
        let grant = parts.len() == 5
            && parts[2] == "attachments"
            && matches!(parts[3], "project" | "workspace" | "agent")
            && !parts[1].is_empty()
            && !parts[4].is_empty();
        if !(single
            || attachments && method == "GET"
            || grant && matches!(method.as_str(), "PUT" | "DELETE"))
        {
            return error(404, "not_found", "Not found.");
        }
        let id = match decode(parts[1]) {
            Ok(id) if self.schemas.valid("secretId", &json!(id)).unwrap_or(false) => id,
            _ => return error(400, "invalid_request", "The secret ID is invalid."),
        };
        if attachments && method == "GET" {
            let query = match query(&request, true) {
                Ok(query) => query,
                Err(error) => return failure(error),
            };
            if !self
                .schemas
                .valid("secretAttachmentList", &query)
                .unwrap_or(false)
            {
                return error(
                    400,
                    "invalid_request",
                    "The secret attachment query is invalid.",
                );
            }
            let owner = self.clone();
            return match self
                .runtime
                .transact(move |ctx| {
                    owner
                        .secrets
                        .attachment_page(ctx, &id, &query)?
                        .ok_or_else(|| reject(404, "not_found", "The secret was not found."))
                })
                .await
            {
                Ok(value) => response(200, value),
                Err(error) => failure(error),
            };
        }
        if grant {
            let target_id = match decode(parts[4]) {
                Ok(id) => id,
                Err(_) => return error(400, "invalid_request", "The secret target ID is invalid."),
            };
            let target = json!({"type":parts[3],"id":target_id});
            if !self.schemas.valid("secretTarget", &target).unwrap_or(false) {
                return error(
                    400,
                    "invalid_request",
                    "The secret attachment target is invalid.",
                );
            }
            let owner = self.clone();
            let checked_id = id.clone();
            let checked_target = target.clone();
            let active = method == "PUT";
            if let Err(error) = self
                .runtime
                .transact(move |ctx| {
                    owner.secret_current(ctx, &checked_id)?;
                    owner.secret_target(ctx, &checked_target, active)
                })
                .await
            {
                return failure(error);
            }
            let body = match read_json_limited(request, 2048, true).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            if !self
                .schemas
                .valid("secretAttachmentMutationRequest", &body)
                .unwrap_or(false)
            {
                return error(
                    400,
                    "invalid_request",
                    "The secret attachment mutation is invalid.",
                );
            }
            let owner = self.clone();
            return match self
                .runtime
                .transact(move |ctx| {
                    owner.secret_current(ctx, &id)?;
                    owner.secret_target(ctx, &target, active)?;
                    if active {
                        let (attachment, created) =
                            owner
                                .secrets
                                .attach(ctx, &id, &target, body.get("mutationId"))?;
                        Ok((
                            if created { 201 } else { 200 },
                            json!({"attachment":attachment,"created":created}),
                        ))
                    } else {
                        let attachment =
                            owner
                                .secrets
                                .detach(ctx, &id, &target, body.get("mutationId"))?;
                        Ok((
                            200,
                            json!({"detached":attachment.is_some(),"attachment":attachment}),
                        ))
                    }
                })
                .await
            {
                Ok((status, body)) => response(status, body),
                Err(error) => failure(error),
            };
        }
        if single && method == "GET" {
            let owner = self.clone();
            return match self
                .runtime
                .transact(move |ctx| owner.secret_current(ctx, &id))
                .await
            {
                Ok(secret) => response(200, json!({"secret":secret})),
                Err(error) => failure(error),
            };
        }
        if single && method == "PATCH" {
            let headers = request.headers().get_all(hyper::header::IF_MATCH);
            let mut values = headers.iter();
            let expected = values
                .next()
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            let valid = values.next().is_none()
                && expected.as_ref().is_some_and(|v| {
                    self.schemas
                        .valid("secretVersion", &json!(v))
                        .unwrap_or(false)
                });
            let owner = self.clone();
            let checked_id = id.clone();
            let checked_version = expected.clone();
            let current = self
                .runtime
                .transact(move |ctx| {
                    let current = owner.secret_current(ctx, &checked_id)?;
                    if !valid {
                        return Err(reject(
                            400,
                            "invalid_request",
                            "A valid If-Match resource version is required.",
                        ));
                    }
                    if current["version"] != checked_version.as_deref().expect("valid version") {
                        return Err(SecretConflictError {
                            message: "The resource has changed.".into(),
                            current: Some(current),
                        }
                        .into());
                    }
                    Ok(())
                })
                .await;
            if let Err(error) = current {
                return failure(error);
            }
            let mut body = match read_json(request).await {
                Ok(body) => body,
                Err(response) => return response,
            };
            if !self
                .schemas
                .valid("secretUpdateRequest", &body)
                .unwrap_or(false)
            {
                return error(
                    400,
                    "invalid_request",
                    "The secret update request is invalid.",
                );
            }
            let mutation = mutation(&mut body);
            let owner = self.clone();
            return match self
                .runtime
                .transact(move |ctx| {
                    owner
                        .secrets
                        .update(
                            ctx,
                            &id,
                            &body,
                            expected.as_deref().expect("validated version"),
                            mutation.as_ref(),
                        )?
                        .ok_or_else(|| reject(404, "not_found", "The secret was not found."))
                })
                .await
            {
                Ok(secret) => response(200, json!({"secret":secret})),
                Err(error) => failure(error),
            };
        }
        error(404, "not_found", "Not found.")
    }
}
