//! Amazon Bedrock credentials resolved the way the AWS SDK for JavaScript's default chain does.
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
use std::time::{Duration, SystemTime};

/// Expiring credentials are renewed this long before AWS would reject them.
const EARLY_REFRESH: Duration = Duration::from_secs(5 * 60);
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);

/// Resolves the chain once so a loaded credential is usable, as the TypeScript provider did.
///
/// A selected profile, named here or through `AWS_PROFILE`, never falls back to environment
/// access keys; those win only when no profile is selected.
pub(super) async fn provider(
    profile: Option<&str>,
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
