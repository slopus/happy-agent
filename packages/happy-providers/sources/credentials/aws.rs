//! Amazon Bedrock credentials: an API key, or AWS credentials resolved the way the AWS SDK for
//! JavaScript's default chain does.
use super::CredentialUnavailable;
use aws_config::{
    Region, default_provider::credentials::DefaultCredentialsChain, ecs::EcsCredentialsProvider,
    imds::credentials::ImdsCredentialsProvider, meta::credentials::CredentialsProviderChain,
    profile::ProfileFileCredentialsProvider, provider_config::ProviderConfig,
    web_identity_token::WebIdentityTokenCredentialsProvider,
};
use aws_credential_types::{
    Credentials,
    provider::{ProvideCredentials, SharedCredentialsProvider, future},
};
use std::{
    path::Path,
    time::{Duration, SystemTime},
};

/// Expiring credentials are renewed this long before AWS would reject them.
const EARLY_REFRESH: Duration = Duration::from_secs(5 * 60);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);
const BEARER_TOKEN_VARIABLE: &str = "AWS_BEARER_TOKEN_BEDROCK";

/// How a Bedrock account was configured.
pub(super) struct Selection<'a> {
    pub(super) profile: Option<&'a str>,
    pub(super) config_file: Option<&'a Path>,
    pub(super) credentials_file: Option<&'a Path>,
    pub(super) bearer_token: Option<&'a str>,
    pub(super) bearer_token_env_var: Option<&'a str>,
    /// Whether ambient credentials, from the environment or the default AWS chain, may be used.
    pub(super) ambient: bool,
}

pub(super) enum Resolved {
    /// A Bedrock API key, sent as a bearer token.
    Bearer(String),
    /// AWS credentials that sign each request.
    Signed(SharedCredentialsProvider),
}

/// Naming a profile or either shared file selects AWS credentials and nothing else; otherwise an
/// API key wins, then the default AWS chain when ambient credentials are allowed and no API key
/// was configured.
pub(super) async fn resolve(selection: &Selection<'_>, region: &str) -> anyhow::Result<Resolved> {
    let explicit_files = selection.config_file.is_some() || selection.credentials_file.is_some();
    let explicit_aws = explicit_files || selection.profile.is_some();
    if !explicit_aws {
        if let Some(token) = selection
            .bearer_token
            .map(str::trim)
            .filter(|token| !token.is_empty())
        {
            return Ok(Resolved::Bearer(token.to_owned()));
        }
        // An isolated account reads only the variable it names.
        let variable = selection
            .bearer_token_env_var
            .unwrap_or(BEARER_TOKEN_VARIABLE);
        if (selection.ambient || selection.bearer_token_env_var.is_some())
            && let Ok(token) = std::env::var(variable)
            && !token.trim().is_empty()
        {
            return Ok(Resolved::Bearer(token));
        }
    }
    let explicit_bearer =
        selection.bearer_token.is_some() || selection.bearer_token_env_var.is_some();
    if !explicit_aws && (!selection.ambient || explicit_bearer) {
        return Err(CredentialUnavailable.into());
    }
    // Naming either shared file selects its default profile, so ambient keys cannot win.
    let profile = selection.profile.or(explicit_files.then_some("default"));
    let files = (selection.config_file, selection.credentials_file);
    Ok(Resolved::Signed(provider(profile, files, region).await?))
}

/// Resolves the chain once so a loaded credential is usable, as the TypeScript provider did.
///
/// A selected profile, named here or through `AWS_PROFILE`, never falls back to environment
/// access keys; those win only when no profile is selected.
async fn provider(
    profile: Option<&str>,
    (config_file, credentials_file): (Option<&Path>, Option<&Path>),
    region: &str,
) -> anyhow::Result<SharedCredentialsProvider> {
    let named = match profile {
        Some(profile) if profile.trim().is_empty() => return Err(CredentialUnavailable.into()),
        Some(profile) => Some(profile.trim().to_owned()),
        None => std::env::var("AWS_PROFILE")
            .ok()
            .filter(|profile| !profile.trim().is_empty()),
    };
    let region = Region::new(region.to_owned());
    let chain = match &named {
        None => SharedCredentialsProvider::new(
            DefaultCredentialsChain::builder()
                .region(region)
                .build()
                .await,
        ),
        Some(name) => {
            let conf = ProviderConfig::default().with_region(Some(region));
            SharedCredentialsProvider::new(
                CredentialsProviderChain::first_try(
                    "Profile",
                    ProfileFileCredentialsProvider::builder()
                        .configure(&conf)
                        .profile_files(profile_files(config_file, credentials_file))
                        .profile_name(name)
                        .build(),
                )
                .or_else(
                    "WebIdentityToken",
                    WebIdentityTokenCredentialsProvider::builder()
                        .configure(&conf)
                        .build(),
                )
                .or_else(
                    "EcsContainer",
                    EcsCredentialsProvider::builder().configure(&conf).build(),
                )
                .or_else(
                    "Ec2InstanceMetadata",
                    ImdsCredentialsProvider::builder().configure(&conf).build(),
                ),
            )
        }
    };
    let provider = SharedCredentialsProvider::new(Memoized {
        chain,
        cached: tokio::sync::Mutex::default(),
    });
    let resolved = tokio::time::timeout(RESOLVE_TIMEOUT, provider.provide_credentials()).await;
    match (resolved, profile) {
        (Ok(Ok(_)), _) => Ok(provider),
        // The cause can echo profile contents or process output, so it is never surfaced.
        (_, Some(profile)) => Err(anyhow::anyhow!(
            "Could not load AWS credentials for Amazon Bedrock profile \"{}\".",
            profile.trim()
        )),
        (_, None) => Err(CredentialUnavailable.into()),
    }
}

/// The configured shared files, each falling back to its default location when not named.
// `EnvConfigFiles` is reachable only through these aliases without depending on aws-runtime.
#[allow(deprecated)]
fn profile_files(
    config_file: Option<&Path>,
    credentials_file: Option<&Path>,
) -> aws_config::profile::profile_file::ProfileFiles {
    use aws_config::profile::profile_file::{ProfileFileKind, ProfileFiles};
    let mut files = ProfileFiles::builder()
        .include_default_config_file(config_file.is_none())
        .include_default_credentials_file(credentials_file.is_none());
    if let Some(path) = config_file {
        files = files.with_file(ProfileFileKind::Config, path);
    }
    if let Some(path) = credentials_file {
        files = files.with_file(ProfileFileKind::Credentials, path);
    }
    files.build()
}

/// Reuses resolved credentials until they near expiry, so a `credential_process` runs once per
/// lifetime instead of once per request, and concurrent requests share one resolution.
#[derive(Debug)]
struct Memoized {
    chain: SharedCredentialsProvider,
    cached: tokio::sync::Mutex<Option<Credentials>>,
}

impl ProvideCredentials for Memoized {
    fn provide_credentials<'a>(&'a self) -> future::ProvideCredentials<'a>
    where
        Self: 'a,
    {
        future::ProvideCredentials::new(async move {
            let mut cached = self.cached.lock().await;
            let fresh = |credentials: &&Credentials| {
                credentials
                    .expiry()
                    .is_none_or(|expiry| expiry > SystemTime::now() + EARLY_REFRESH)
            };
            if let Some(credentials) = cached.as_ref().filter(fresh) {
                return Ok(credentials.clone());
            }
            let credentials = self.chain.provide_credentials().await?;
            *cached = Some(credentials.clone());
            Ok(credentials)
        })
    }
}
