//! The shipped credential order, with bounded local reads and no inference.
use super::{Auth,CredentialUnavailable,native_auth_path};
use anyhow::{Context,Result};
use base64::{Engine,engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::Value;
use std::{collections::BTreeMap,path::{Path,PathBuf},sync::OnceLock};
use tokio::io::AsyncReadExt;
fn valid(name:&str,value:&Value)->Result<bool> {
    static SCHEMAS:OnceLock<BTreeMap<String,jsonschema::Validator>>=OnceLock::new();
    let schemas=SCHEMAS.get_or_init(||{let sources:BTreeMap<String,Value>=serde_json::from_str(include_str!("schemas.json")).expect("Captured credential schemas");sources.into_iter().map(|(name,schema)|(name,jsonschema::validator_for(&schema).expect("Valid TypeBox credential schema"))).collect()});
    Ok(schemas.get(name).context("The credential schema is unavailable.")?.is_valid(value))
}
async fn read(path:&Path)->Result<Option<Vec<u8>>> {
    let path=path.to_owned();
    let opened=tokio::task::spawn_blocking(move||{let mut options=std::fs::OpenOptions::new();options.read(true);#[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.custom_flags(libc::O_NONBLOCK);}options.open(path)}).await?;
    let file=match opened {Ok(file)=>tokio::fs::File::from_std(file),Err(error) if error.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(error)=>return Err(error.into())};
    let mut bytes=Vec::new();file.take(1_048_577).read_to_end(&mut bytes).await?;
    anyhow::ensure!(bytes.len()<=1_048_576,"The local credential file exceeds its size limit.");Ok(Some(bytes))
}
fn environment(name:&str,ambient:bool)->Option<String>{ambient.then(||std::env::var(name).ok()).flatten().map(|value|value.trim().to_owned()).filter(|value|!value.is_empty())}
fn explicit(value:Option<&str>)->Option<String>{value.map(str::trim).filter(|value|!value.is_empty()).map(str::to_owned)}
pub(super) async fn codex(path:Option<&Path>,ambient:bool)->Result<Auth> {
    if !ambient&&path.is_none(){return Err(CredentialUnavailable.into());}
    let file=match path{Some(path)=>path.to_owned(),None=>native_auth_path("CODEX_HOME",".codex")?};
    let auth=match read(&file).await? {Some(bytes)=>{let value:Value=serde_json::from_slice(&bytes)?;valid("codexAuth",&value)?.then_some(value)},None=>None};
    if let Some(auth)=&auth {if auth["auth_mode"]!="apikey"&&let Some(token)=auth["tokens"]["access_token"].as_str().filter(|token|!token.is_empty()) {
        let account=auth["tokens"]["account_id"].as_str().filter(|value|!value.is_empty()).map(str::to_owned).or_else(||[auth["tokens"]["id_token"].as_str(),Some(token)].into_iter().flatten().find_map(account_claim));
        return Ok(Auth{token:token.to_owned(),account,file:Some(file),original:Some(auth.clone()),codex_session:true,..Auth::default()});
    }}
    if let Some(token)=environment("OPENAI_API_KEY",ambient){return Ok(Auth{token,..Auth::default()});}
    if ambient&&let Some(token)=auth.as_ref().filter(|auth|auth["auth_mode"]=="apikey").and_then(|auth|auth["OPENAI_API_KEY"].as_str()).and_then(|token|explicit(Some(token))){return Ok(Auth{token,..Auth::default()});}
    Err(CredentialUnavailable.into())
}
fn account_claim(token:&str)->Option<String> {
    let decoded=URL_SAFE_NO_PAD.decode(token.split('.').nth(1)?.trim_end_matches('=')).ok()?;let value:Value=serde_json::from_slice(&decoded).ok()?;
    if !valid("codexClaims",&value).ok()?{return None;}
    value["https://api.openai.com/auth"]["chatgpt_account_id"].as_str().filter(|id|!id.is_empty()).map(str::to_owned)
}
pub(super) async fn grok(path:Option<&Path>,ambient:bool)->Result<Auth> {
    if let Some(token)=environment("XAI_API_KEY",ambient){return Ok(Auth{token,..Auth::default()});}
    if !ambient&&path.is_none(){return Err(CredentialUnavailable.into());}
    let file=match path{Some(path)=>path.to_owned(),None=>native_auth_path("GROK_HOME",".grok")?};
    let Some(bytes)=read(&file).await? else{return Err(CredentialUnavailable.into());};
    if bytes.iter().all(u8::is_ascii_whitespace){return Err(CredentialUnavailable.into());}
    let value:Value=serde_json::from_slice(&bytes)?;
    if valid("grokAuth",&value)? {for key in ["xai::api_key","https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828"] {if valid("grokRecord",&value[key])?&&let Some(token)=value[key]["key"].as_str().filter(|token|!token.trim().is_empty()){return Ok(Auth{token:token.to_owned(),file:Some(file),original:Some(value),..Auth::default()});}}}
    Err(CredentialUnavailable.into())
}
pub(super) async fn grok_account(path:Option<&Path>,ambient:bool)->Result<Auth> {
    if !ambient&&path.is_none(){return Err(CredentialUnavailable.into());}
    let file=match path{Some(path)=>path.to_owned(),None=>native_auth_path("GROK_HOME",".grok")?};
    let Some(bytes)=read(&file).await?else{return Err(CredentialUnavailable.into());};
    if bytes.iter().all(u8::is_ascii_whitespace){return Err(CredentialUnavailable.into());}
    let value:Value=serde_json::from_slice(&bytes)?;let scope="https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
    if valid("grokAuth",&value)?&&valid("grokRecord",&value[scope])?&&let Some(token)=value[scope]["key"].as_str().filter(|token|!token.trim().is_empty()){return Ok(Auth{token:token.to_owned(),file:Some(file),original:Some(value),..Auth::default()});}
    Err(CredentialUnavailable.into())
}
pub(super) async fn claude_account(oauth:Option<&str>,directory:Option<&Path>,ambient:bool)->Result<Auth> {
    if let Some(token)=explicit(oauth).or_else(||if oauth.is_none(){environment("CLAUDE_CODE_OAUTH_TOKEN",ambient)}else{None}){return Ok(Auth{token,claude_bearer:true,claude_oauth:true,..Auth::default()});}
    claude_file(directory,ambient).await
}
pub(super) async fn claude(oauth:Option<&str>,api_key:Option<&str>,auth_token:Option<&str>,directory:Option<&Path>,ambient:bool)->Result<Auth> {
    if let Some(token)=explicit(oauth).or_else(||if oauth.is_none(){environment("CLAUDE_CODE_OAUTH_TOKEN",ambient)}else{None}){return Ok(Auth{token,claude_bearer:true,claude_oauth:true,..Auth::default()});}
    if let Some(token)=explicit(api_key).or_else(||if api_key.is_none(){environment("ANTHROPIC_API_KEY",ambient)}else{None}){return Ok(Auth{token,..Auth::default()});}
    if let Some(token)=explicit(auth_token){return Ok(Auth{token,claude_bearer:true,..Auth::default()});}
    claude_file(directory,ambient).await
}
async fn claude_file(directory:Option<&Path>,ambient:bool)->Result<Auth>{
    if !ambient&&directory.is_none(){return Err(CredentialUnavailable.into());}
    #[cfg(target_os="macos")]
    let custom_directory=directory.is_some()||std::env::var_os("CLAUDE_CONFIG_DIR").is_some();
    let directory=match directory.map(Path::to_owned).or_else(||environment("CLAUDE_CONFIG_DIR",ambient).map(PathBuf::from)){Some(directory)=>directory,None=>native_auth_path("CLAUDE_CONFIG_DIR",".claude")?.parent().context("The Claude configuration directory is unavailable.")?.to_owned()};
    #[cfg(target_os="macos")]
    if let Some(token)=keychain(&directory,custom_directory).await?{return Ok(Auth{token,claude_bearer:true,claude_oauth:true,..Auth::default()});}
    if let Some(bytes)=read(&directory.join(".credentials.json")).await?&&let Some(token)=claude_token(&bytes)?{return Ok(Auth{token,claude_bearer:true,claude_oauth:true,..Auth::default()});}
    Err(CredentialUnavailable.into())
}
fn claude_token(bytes:&[u8])->Result<Option<String>>{let Ok(value)=serde_json::from_slice::<Value>(bytes) else{return Ok(None);};if !valid("claudeAuth",&value)? {return Ok(None);}Ok(value["claudeAiOauth"]["accessToken"].as_str().filter(|token|!token.trim().is_empty()).map(str::to_owned))}
#[cfg(target_os="macos")]
async fn keychain(directory:&Path,custom:bool)->Result<Option<String>> {
    use sha2::{Digest,Sha256};use std::{process::Stdio,time::Duration};
    let suffix=if custom{format!("-{}",&format!("{:x}",Sha256::digest(directory.to_string_lossy().as_bytes()))[..8])}else{String::new()};
    let oauth=if std::env::var_os("CLAUDE_CODE_CUSTOM_OAUTH_URL").is_some(){"-custom-oauth"}else{""};
    let service=format!("Claude Code{oauth}-credentials{suffix}");
    let account=std::env::var("USER").ok().or_else(|| {let uid=unsafe{libc::geteuid()};let mut record=std::mem::MaybeUninit::<libc::passwd>::uninit();let mut bytes=vec![0u8;16*1024];let mut result=std::ptr::null_mut();let status=unsafe{libc::getpwuid_r(uid,record.as_mut_ptr(),bytes.as_mut_ptr().cast(),bytes.len(),&mut result)};if status!=0||result.is_null(){None}else{Some(unsafe{std::ffi::CStr::from_ptr((*result).pw_name)}.to_string_lossy().into_owned())}}).context("The local credential account is unavailable.")?;
    for attempt in 0..3u64 {
        let mut child=match tokio::process::Command::new("security").args(["find-generic-password","-a",&account,"-w","-s",&service]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn(){Ok(child)=>child,Err(_)=>return Ok(None)};
        let read=async {let mut bytes=Vec::new();child.stdout.take().context("The credential output is unavailable.")?.take(1_048_577).read_to_end(&mut bytes).await?;let status=child.wait().await?;anyhow::ensure!(status.success()&&bytes.len()<=1_048_576,"The local credential could not be read.");claude_token(&bytes)};
        if let Ok(Ok(Some(token)))=tokio::time::timeout(Duration::from_millis(500),read).await{return Ok(Some(token));}
        let _=child.kill().await;let _=child.wait().await;
        if attempt<2 {tokio::time::sleep(Duration::from_millis(20*(attempt+1))).await;}
    }
    Ok(None)
}