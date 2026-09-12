//! Happy's native Windows supervisor adapter. Built against pinned Apache-2.0
//! Codex sandbox sources with separate Happy OS identities and firewall keys.
use anyhow::{bail, Context, Result};
use codex_protocol::{config_types::WindowsSandboxLevel, models::PermissionProfile};
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_windows_sandbox::{forward_sandbox_session_stdio, spawn_windows_sandbox_session_for_level, WindowsSandboxProxySettingsMode, WindowsSandboxSessionRequest};
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashMap, path::PathBuf};

use codex_windows_sandbox::happy_default_state_directory as default_state_directory;

fn setup_status(state: &std::path::Path) -> serde_json::Value {
    let ready = codex_windows_sandbox::happy_sandbox_setup_is_ready(state, &codex_windows_sandbox::WindowsSandboxProvisioningSettings::default());
    json!({"ready": ready, "stateDirectory": state, "setupVersion": codex_windows_sandbox::SETUP_VERSION})
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Policy {
    mode: String,
    #[serde(default)] allowed_read_paths: Vec<PathBuf>,
    #[serde(default)] denied_read_paths: Vec<PathBuf>,
    #[serde(default)] allowed_write_paths: Vec<PathBuf>,
    #[serde(default)] denied_write_paths: Vec<PathBuf>,
    #[serde(default)] denied_write_file_paths: Vec<PathBuf>,
    network: Network,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Network {
    egress: bool,
    local_binding: bool,
    #[serde(default)] allowed_hosts: Vec<String>,
    #[serde(default)] outgoing_proxy: Option<serde_json::Value>,
}

fn path_in_write_roots(path:&std::path::Path, roots:&[PathBuf]) -> bool {
    roots.iter().any(|root| codex_windows_sandbox::workspace_write_root_contains_path(root,path))
}

async fn run() -> Result<i32> {
    let mut args=std::env::args().skip(1);
    let mut policy=None;
    let mut state=None;
    let mut cwd=std::env::current_dir()?;
    let mut tty=false;
    let mut setup=false;
    let mut status=false;
    let mut retry=false;
    let mut no_provision=false;
    let mut command=Vec::new();
    while let Some(arg)=args.next() {
        match arg.as_str() {
            "--policy" => { let raw=args.next().context("missing policy")?; if raw.len()>1_048_576 {bail!("policy exceeds 1 MiB")}; policy=Some(serde_json::from_str::<Policy>(&raw)?); },
            "--state-dir" => state=Some(PathBuf::from(args.next().context("missing state directory")?)),
            "--cwd" => cwd=PathBuf::from(args.next().context("missing cwd")?),
            "--tty" => tty=true,
            "--setup" => setup=true,
            "--setup-status" => status=true,
            "--retry" => retry=true,
            "--no-provision" => no_provision=true,
            "--" => {command.extend(args);break;},
            _ => bail!("unknown supervisor argument: {arg}"),
        }
    }
    let explicit_state=state.is_some();
    let state=match state {Some(path)=>path,None=>default_state_directory()?};
    if !state.is_absolute() {bail!("state must be absolute")}
    if setup || status {
        if setup && status || retry && !setup || policy.is_some() || !command.is_empty() || tty {bail!("setup/status must not include a command or policy")}
        if setup {
            let permissions=codex_windows_sandbox::ResolvedWindowsSandboxPermissions::try_from_permission_profile(&PermissionProfile::read_only())?;
            let mut env:HashMap<String,String>=std::env::vars().collect();
            if no_provision {env.insert("HAPPY_WINDOWS_SANDBOX_NO_PROVISION".into(),"1".into());}
            env.remove("CODEX_WINDOWS_SANDBOX_PROXY_PORTS");
            env.remove("CODEX_NETWORK_ALLOW_LOCAL_BINDING");
            codex_windows_sandbox::run_happy_explicit_setup(codex_windows_sandbox::SandboxSetupRequest {
                permissions:&permissions, command_cwd:&state, env_map:&env, codex_home:&state, proxy_enforced:false,
            }, retry)?;
        }
        println!("{}",setup_status(&state));
        return Ok(0);
    }
    if retry {bail!("--retry requires --setup")}
    let mut p=policy.context("--policy is required")?;
    // The installation state is never part of a project command's writable surface.
    p.denied_write_paths.push(state.clone());
    p.denied_write_paths.push(default_state_directory()?);
    if command.is_empty() {bail!("missing command")}
    if !state.is_absolute() || !cwd.is_absolute() {bail!("state and cwd must be absolute")}
    if !matches!(p.mode.as_str(),"read_only"|"workspace_write"|"auto") {bail!("unsupported restricted mode: {}",p.mode)}
    if !p.network.allowed_hosts.is_empty() || p.network.outgoing_proxy.is_some() {bail!("Windows host allowlist proxy is not available in this build")}
    if p.network.egress && !p.network.local_binding {bail!("Windows independent listener restriction is not available in this build")}
    if !p.network.egress && p.network.local_binding {bail!("Windows loopback-only networking requires a separate sandbox identity and is not available in this build")}
    for path in p.allowed_read_paths.iter().chain(&p.allowed_write_paths).chain(&p.denied_read_paths).chain(&p.denied_write_paths).chain(&p.denied_write_file_paths) {
        if !path.is_absolute(){bail!("permission paths must be absolute: {}",path.display())}
        if path.components().any(|part| matches!(part,std::path::Component::ParentDir)) {bail!("permission paths must be normalized: {}",path.display())}
    }
    // Happy read roots add access; they do not narrow the default readable host.
    let mut entries=vec![json!({"path":{"type":"special","value":{"kind":"root"}},"access":"read"})];
    // Give each command its own scratch directory, including read-only commands.
    // PowerShell's policy probe and developer tools need writable TEMP; never
    // grant them the caller's shared TEMP directory or a user workspace for this.
    let temporary=tempfile::Builder::new().prefix("happy-sandbox-").tempdir()
        .context("create isolated command scratch directory")?;
    let temporary_path=temporary.path().to_path_buf();
    let mut write_roots=vec![temporary_path.clone()];
    if p.mode!="read_only" {
        write_roots.push(cwd.clone());
        write_roots.extend(p.allowed_write_paths);
    }
    for path in &write_roots {entries.push(json!({"path":{"type":"path","path":path},"access":"write"}));}
    // Never let Codex's missing-deny materialization create placeholder directories.
    // A missing read denial is safe to omit only outside every writable root.
    let mut denied_read=Vec::new();
    for path in p.denied_read_paths {
        if !path.exists() {
            if path_in_write_roots(&path,&write_roots) {
                bail!("cannot protect absent readable path inside a writable root: {}",path.display());
            }
            continue;
        }
        denied_read.push(AbsolutePathBuf::try_from(path)?);
    }
    // The Windows product policy permits protected placeholders. Root project files
    // must be files (an empty happy.toml is valid), while protected directories
    // are materialized by the pinned sandbox before their deny ACEs are applied.
    // Missing denies outside writable roots need no object: creation is already denied.
    for path in &p.denied_write_file_paths {
        if !p.denied_write_paths.contains(path) {bail!("protected file must also be denied for writing: {}",path.display())}
        if path_in_write_roots(path,&write_roots) && !path.exists() {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(path) {
                Ok(file) => {file.sync_all().context("flush protected file placeholder")?;},
                Err(error) if error.kind()==std::io::ErrorKind::AlreadyExists => {},
                Err(error) => return Err(error).with_context(||format!("create protected file placeholder {}",path.display())),
            }
        }
    }
    let denied_write=p.denied_write_paths.into_iter()
        // Outside every writable root the restricted token already denies writes.
        // Passing those paths to Codex's fallback adds each fresh scratch SID to
        // their permanent ACL, eventually exhausting Windows' 64 KiB ACL limit.
        .filter(|path|write_roots.iter().any(|root| codex_windows_sandbox::workspace_write_root_overlaps_path(root,path)))
        .map(AbsolutePathBuf::try_from).collect::<Result<Vec<_>,_>>()?;
    let profile:PermissionProfile=serde_json::from_value(json!({"type":"managed","file_system":{"type":"restricted","entries":entries},"network":if p.network.egress {"enabled"} else {"restricted"}}))?;
    let roots=vec![AbsolutePathBuf::try_from(cwd.clone())?];
    let mut env:HashMap<String,String>=std::env::vars().collect();
    if no_provision {env.insert("HAPPY_WINDOWS_SANDBOX_NO_PROVISION".into(),"1".into());}
    // Only the real per-user default may trigger one automatic first-time installation.
    // An explicit development state must already exist or be deliberately set up through CLI.
    env.insert("HAPPY_WINDOWS_SANDBOX_ALLOW_AUTO_SETUP".into(), if explicit_state {"0"} else {"1"}.into());
    for key in ["TEMP", "TMP", "TMPDIR"] {
        env.insert(key.into(), temporary_path.to_string_lossy().into_owned());
    }
    // This is an explicit permission, never an inherited ambient setting.
    env.remove("CODEX_NETWORK_ALLOW_LOCAL_BINDING");
    if p.network.local_binding {env.insert("CODEX_NETWORK_ALLOW_LOCAL_BINDING".into(),"1".into());}
    // Grant the helper only explicitly selected project/tool paths. Do not copy
    // Codex's default provisioning of unrelated folders throughout USERPROFILE.
    let mut read_roots=vec![cwd.clone()];
    read_roots.extend(p.allowed_read_paths);
    read_roots.extend(write_roots.iter().cloned());
    let spawned=spawn_windows_sandbox_session_for_level(WindowsSandboxSessionRequest {
        permission_profile:&profile, workspace_roots:&roots, codex_home:&state,
        command, cwd:&cwd, env_map:env, windows_sandbox_level:WindowsSandboxLevel::Elevated,
        proxy_enforced:false, network_proxy_restricting_sid:None,
        proxy_settings_mode:WindowsSandboxProxySettingsMode::Reconcile,
        timeout_ms:None, read_roots_override:Some(&read_roots), read_roots_include_platform_defaults:false,
        write_roots_override:Some(&write_roots), deny_read_paths_override:&denied_read,
        deny_write_paths_override:&denied_write, tty, stdin_open:true, use_private_desktop:true,
    }).await?;
    Ok(forward_sandbox_session_stdio(spawned).await)
}

fn main() {
    let outcome = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(runtime) => {
            let outcome = runtime.block_on(run());
            // The sandbox session has exited and its output has been drained.
            // An open parent stdin can leave a blocking IPC writer parked.
            // Runtime::drop would wait forever for that writer; command exit
            // must not depend on the caller closing input intended for sessions.
            runtime.shutdown_background();
            outcome
        }
        Err(error) => Err(anyhow::Error::new(error).context("create runtime")),
    };
    match outcome {Ok(code)=>std::process::exit(code),Err(err)=>{eprintln!("Happy Windows sandbox: {err:#}");std::process::exit(125)}}
}
