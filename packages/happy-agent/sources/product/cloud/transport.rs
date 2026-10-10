//! Bounded native WorkOS public-client and Happy Cloud HTTP wire operations.
use crate::product::{config::ConfigModule, schemas::Schemas};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::RngCore;
use reqwest::{Client, Method, Url};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;

#[derive(Debug, Clone)]
pub(super) enum RemoteError {
    Unavailable,
    CredentialsRejected,
    IdentityMismatch,
    InvalidOrganization,
    Forbidden,
    InvalidEndpoint,
    InvitationConflict(String),
}
impl std::fmt::Display for RemoteError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Unavailable => "Cloud authentication is temporarily unavailable.",
            Self::CredentialsRejected => "WorkOS rejected the Cloud credentials.",
            Self::IdentityMismatch => "Happy Cloud returned a different authenticated user.",
            Self::InvalidOrganization => "Happy Cloud rejected the organization request.",
            Self::Forbidden => "Happy Cloud rejected the organization operation.",
            Self::InvalidEndpoint => "Happy Cloud rejected the organization endpoint.",
            Self::InvitationConflict(_) => {
                "The recipient already has membership or a pending invitation."
            }
        })
    }
}
impl std::error::Error for RemoteError {}
type Result<T> = std::result::Result<T, RemoteError>;
pub(super) struct Boundary {
    client: Client,
    cloud: Url,
    workos: Url,
    pub client_id: String,
    schemas: Schemas,
}
struct Response {
    status: u16,
    body: Value,
}

