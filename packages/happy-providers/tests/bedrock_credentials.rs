//! Amazon Bedrock resolves AWS credentials like the AWS SDK for JavaScript: named profiles from
//! the shared config and credentials files, `credential_process` reused for its lifetime, and
//! environment keys only when no profile is selected. A Bedrock API key wins unless AWS
//! credentials were named.
//!
//! The AWS chain reads the process environment, so every test isolates it under one lock and
//! points it at temporary files; no host credentials or instance metadata are ever consulted.
use happy_providers::{Credential, CredentialSource, CredentialUnavailable};
use serde_json::json;
use std::path::Path;

static ENVIRONMENT: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

const CLEARED: &[&str] = &[
    "AWS_BEARER_TOKEN_BEDROCK",
    "TEAM_BEDROCK_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
];

/// Points the AWS chain at `config` and `credentials` files in `directory` and nothing else.
fn isolate(directory: &Path, config: &str, credentials: &str, environment: &[(&str, &str)]) {
    std::fs::write(directory.join("config"), config).unwrap();
    std::fs::write(directory.join("credentials"), credentials).unwrap();
    // SAFETY: every test touching the environment holds `ENVIRONMENT`, and this binary holds
    // only these tests.
    unsafe {
        for name in CLEARED {
            std::env::remove_var(name);
        }
        std::env::set_var("HOME", directory);
        std::env::set_var("AWS_CONFIG_FILE", directory.join("config"));
        std::env::set_var("AWS_SHARED_CREDENTIALS_FILE", directory.join("credentials"));
        std::env::set_var("AWS_EC2_METADATA_DISABLED", "true");
        for (name, value) in environment {
            std::env::set_var(name, value);
        }
    }
}

async fn load(profile: Option<&str>) -> anyhow::Result<Credential> {
    configured(json!({ "profile": profile })).await
}

async fn configured(mut fields: serde_json::Value) -> anyhow::Result<Credential> {
    fields["type"] = json!("aws");
    let source: CredentialSource = serde_json::from_value(fields).unwrap();
    Credential::load(source, "us-east-1").await
}

/// The Authorization header a request carries: a bearer API key or a SigV4 signature.
async fn authorization(credential: &Credential) -> String {
    let headers = credential
        .headers(
            "POST",
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
            b"{}",
            "us-east-1",
            "bedrock",
        )
        .await
        .unwrap();
    headers["authorization"].to_str().unwrap().to_owned()
}

fn unavailable(result: anyhow::Result<Credential>) -> bool {
    result
        .err()
        .is_some_and(|error| error.downcast_ref::<CredentialUnavailable>().is_some())
}

/// The access key ID a request was signed with, read from its SigV4 authorization header.
async fn signer(credential: &Credential) -> String {
    let headers = credential
        .headers(
            "POST",
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
            b"{}",
            "us-east-1",
            "bedrock",
        )
        .await
        .unwrap();
    let authorization = headers["authorization"].to_str().unwrap();
    let scope = authorization.split("Credential=").nth(1).unwrap();
    scope.split('/').next().unwrap().to_owned()
}

const PROFILES: &str = "\
[default]
aws_access_key_id = AKIDDEFAULT
aws_secret_access_key = default-secret

[work]
aws_access_key_id = AKIDWORK
aws_secret_access_key = work-secret
";

#[tokio::test]
async fn environment_keys_win_only_when_no_profile_is_selected() {
    let _environment = ENVIRONMENT.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let keys = [
        ("AWS_ACCESS_KEY_ID", "AKIDENVIRONMENT"),
        ("AWS_SECRET_ACCESS_KEY", "environment-secret"),
    ];
    isolate(directory.path(), "", PROFILES, &keys);
    assert_eq!(signer(&load(None).await.unwrap()).await, "AKIDENVIRONMENT");
    // A selected profile is isolated from ambient keys, whether named or set through AWS_PROFILE.
    assert_eq!(signer(&load(Some("work")).await.unwrap()).await, "AKIDWORK");
    isolate(
        directory.path(),
        "",
        PROFILES,
        &[keys[0], keys[1], ("AWS_PROFILE", "work")],
    );
    assert_eq!(signer(&load(None).await.unwrap()).await, "AKIDWORK");
    isolate(directory.path(), "", PROFILES, &[]);
    assert_eq!(signer(&load(None).await.unwrap()).await, "AKIDDEFAULT");

    // A named profile that does not exist fails by name and never borrows another identity.
    let error = load(Some("absent")).await.err().unwrap().to_string();
    assert_eq!(
        error,
        "Could not load AWS credentials for Amazon Bedrock profile \"absent\"."
    );
    isolate(directory.path(), "", PROFILES, &keys);
    assert!(load(Some("absent")).await.is_err());
    assert!(
        load(Some("  "))
            .await
            .err()
            .unwrap()
            .downcast_ref::<CredentialUnavailable>()
            .is_some()
    );
    // With nothing configured at all, Bedrock is simply unavailable.
    isolate(directory.path(), "", "", &[]);
    assert!(
        load(None)
            .await
            .err()
            .unwrap()
            .downcast_ref::<CredentialUnavailable>()
            .is_some()
    );
}

