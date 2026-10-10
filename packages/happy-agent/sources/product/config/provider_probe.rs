//! Local credential discovery never runs AWS's process or network credential chain.
use super::*;
use anyhow::Context as _;
use std::collections::BTreeSet;
impl ConfigModule {
    pub async fn probe_local_provider_credentials(&self,id:&str)->Result<bool> {
        if self.provider_type(id)==Some("smart") {
            let accounts=self.smart_route(id)?.into_iter().flat_map(|route|route.models).flat_map(|model|model.accounts).collect::<BTreeSet<_>>();
            for account in accounts {if self.probe_concrete_provider(&account).await? {return Ok(true);}}
            return Ok(false);
        }
        self.probe_concrete_provider(id).await
    }
    async fn probe_concrete_provider(&self,id:&str)->Result<bool> {
        let Some(kind)=self.provider_type(id) else{return Ok(false);};
        if kind=="bedrock" {return self.local_bedrock_credential(id).await;}
        let Some(model)=self.catalogs[kind].as_array().and_then(|models|models.first()).and_then(|model|model["id"].as_str()) else{return Ok(false);};
        let (_,configuration)=match self.concrete_configuration(&serde_json::json!({"provider":id,"model":model}),false){Ok(value)=>value,Err(_)=>return Ok(false)};
        match happy_providers::Credential::load(configuration.credential,&configuration.region).await {
            Ok(_)=>Ok(true),
            Err(error) if error.downcast_ref::<happy_providers::CredentialUnavailable>().is_some()=>Ok(false),
            Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|error|error.kind()==std::io::ErrorKind::NotFound)=>Ok(false),
            Err(error)=>Err(error),
        }
    }
    async fn local_bedrock_credential(&self,id:&str)->Result<bool> {
        let entry=&self.values["providers"][id];let field=|name:&str|entry.get(name).and_then(toml::Value::as_str);
        let nonempty=|value:Option<&str>|value.is_some_and(|value|!value.trim().is_empty());
        let environment=|name:&str|std::env::var(name).ok().filter(|value|!value.trim().is_empty());
        if nonempty(field("bearer_token"))||field("bearer_token_env_var").is_some_and(|name|environment(name).is_some()){return Ok(true);}
        let explicit=[field("credentials_file"),field("config_file")].into_iter().flatten().map(PathBuf::from).collect::<Vec<_>>();
        if aws_files(&explicit).await?{return Ok(true);}
        if entry.get("credential_isolation").and_then(toml::Value::as_bool)==Some(true){return Ok(false);}
        if environment("AWS_BEARER_TOKEN_BEDROCK").is_some()
            || environment("AWS_ACCESS_KEY_ID").is_some()&&environment("AWS_SECRET_ACCESS_KEY").is_some()
            || environment("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI").is_some()
            || environment("AWS_CONTAINER_CREDENTIALS_FULL_URI").is_some(){return Ok(true);}
        if let Some(file)=environment("AWS_WEB_IDENTITY_TOKEN_FILE").filter(|_|environment("AWS_ROLE_ARN").is_some()) {if nonempty_file(Path::new(&file)).await? {return Ok(true);}}
        aws_files(&[environment("AWS_SHARED_CREDENTIALS_FILE").map(PathBuf::from).unwrap_or_else(||self.os_home.join(".aws/credentials")),environment("AWS_CONFIG_FILE").map(PathBuf::from).unwrap_or_else(||self.os_home.join(".aws/config"))]).await
    }
}
async fn nonempty_file(path:&Path)->Result<bool>{match tokio::fs::metadata(path).await{Ok(metadata)=>Ok(metadata.len()>0),Err(error) if matches!(error.kind(),std::io::ErrorKind::NotFound|std::io::ErrorKind::NotADirectory)=>Ok(false),Err(error)=>Err(error.into())}}
async fn aws_files(paths:&[PathBuf])->Result<bool>{
    use tokio::io::AsyncReadExt;
    for path in paths {
        let file=match tokio::fs::File::open(path).await{Ok(file)=>file,Err(error) if matches!(error.kind(),std::io::ErrorKind::NotFound|std::io::ErrorKind::NotADirectory)=>continue,Err(error)=>return Err(error.into())};
        let mut bytes=Vec::new();file.take(256*1024).read_to_end(&mut bytes).await.context("The local AWS credential configuration could not be read.")?;
        let source=String::from_utf8_lossy(&bytes);
        let assignment=|key:&str|source.lines().any(|line|{let Some((name,value))=line.trim_start().split_once('=') else{return false;};name.trim_end().eq_ignore_ascii_case(key)&&!value.trim_start().is_empty()});
        if assignment("aws_access_key_id")&&assignment("aws_secret_access_key")||["credential_process","web_identity_token_file","sso_start_url","sso_session"].into_iter().any(assignment){return Ok(true);}
    }
    Ok(false)
}