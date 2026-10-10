//! The documented profile routes project the profile owner's private record.
use super::*;
use crate::product::profile::{ProfileError, ProfilePhotoAsset};
impl ApiModule {
    fn profile_error(&self, failure: anyhow::Error) -> Response<Body> {
        if let Some(ProfileError::Conflict(current)) = failure.downcast_ref::<ProfileError>() {
            return response(
                409,
                json!({"error":"The resource has changed.","code":"conflict","currentVersion":current["version"],"profile":self.profile.resource(current)}),
            );
        }
        if let Some(ProfileError::Invalid(message)) = failure.downcast_ref::<ProfileError>() {
            return error(400, "invalid_request", message);
        }
        internal(failure)
    }
    fn profile_version(
        &self,
        request_headers: &hyper::HeaderMap,
        current: &Value,
    ) -> Result<String, Response<Body>> {
        let mut headers = request_headers.get_all(hyper::header::IF_MATCH).iter();
        let value = headers.next().and_then(|header| header.to_str().ok());
        let Some(value) = value.filter(|_| headers.next().is_none()).filter(|value| {
            self.schemas
                .valid("ownerProfileVersion", &json!(value))
                .unwrap_or(false)
        }) else {
            return Err(error(
                400,
                "invalid_request",
                "A valid If-Match resource version is required.",
            ));
        };
        if current["version"] != value {
            return Err(response(
                409,
                json!({"error":"The resource has changed.","code":"conflict","currentVersion":current["version"],"profile":self.profile.resource(current)}),
            ));
        }
        Ok(value.to_owned())
    }
    pub(super) async fn profile_route(
        self: &Arc<Self>,
        request: Request<Incoming>,
    ) -> Response<Body> {
        let method = request.method().as_str().to_owned();
        let photo = request.uri().path() == "/v0/profile/photo";
        if method == "GET" && photo {
            let owner = self.profile.clone();
            let asset = match self.runtime.transact(move |ctx| owner.get_photo(ctx)).await {
                Ok(Some(asset)) => asset,
                Ok(None) => return error(404, "not_found", "The profile has no photo."),
                Err(failure) => return self.profile_error(failure),
            };
            let cached = request
                .headers()
                .get(hyper::header::IF_NONE_MATCH)
                .and_then(|header| header.to_str().ok())
                == asset.metadata["etag"].as_str();
            return image_response(asset, cached);
        }
        if !photo && method == "GET" {
            let owner = self.profile.clone();
            return match self.runtime.transact(move |ctx| owner.ensure(ctx)).await {
                Ok(profile) => response(200, json!({"profile":self.profile.resource(&profile)})),
                Err(failure) => self.profile_error(failure),
            };
        }
        if !matches!(
            (method.as_str(), photo),
            ("PATCH", false) | ("PUT", true) | ("DELETE", true)
        ) {
            return error(404, "not_found", "The endpoint was not found.");
        }
        // Source validates the JSON patch before its version precondition.
        if !photo {
            let headers = request.headers().clone();
            let mut body = match read_json(request).await {
                Ok(body) => body,
                Err(failure) => return failure,
            };
            if !self
                .schemas
                .valid("ownerProfilePatch", &body)
                .unwrap_or(false)
            {
                return error(400, "invalid_request", "The profile update is not valid.");
            }
            let mutation_id = body.as_object_mut().unwrap().remove("mutationId");
            if !self
                .schemas
                .valid("ownerProfilePatchFields", &body)
                .unwrap_or(false)
            {
                return error(
                    400,
                    "invalid_request",
                    "A profile update must change a name or email address.",
                );
            }
            let owner = self.profile.clone();
            let current = match self.runtime.transact(move |ctx| owner.ensure(ctx)).await {
                Ok(current) => current,
                Err(failure) => return self.profile_error(failure),
            };
            let expected = match self.profile_version(&headers, &current) {
                Ok(version) => version,
                Err(failure) => return failure,
            };
            let owner = self.profile.clone();
            let result = self
                .runtime
                .transact(move |ctx| {
                    mutation::with(mutation_id, || {
                        owner.update(ctx, current["id"].as_str().unwrap(), &body, Some(&expected))
                    })
                })
                .await;
            return match result {
                Ok(Some(profile)) => {
                    response(200, json!({"profile":self.profile.resource(&profile)}))
                }
                Ok(None) => error(404, "not_found", "The profile was not found."),
                Err(failure) => self.profile_error(failure),
            };
        }
        let owner = self.profile.clone();
        let current = match self.runtime.transact(move |ctx| owner.ensure(ctx)).await {
            Ok(current) => current,
            Err(failure) => return self.profile_error(failure),
        };
        let expected = match self.profile_version(request.headers(), &current) {
            Ok(version) => version,
            Err(failure) => return failure,
        };
        let owner = self.profile.clone();
        let result = if method == "DELETE" {
            self.runtime
                .transact(move |ctx| owner.delete_photo(ctx, Some(&expected)))
                .await
        } else {
            let content_type = request
                .headers()
                .get(hyper::header::CONTENT_TYPE)
                .and_then(|header| header.to_str().ok())
                .and_then(|value| value.split(';').next())
                .map(str::trim)
                .unwrap_or("")
                .to_owned();
            if !self
                .schemas
                .valid("ownerProfilePhotoType", &json!(content_type))
                .unwrap_or(false)
            {
                return error(
                    400,
                    "invalid_request",
                    "The profile photo must be a PNG, JPEG, or WebP image.",
                );
            }
            let bytes = match tokio::time::timeout(
                Duration::from_secs(30),
                Limited::new(request.into_body(), 8 * 1024 * 1024).collect(),
            )
            .await
            {
                Ok(Ok(body)) => body.to_bytes().to_vec(),
                _ => {
                    return error(
                        400,
                        "invalid_request",
                        "The profile photo is too large or incomplete.",
                    );
                }
            };
            let asset = match owner.normalize_photo(bytes, content_type).await {
                Ok(asset) => asset,
                Err(failure) => return error(400, "invalid_request", &failure.to_string()),
            };
            self.runtime
                .transact(move |ctx| owner.put_photo(ctx, &asset, Some(&expected)))
                .await
        };
        match result {
            Ok(profile) => response(200, json!({"profile":self.profile.resource(&profile)})),
            Err(failure) => self.profile_error(failure),
        }
    }
}
fn image_response(asset: ProfilePhotoAsset, cached: bool) -> Response<Body> {
    let bytes = if cached {
        Bytes::new()
    } else {
        Bytes::from(asset.bytes)
    };
    let mut response = Response::new(
        Full::new(bytes)
            .map_err(|never| match never {})
            .boxed_unsync(),
    );
    *response.status_mut() = if cached {
        StatusCode::NOT_MODIFIED
    } else {
        StatusCode::OK
    };
    let headers = response.headers_mut();
    headers.insert(
        hyper::header::ETAG,
        asset.metadata["etag"].as_str().unwrap().parse().unwrap(),
    );
    headers.insert(
        hyper::header::CACHE_CONTROL,
        hyper::header::HeaderValue::from_static(
            "private, max-age=3600, stale-while-revalidate=86400",
        ),
    );
    headers.insert(
        hyper::header::VARY,
        hyper::header::HeaderValue::from_static("Authorization"),
    );
    if !cached {
        headers.insert(
            hyper::header::CONTENT_TYPE,
            hyper::header::HeaderValue::from_static("image/webp"),
        );
    }
    response
}
