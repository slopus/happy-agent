use happy_providers::{Credential,CredentialSource};
#[tokio::test]
async fn grok_stored_api_key_precedes_the_stored_oauth_session() {
    let directory=tempfile::tempdir().unwrap();let file=directory.path().join("auth.json");
    std::fs::write(&file,r#"{"xai::api_key":{"key":"source-api-key"},"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":{"key":"source-oauth-session"}}"#).unwrap();
    let source:CredentialSource=serde_json::from_value(serde_json::json!({"type":"grok","auth_file":file})).unwrap();
    let credential=Credential::load(source,"us-east-1").await.unwrap();
    let headers=credential.headers("POST","https://api.x.ai/v1/responses",&[],"us-east-1","").await.unwrap();
    assert_eq!(headers["authorization"],"Bearer source-api-key");
}
#[tokio::test]
async fn isolated_codex_subscription_preserves_nullable_fields_and_jwt_account_identity() {
    use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};
    let directory=tempfile::tempdir().unwrap();let file=directory.path().join("auth.json");
    let claims=URL_SAFE_NO_PAD.encode(br#"{"https://api.openai.com/auth":{"chatgpt_account_id":"source-account"}}"#);
    std::fs::write(&file,serde_json::json!({"OPENAI_API_KEY":null,"tokens":{"access_token":"source-subscription","account_id":null,"id_token":format!("header.{claims}.signature")}}).to_string()).unwrap();
    let source=serde_json::from_value(serde_json::json!({"type":"codex","auth_file":file,"ambient":false})).unwrap();
    let credential=Credential::load(source,"us-east-1").await.unwrap();assert!(credential.is_codex_session().await);
    let headers=credential.headers("POST","https://chatgpt.com/backend-api/codex/responses",&[],"us-east-1","").await.unwrap();assert_eq!(headers["authorization"],"Bearer source-subscription");assert_eq!(headers["chatgpt-account-id"],"source-account");
    std::fs::write(&file,r#"{"auth_mode":"apikey","OPENAI_API_KEY":"stored-metered-key","tokens":null}"#).unwrap();
    let source=serde_json::from_value(serde_json::json!({"type":"codex","auth_file":file,"ambient":false})).unwrap();
    assert!(Credential::load(source,"us-east-1").await.unwrap_err().downcast_ref::<happy_providers::CredentialUnavailable>().is_some(),"The isolated Source account only accepts its explicitly named subscription file.");
}
#[tokio::test]
async fn isolated_claude_credentials_keep_source_priority_and_file_discovery() {
    let directory=tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join(".credentials.json"),r#"{"claudeAiOauth":{"accessToken":"source-file-oauth","refreshToken":"unused"}}"#).unwrap();
    for (input,token,mode) in [
        (serde_json::json!({"oauth_token":"source-oauth","api_key":"source-api-key","auth_token":"source-auth-token","config_dir":directory.path()}),"source-oauth",(true,true)),
        (serde_json::json!({"api_key":"source-api-key","auth_token":"source-auth-token","config_dir":directory.path()}),"source-api-key",(false,false)),
        (serde_json::json!({"auth_token":"source-auth-token","config_dir":directory.path()}),"source-auth-token",(true,false)),
        (serde_json::json!({"config_dir":directory.path()}),"source-file-oauth",(true,true)),
    ] {
        let mut input=input;input["type"]=serde_json::json!("claude");input["ambient"]=serde_json::json!(false);
        let credential=Credential::load(serde_json::from_value(input).unwrap(),"us-east-1").await.unwrap();assert_eq!(credential.anthropic_api_key().await,token);assert_eq!(credential.anthropic_authentication().await,mode);
    }
    let credential:CredentialSource=serde_json::from_value(serde_json::json!({"type":"claude","ambient":false})).unwrap();assert!(Credential::load(credential,"us-east-1").await.unwrap_err().downcast_ref::<happy_providers::CredentialUnavailable>().is_some());
}