impl Boundary {
    pub fn new(config: &ConfigModule, environment: &str) -> anyhow::Result<Self> {
        let schemas = Schemas::new()?;
        let deployment = config.cloud_deployment(environment)?;
        anyhow::ensure!(
            schemas.valid("cloudDeployment", &deployment)?,
            "The Cloud deployment is invalid."
        );
        let client = Client::builder()
            .no_proxy()
            .retry(reqwest::retry::never())
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| anyhow::anyhow!("Cloud authentication is temporarily unavailable."))?;
        Ok(Self {
            client,
            cloud: Url::parse(
                deployment["cloudUrl"]
                    .as_str()
                    .expect("validated deployment"),
            )?,
            workos: Url::parse(
                deployment["workosUrl"]
                    .as_str()
                    .expect("validated deployment"),
            )?,
            client_id: deployment["workosClientId"]
                .as_str()
                .expect("validated deployment")
                .to_owned(),
            schemas,
        })
    }
    pub fn authorization(&self, redirect: &str) -> Result<Value> {
        let mut random = [0u8; 32];
        rand::rng().fill_bytes(&mut random);
        let verifier = URL_SAFE_NO_PAD.encode(random);
        rand::rng().fill_bytes(&mut random);
        let state = URL_SAFE_NO_PAD.encode(random);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = self
            .workos
            .join("/user_management/authorize")
            .map_err(|_| RemoteError::Unavailable)?;
        url.query_pairs_mut().extend_pairs([
            ("code_challenge", challenge.as_str()),
            ("code_challenge_method", "S256"),
            ("provider", "authkit"),
            ("client_id", self.client_id.as_str()),
            ("redirect_uri", redirect),
            ("response_type", "code"),
            ("state", state.as_str()),
        ]);
        let authorization = json!({"codeVerifier":verifier,"state":state,"url":url.as_str()});
        if !self.valid("cloudAuthorizationSecret", &authorization) {
            return Err(RemoteError::Unavailable);
        }
        Ok(authorization)
    }
    pub async fn exchange(&self, code: &str, verifier: &str) -> Result<Value> {
        self.authenticate(json!({"grant_type":"authorization_code","client_id":self.client_id,"code":code,"code_verifier":verifier}),false).await
    }
    pub async fn refresh(&self, refresh: &str, organization: Option<&str>) -> Result<Value> {
        let mut body = json!({"grant_type":"refresh_token","client_id":self.client_id,"refresh_token":refresh});
        if let Some(organization) = organization {
            body["organization_id"] = json!(organization);
        }
        self.authenticate(body, true).await
    }
    async fn authenticate(&self, body: Value, refresh: bool) -> Result<Value> {
        let url = self
            .workos
            .join("/user_management/authenticate")
            .map_err(|_| RemoteError::Unavailable)?;
        let response = self
            .request(url, None, Method::POST, Some(body), &[], 1048576, true)
            .await?;
        if !(200..300).contains(&response.status) {
            // Match the SDK's OAuth classification. Specialized HTTP exceptions
            // never become evidence that a rotating credential was rejected.
            let oauth = !matches!(response.status, 401 | 409 | 422 | 404 | 429)
                && self.valid("cloudOAuthError", &response.body);
            let code = response.body["error"].as_str().unwrap_or("");
            if oauth
                && ((refresh && code == "invalid_grant")
                    || (!refresh
                        && response.status < 500
                        && response.status != 408
                        && matches!(code, "invalid_grant" | "access_denied")))
            {
                return Err(RemoteError::CredentialsRejected);
            }
            return Err(RemoteError::Unavailable);
        }
        if !self.valid("cloudAuthenticationWire", &response.body) {
            return Err(RemoteError::Unavailable);
        }
        let user = &response.body["user"];
        let authentication = json!({"accessToken":response.body["access_token"],"refreshToken":response.body["refresh_token"],"user":{"email":user["email"],"firstName":user["first_name"],"id":user["id"],"lastName":user["last_name"]}});
        if !self.valid("cloudAuthentication", &authentication) {
            return Err(RemoteError::Unavailable);
        }
        Ok(authentication)
    }
    pub async fn verify(&self, token: &str, user: &str) -> Result<()> {
        let response = self
            .cloud_request(&["v0", "hello"], token, Method::GET, None, &[], 8192)
            .await?;
        if !(200..300).contains(&response.status) || !self.valid("cloudHello", &response.body) {
            return Err(RemoteError::Unavailable);
        }
        if response.body["userId"] != user {
            return Err(RemoteError::IdentityMismatch);
        }
        Ok(())
    }
    pub async fn organizations(&self, token: &str, teams: bool) -> Result<Value> {
        let response = self
            .cloud_request(
                &["v0", "organizations"],
                token,
                Method::GET,
                None,
                &[],
                1048576,
            )
            .await?;
        if !(200..300).contains(&response.status)
            || !self.valid(
                if teams {
                    "cloudRemoteTeams"
                } else {
                    "cloudRemoteOrganizations"
                },
                &response.body,
            )
        {
            return Err(RemoteError::Unavailable);
        }
        let mut projected = Vec::new();
        for organization in response.body["organizations"]
            .as_array()
            .expect("validated roster")
        {
            let mut value = json!({"id":organization["id"],"name":organization["name"]});
            if teams {
                value["endpoint"] = self.team_endpoint(organization)?;
            }
            projected.push(value);
        }
        Ok(json!(projected))
    }
    pub async fn create_organization(&self, token: &str, name: &str, team: bool) -> Result<Value> {
        let response = self
            .cloud_request(
                &["v0", "organizations"],
                token,
                Method::POST,
                Some(json!({"name":name})),
                &[400],
                8192,
            )
            .await?;
        if response.status == 400 && self.valid("cloudInvalidOrganization", &response.body) {
            return Err(RemoteError::InvalidOrganization);
        }
        if !(200..300).contains(&response.status)
            || !self.valid(
                if team {
                    "cloudRemoteTeam"
                } else {
                    "cloudOrganization"
                },
                &response.body,
            )
        {
            return Err(RemoteError::Unavailable);
        }
        let mut value = json!({"id":response.body["id"],"name":response.body["name"]});
        if team {
            value["endpoint"] = self.team_endpoint(&response.body)?;
        }
        Ok(value)
    }
    pub async fn delete_organization(&self, token: &str, id: &str) -> Result<()> {
        let response = self
            .cloud_request(
                &["v0", "organizations", id],
                token,
                Method::DELETE,
                None,
                &[403, 404],
                8192,
            )
            .await?;
        if response.status == 403 && self.valid("cloudOrganizationForbidden", &response.body) {
            return Err(RemoteError::Forbidden);
        }
        if response.status == 404 && self.valid("cloudOrganizationNotFound", &response.body) {
            return Err(RemoteError::InvalidOrganization);
        }
        if !(200..300).contains(&response.status)
            || !self.valid("cloudOrganizationDeleted", &response.body)
        {
            return Err(RemoteError::Unavailable);
        }
        Ok(())
    }
    pub async fn endpoint(&self, token: &str, id: &str, endpoint: &str) -> Result<String> {
        let response = self
            .cloud_request(
                &["v0", "organizations", id, "endpoint"],
                token,
                Method::PUT,
                Some(json!({"endpoint":endpoint})),
                &[400, 403],
                8192,
            )
            .await?;
        if response.status == 400 && self.valid("cloudInvalidEndpoint", &response.body) {
            return Err(RemoteError::InvalidEndpoint);
        }
        if response.status == 403 && self.valid("cloudOrganizationForbidden", &response.body) {
            return Err(RemoteError::Forbidden);
        }
        if !(200..300).contains(&response.status)
            || !self.valid("cloudEndpointResponse", &response.body)
            || response.body["endpoint"] != endpoint
        {
            return Err(RemoteError::Unavailable);
        }
        Ok(endpoint.to_owned())
    }
    pub async fn invite(&self, token: &str, id: &str, email: &str) -> Result<Value> {
        let response = self
            .cloud_request(
                &["v0", "organizations", id, "invitations"],
                token,
                Method::POST,
                Some(json!({"email":email})),
                &[400, 403, 409],
                8192,
            )
            .await?;
        if response.status == 400 {
            return Err(RemoteError::InvalidOrganization);
        }
        if response.status == 403 {
            return Err(RemoteError::Forbidden);
        }
        if response.status == 409 && self.valid("cloudInvitationConflict", &response.body) {
            return Err(RemoteError::InvitationConflict(
                response.body["error"]
                    .as_str()
                    .expect("validated conflict")
                    .to_owned(),
            ));
        }
        if response.status != 201
            || !self.valid("cloudInvitationResponse", &response.body)
            || response.body["invitation"]["email"] != email
        {
            return Err(RemoteError::Unavailable);
        }
        Ok(response.body["invitation"].clone())
    }
    async fn cloud_request(
        &self,
        path: &[&str],
        token: &str,
        method: Method,
        body: Option<Value>,
        parsed_errors: &[u16],
        maximum: usize,
    ) -> Result<Response> {
        let mut url = self.cloud.clone();
        url.set_query(None);
        url.set_fragment(None);
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| RemoteError::Unavailable)?;
            segments.clear().extend(path);
        }
        self.request(
            url,
            Some(token),
            method,
            body,
            parsed_errors,
            maximum,
            false,
        )
        .await
    }
    async fn request(
        &self,
        url: Url,
        token: Option<&str>,
        method: Method,
        body: Option<Value>,
        parsed_errors: &[u16],
        maximum: usize,
        workos: bool,
    ) -> Result<Response> {
        let operation = async {
            let mut request = self.client.request(method, url);
            if let Some(token) = token {
                request = request.bearer_auth(token);
            }
            if let Some(body) = body {
                request = request.json(&body);
            }
            let mut response = request.send().await.map_err(|_| RemoteError::Unavailable)?;
            let status = response.status().as_u16();
            if !workos
                && (!(200..300).contains(&status) && !parsed_errors.contains(&status)
                    || status == 204)
            {
                return Ok(Response {
                    status,
                    body: Value::Null,
                });
            }
            if response
                .content_length()
                .is_some_and(|length| length > maximum as u64)
            {
                return Err(RemoteError::Unavailable);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| RemoteError::Unavailable)?
            {
                if bytes.len().saturating_add(chunk.len()) > maximum {
                    return Err(RemoteError::Unavailable);
                }
                bytes.extend_from_slice(&chunk);
            }
            let body = serde_json::from_slice(&bytes).map_err(|_| RemoteError::Unavailable)?;
            Ok(Response { status, body })
        };
        tokio::time::timeout(Duration::from_secs(15), operation)
            .await
            .map_err(|_| RemoteError::Unavailable)?
    }
    fn valid(&self, name: &str, value: &Value) -> bool {
        self.schemas.valid(name, value).unwrap_or(false)
    }
    fn team_endpoint(&self, team: &Value) -> Result<Value> {
        if team["endpoint"].is_null() {
            return Ok(Value::Null);
        }
        let endpoint = team["endpoint"].as_str().ok_or(RemoteError::Unavailable)?;
        if super::validation::endpoint(&self.schemas, endpoint).as_deref() != Some(endpoint) {
            return Err(RemoteError::Unavailable);
        }
        Ok(team["endpoint"].clone())
    }
}