#[tokio::test]
async fn named_profiles_merge_the_shared_config_and_credentials_files() {
    let _environment = ENVIRONMENT.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let config = "\
[default]
region = us-west-2

[profile work]
region = eu-west-1

[profile staging]
aws_access_key_id = AKIDSTAGING
aws_secret_access_key = staging-secret

[profile tokened]
region = us-east-1
";
    let credentials = format!(
        "{PROFILES}
[tokened]
aws_access_key_id = AKIDTOKENED
aws_secret_access_key = tokened-secret
aws_session_token = tokened-session
"
    );
    isolate(directory.path(), config, &credentials, &[]);
    assert_eq!(signer(&load(Some("work")).await.unwrap()).await, "AKIDWORK");
    assert_eq!(
        signer(&load(Some("staging")).await.unwrap()).await,
        "AKIDSTAGING"
    );
    let tokened = load(Some("tokened")).await.unwrap();
    let headers = tokened
        .headers(
            "POST",
            "https://bedrock-runtime.us-east-1.amazonaws.com/model/test/invoke",
            b"{}",
            "us-east-1",
            "bedrock",
        )
        .await
        .unwrap();
    assert_eq!(headers["x-amz-security-token"], "tokened-session");
    assert!(!format!("{tokened:?}").contains("secret"));
}

#[cfg(unix)]
/// A `credential_process` script that counts its runs and reports keys expiring after `seconds`.
fn process(directory: &Path, name: &str, seconds: i64, exit: i32) -> String {
    let expiration = (time::OffsetDateTime::now_utc() + time::Duration::seconds(seconds))
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap();
    let output = json!({
        "Version": 1,
        "AccessKeyId": format!("AKID{}", name.to_uppercase()),
        "SecretAccessKey": "process-secret",
        "SessionToken": "process-session",
        "Expiration": expiration,
    });
    let script = directory.join(format!("{name}.sh"));
    let runs = directory.join(format!("{name}.runs"));
    std::fs::write(
        &script,
        format!(
            "echo run >> '{}'\necho '{output}'\nexit {exit}\n",
            runs.display()
        ),
    )
    .unwrap();
    format!(
        "[profile {name}]\ncredential_process = sh '{}'\n",
        script.display()
    )
}

#[cfg(unix)]
fn runs(directory: &Path, name: &str) -> usize {
    std::fs::read_to_string(directory.join(format!("{name}.runs")))
        .map(|runs| runs.lines().count())
        .unwrap_or(0)
}

// The fixture processes are POSIX shell scripts.
#[cfg(unix)]
#[tokio::test]
async fn credential_process_profiles_run_once_per_credential_lifetime() {
    let _environment = ENVIRONMENT.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let config = [
        process(directory.path(), "lasting", 3600, 0),
        process(directory.path(), "expiring", 120, 0),
        process(directory.path(), "failing", 3600, 1),
    ]
    .join("\n");
    let keys = [
        ("AWS_ACCESS_KEY_ID", "AKIDENVIRONMENT"),
        ("AWS_SECRET_ACCESS_KEY", "environment-secret"),
    ];
    isolate(directory.path(), &config, "", &keys);

    let lasting = load(Some("lasting")).await.unwrap();
    assert_eq!(signer(&lasting).await, "AKIDLASTING");
    let (first, second) = tokio::join!(signer(&lasting), signer(&lasting));
    assert_eq!(
        (first.as_str(), second.as_str()),
        ("AKIDLASTING", "AKIDLASTING")
    );
    assert_eq!(
        runs(directory.path(), "lasting"),
        1,
        "valid process credentials are reused"
    );

    // Keys inside the five-minute renewal window are fetched again before each use.
    let expiring = load(Some("expiring")).await.unwrap();
    assert_eq!(signer(&expiring).await, "AKIDEXPIRING");
    assert_eq!(runs(directory.path(), "expiring"), 2);

    // A failing process names the profile and never echoes what the process printed.
    let error = load(Some("failing")).await.err().unwrap().to_string();
    assert_eq!(
        error,
        "Could not load AWS credentials for Amazon Bedrock profile \"failing\"."
    );
    assert!(!error.contains("process-secret") && !error.contains("AKIDFAILING"));
    assert_eq!(runs(directory.path(), "failing"), 1);
}

#[tokio::test]
async fn a_bedrock_api_key_wins_unless_aws_credentials_are_named() {
    let _environment = ENVIRONMENT.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let keys = [
        ("AWS_ACCESS_KEY_ID", "AKIDENVIRONMENT"),
        ("AWS_SECRET_ACCESS_KEY", "environment-secret"),
    ];
    let environment = [
        keys[0],
        keys[1],
        ("AWS_BEARER_TOKEN_BEDROCK", "ambient-api-key"),
    ];
    isolate(directory.path(), "", PROFILES, &environment);

    let configured_key = configured(json!({ "bearer_token": " configured-api-key " }));
    assert_eq!(
        authorization(&configured_key.await.unwrap()).await,
        "Bearer configured-api-key"
    );
    assert_eq!(
        authorization(&configured(json!({})).await.unwrap()).await,
        "Bearer ambient-api-key"
    );
    let named = configured(json!({ "profile": "work", "bearer_token": "configured-api-key" }));
    assert_eq!(signer(&named.await.unwrap()).await, "AKIDWORK");
    let debug = format!(
        "{:?}",
        serde_json::from_value::<CredentialSource>(
            json!({ "type": "aws", "bearer_token": "configured-api-key" })
        )
        .unwrap()
    );
    assert!(!debug.contains("configured-api-key"));

    // An isolated account reads only the variable it names, and never the default chain.
    let isolated = json!({ "ambient": false, "bearer_token_env_var": "TEAM_BEDROCK_KEY" });
    assert!(unavailable(configured(isolated.clone()).await));
    isolate(
        directory.path(),
        "",
        PROFILES,
        &[
            environment[0],
            environment[1],
            environment[2],
            ("TEAM_BEDROCK_KEY", "team-api-key"),
        ],
    );
    assert_eq!(
        authorization(&configured(isolated).await.unwrap()).await,
        "Bearer team-api-key"
    );
    assert!(unavailable(configured(json!({ "ambient": false })).await));

    // A configured API key that is missing does not fall back to ambient AWS keys.
    isolate(directory.path(), "", PROFILES, &keys);
    assert!(unavailable(
        configured(json!({ "bearer_token_env_var": "TEAM_BEDROCK_KEY" })).await
    ));
    assert_eq!(
        signer(&configured(json!({})).await.unwrap()).await,
        "AKIDENVIRONMENT"
    );
}

#[tokio::test]
async fn configured_shared_files_select_their_default_profile_over_ambient_keys() {
    let _environment = ENVIRONMENT.lock().await;
    let directory = tempfile::tempdir().unwrap();
    let keys = [
        ("AWS_ACCESS_KEY_ID", "AKIDENVIRONMENT"),
        ("AWS_SECRET_ACCESS_KEY", "environment-secret"),
        ("AWS_BEARER_TOKEN_BEDROCK", "ambient-api-key"),
    ];
    // The default locations hold an identity that a configured file must never borrow.
    isolate(
        directory.path(),
        "",
        "[default]\naws_access_key_id = AKIDAMBIENTFILE\naws_secret_access_key = ambient-secret\n",
        &keys,
    );
    let team = directory.path().join("team");
    std::fs::create_dir(&team).unwrap();
    std::fs::write(team.join("credentials"), PROFILES).unwrap();
    std::fs::write(team.join("config"), "[profile staging]\naws_access_key_id = AKIDSTAGING\naws_secret_access_key = staging-secret\n").unwrap();

    let credentials_file = configured(json!({ "credentials_file": team.join("credentials") }));
    assert_eq!(
        signer(&credentials_file.await.unwrap()).await,
        "AKIDDEFAULT"
    );
    let named =
        configured(json!({ "credentials_file": team.join("credentials"), "profile": "work" }));
    assert_eq!(signer(&named.await.unwrap()).await, "AKIDWORK");
    let config_file = configured(
        json!({ "config_file": team.join("config"), "profile": "staging", "ambient": false }),
    );
    assert_eq!(signer(&config_file.await.unwrap()).await, "AKIDSTAGING");
    // A configured config file still reads the default credentials file, as the AWS SDK does.
    let fallback = configured(json!({ "config_file": team.join("config") }));
    assert_eq!(signer(&fallback.await.unwrap()).await, "AKIDAMBIENTFILE");

    let missing = configured(json!({ "credentials_file": team.join("absent") })).await;
    assert_eq!(
        missing.err().unwrap().to_string(),
        "Could not load AWS credentials for Amazon Bedrock profile \"default\"."
    );
}
