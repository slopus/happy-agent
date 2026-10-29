//! Happy's native Windows supervisor adapter. Built against pinned Apache-2.0
//! Codex sandbox sources with separate Happy OS identities and firewall keys.
use anyhow::{bail, Context, Result};
use codex_protocol::{config_types::WindowsSandboxLevel, models::PermissionProfile};
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_windows_sandbox::{forward_sandbox_session_stdio, spawn_windows_sandbox_served_runner, spawn_windows_sandbox_session_for_level, FramedMessage, Message, ServedFrame, WindowsSandboxProxySettingsMode, WindowsSandboxServedRunner, WindowsSandboxSessionRequest, IPC_PROTOCOL_VERSION};
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashMap, io::{BufRead, Write}, path::PathBuf, sync::{mpsc, Arc, Mutex}};

use codex_windows_sandbox::happy_default_state_directory as default_state_directory;

fn setup_status(state: &std::path::Path) -> serde_json::Value {
    let settings = codex_windows_sandbox::WindowsSandboxProvisioningSettings::default();
    // `ready` is what a workspace inside the user folder needs, which every released install has.
    // `externalReady` is what a workspace outside it needs, which asks for approval on first use.
    let ready = codex_windows_sandbox::happy_sandbox_setup_is_ready_for(codex_windows_sandbox::SandboxScope::Profile, state, &settings);
    let external_ready = codex_windows_sandbox::happy_sandbox_setup_is_ready_for(codex_windows_sandbox::SandboxScope::External, state, &settings);
    json!({"ready": ready, "externalReady": external_ready, "stateDirectory": state, "setupVersion": codex_windows_sandbox::SETUP_VERSION})
}

/// The setup-related environment of one launch, from its own flags. Inherited values never decide
/// it: only the real per-user state may trigger one automatic first-time installation, and only a
/// launch somebody is waiting on may open the administrator prompt for it.
fn launch_environment(mut env: HashMap<String,String>, no_provision: bool, explicit_state: bool, background: bool) -> HashMap<String,String> {
    if no_provision {env.insert("HAPPY_WINDOWS_SANDBOX_NO_PROVISION".into(),"1".into());}
    // An explicit development state must already exist or be deliberately set up through CLI.
    env.insert("HAPPY_WINDOWS_SANDBOX_ALLOW_AUTO_SETUP".into(), if explicit_state {"0"} else {"1"}.into());
    // A Git scan runs on every daemon start. If it could open the prompt, a restart would show one
    // with nothing on screen to explain it, so it fails instead and the user sets up deliberately.
    env.remove("HAPPY_WINDOWS_SANDBOX_BACKGROUND");
    if background {env.insert("HAPPY_WINDOWS_SANDBOX_BACKGROUND".into(),"1".into());}
    env
}

/// A worker is always a background launch; any other launch is one only when it says so.
fn is_background_launch(worker: bool, background_flag: bool) -> bool {
    worker || background_flag
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Policy {
    mode: String,
    #[serde(default)] allowed_read_paths: Vec<PathBuf>,
    #[serde(default)] denied_read_paths: Vec<PathBuf>,
    #[serde(default)] allowed_write_paths: Vec<PathBuf>,
    #[serde(default)] denied_write_paths: Vec<PathBuf>,
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

/// One request from the daemon to a `--worker`, as one JSON line on stdin.
#[derive(Deserialize)]
#[serde(tag="type", rename_all="camelCase", deny_unknown_fields)]
enum WorkerRequest {
    Run { id: u64, argv: Vec<String>, #[serde(default, rename="timeoutMs")] timeout_ms: Option<u64> },
    Terminate { id: u64 },
}

fn emit(line: serde_json::Value) -> Result<()> {
    let mut out=std::io::stdout().lock();
    serde_json::to_writer(&mut out,&line)?;
    out.write_all(b"\n")?;
    out.flush()?;
    Ok(())
}

/// Writes one frame for command `id`. Fails once the pipe has been closed on purpose.
fn send_frame(pipe:&Mutex<Option<std::fs::File>>, id:u64, keep_descendants:bool, message:Message) -> Result<()> {
    let mut pipe=pipe.lock().map_err(|_| anyhow::anyhow!("runner pipe lock poisoned"))?;
    let pipe=pipe.as_mut().context("the sandbox runner is closing")?;
    codex_windows_sandbox::write_served_frame(pipe,&ServedFrame {id,keep_descendants,frame:FramedMessage {version:IPC_PROTOCOL_VERSION,message}})
}

/// Serves one workspace's read-only commands, one at a time, over JSON lines on stdio.
///
/// The worker pays once for what every sandboxed command used to pay: the setup refresh, the
/// sandbox logon, the private desktop, and the scratch directory. Each command still runs under
/// its own restricted token and job, and starts only once the worker's deny-read ACLs are back in
/// force if another setup changed them. Closing stdin ends the running command and the worker.
fn serve_worker(runner: WindowsSandboxServedRunner) -> Result<i32> {
    let WindowsSandboxServedRunner {pipe_write, mut pipe_read, template, deny_read}=runner;
    let pipe_write=Arc::new(Mutex::new(Some(pipe_write)));
    let current=Arc::new(Mutex::new(None::<u64>));
    let (runs, queued)=mpsc::channel::<(u64,Vec<String>,Option<u64>)>();
    {
        let pipe_write=Arc::clone(&pipe_write);
        let current=Arc::clone(&current);
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line)=line else {break};
                if line.trim().is_empty() {continue}
                match serde_json::from_str::<WorkerRequest>(&line) {
                    Ok(WorkerRequest::Run {id,argv,timeout_ms}) => {
                        if argv.is_empty() || runs.send((id,argv,timeout_ms)).is_err() {break}
                    }
                    Ok(WorkerRequest::Terminate {id}) => {
                        let _=send_frame(&pipe_write,id,false,Message::Terminate {payload:Default::default()});
                    }
                    Err(err) => {let _=emit(json!({"type":"protocolError","message":err.to_string()}));break}
                }
            }
            if let Ok(current)=current.lock() && let Some(id)=*current {
                let _=send_frame(&pipe_write,id,false,Message::Terminate {payload:Default::default()});
            }
        });
    }
    emit(json!({"type":"ready"}))?;
    for (id,argv,timeout_ms) in queued {
        if let Err(err)=deny_read.ensure_current() {
            emit(json!({"type":"error","id":id,"message":format!("The sandbox could not restore its read restrictions: {err:#}")}))?;
            continue;
        }
        *current.lock().map_err(|_| anyhow::anyhow!("worker state lock poisoned"))?=Some(id);
        send_frame(&pipe_write,id,false,Message::SpawnRequest {payload:Box::new(codex_windows_sandbox::SpawnRequest {command:argv,timeout_ms,..template.clone()})})?;
        loop {
            let Some(frame)=codex_windows_sandbox::read_served_frame(&mut pipe_read)? else {
                emit(json!({"type":"error","id":id,"message":"The sandbox runner stopped."}))?;
                return Ok(1);
            };
            if frame.id!=id {continue}
            match frame.frame.message {
                Message::Output {payload} => emit(json!({"type":payload.stream,"id":id,"data":payload.data_b64}))?,
                Message::Exit {payload} => {emit(json!({"type":"exit","id":id,"code":payload.exit_code,"timedOut":payload.timed_out}))?;break}
                Message::Error {payload} => {emit(json!({"type":"error","id":id,"message":payload.message}))?;break}
                _ => {}
            }
        }
        *current.lock().map_err(|_| anyhow::anyhow!("worker state lock poisoned"))?=None;
    }
    Ok(0)
}

/// One request from the daemon to a `--shell-runner`, as one JSON line on stdin.
#[derive(Deserialize)]
#[serde(tag="type", rename_all="camelCase", deny_unknown_fields)]
enum ShellRunnerRequest {
    Run {
        id: u64,
        argv: Vec<String>,
        /// The command's complete environment. The runner itself holds none to hand down.
        env: HashMap<String,String>,
        #[serde(default)] tty: bool,
        #[serde(default, rename="timeoutMs")] timeout_ms: Option<u64>,
    },
    Stdin { id: u64, data: String },
    CloseStdin { id: u64 },
    Resize { id: u64, rows: u16, cols: u16 },
    Terminate { id: u64 },
}

/// What a shell runner adds to every command's own environment.
struct ShellRunnerEnvironment {
    cwd: PathBuf,
    local_binding: bool,
    /// Holds one scratch folder per running command.
    scratch: PathBuf,
}

impl ShellRunnerEnvironment {
    fn command_env(&self, mut env:HashMap<String,String>, scratch:&std::path::Path) -> HashMap<String,String> {
        for key in ["TEMP", "TMP", "TMPDIR"] {
            env.insert(key.into(), scratch.to_string_lossy().into_owned());
        }
        // This is an explicit permission, never an inherited ambient setting.
        env.remove("CODEX_NETWORK_ALLOW_LOCAL_BINDING");
        if self.local_binding {env.insert("CODEX_NETWORK_ALLOW_LOCAL_BINDING".into(),"1".into());}
        codex_windows_sandbox::normalize_served_command_env(&mut env,&self.cwd);
        env
    }
}

/// Serves one workspace's shell commands under one policy, many at once, over JSON lines on stdio.
///
/// Like the worker, the runner pays once for the setup refresh, the sandbox logon, and the private
/// desktop. Unlike it, commands run concurrently, may have a terminal and input, and bring their
/// complete environment with every request. Each command gets its own restricted token, job, and
/// scratch folder, which is deleted when the command ends. Commands are told apart by the id the
/// daemon gives them. Before a command starts, the runner's deny-read ACLs are put back in force
/// if another setup changed them; that may take a setup refresh, so it happens on the command's own
/// thread, and input for the command waits until it has been sent. If the sandboxed runner dies,
/// every running command gets an error and this process exits; closing stdin stops every command
/// and then this process.
fn serve_shell_runner(runner: WindowsSandboxServedRunner, environment: ShellRunnerEnvironment) -> Result<i32> {
    let WindowsSandboxServedRunner {pipe_write, mut pipe_read, template, deny_read}=runner;
    let shared=Arc::new(ShellRunnerShared {
        pipe_write:Mutex::new(Some(pipe_write)),
        running:Mutex::new(HashMap::new()),
        pending:Mutex::new(HashMap::new()),
        environment, template, deny_read,
    });
    {
        let shared=Arc::clone(&shared);
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines() {
                let Ok(line)=line else {break};
                if line.trim().is_empty() {continue}
                let request=match serde_json::from_str::<ShellRunnerRequest>(&line) {
                    Ok(request) => request,
                    Err(err) => {let _=emit(json!({"type":"protocolError","message":err.to_string()}));break}
                };
                let (id,message)=match request {
                    ShellRunnerRequest::Run {id,argv,env,tty,timeout_ms} => {
                        if let Err(err)=start_shell_command(&shared,id,argv,env,tty,timeout_ms) {
                            let _=emit(json!({"type":"error","id":id,"message":format!("{err:#}")}));
                        }
                        continue;
                    }
                    ShellRunnerRequest::Stdin {id,data} => (id,Message::Stdin {payload:codex_windows_sandbox::StdinPayload {data_b64:data}}),
                    ShellRunnerRequest::CloseStdin {id} => (id,Message::CloseStdin {payload:Default::default()}),
                    ShellRunnerRequest::Resize {id,rows,cols} => (id,Message::Resize {payload:codex_windows_sandbox::ResizePayload {rows,cols}}),
                    ShellRunnerRequest::Terminate {id} => (id,Message::Terminate {payload:Default::default()}),
                };
                // A command still waiting to be sent keeps its input in order until it is.
                let Ok(mut pending)=shared.pending.lock() else {break};
                match pending.get_mut(&id) {
                    Some(queued) => queued.push(message),
                    None => {let _=send_frame(&shared.pipe_write,id,false,message);}
                }
            }
            // Closing the pipe tells the sandboxed runner to stop everything and exit.
            if let Ok(mut pipe)=shared.pipe_write.lock() {pipe.take();}
        });
    }
    emit(json!({"type":"ready"}))?;
    loop {
        let frame=match codex_windows_sandbox::read_served_frame(&mut pipe_read) {
            Ok(Some(frame)) => frame,
            Ok(None) | Err(_) => break,
        };
        let id=frame.id;
        match frame.frame.message {
            Message::SpawnReady {payload} => emit(json!({"type":"spawned","id":id,"pid":payload.process_id}))?,
            Message::Output {payload} => emit(json!({"type":payload.stream,"id":id,"data":payload.data_b64}))?,
            Message::Exit {payload} => {
                finish_shell_command(&shared.running,id);
                emit(json!({"type":"exit","id":id,"code":payload.exit_code,"timedOut":payload.timed_out}))?;
            }
            Message::Error {payload} => {
                finish_shell_command(&shared.running,id);
                emit(json!({"type":"error","id":id,"message":payload.message}))?;
            }
            _ => {}
        }
    }
    // The runner is gone, and every command it was running went with it.
    let orphaned:Vec<u64>=shared.running.lock().map(|running| running.keys().copied().collect()).unwrap_or_default();
    for id in orphaned {
        if finish_shell_command(&shared.running,id) {
            emit(json!({"type":"error","id":id,"message":"The sandbox runner stopped, so this command was stopped too."}))?;
        }
    }
    let closed=shared.pipe_write.lock().map(|pipe| pipe.is_none()).unwrap_or(false);
    Ok(if closed {0} else {1})
}

/// What every thread of a shell runner shares.
struct ShellRunnerShared {
    pipe_write: Mutex<Option<std::fs::File>>,
    /// Every command that has been accepted and has not yet ended, with its scratch folder.
    running: Mutex<HashMap<u64,PathBuf>>,
    /// Commands not yet sent to the sandboxed runner, with the input that arrived for them meanwhile.
    pending: Mutex<HashMap<u64,Vec<Message>>>,
    environment: ShellRunnerEnvironment,
    template: codex_windows_sandbox::SpawnRequest,
    deny_read: codex_windows_sandbox::ServedRunnerDenyRead,
}

fn start_shell_command(
    shared:&Arc<ShellRunnerShared>, id:u64, argv:Vec<String>, env:HashMap<String,String>, tty:bool, timeout_ms:Option<u64>,
) -> Result<()> {
    if argv.is_empty() {bail!("missing command")}
    let scratch=shared.environment.scratch.join(format!("command-{id}"));
    {
        let mut running=shared.running.lock().map_err(|_| anyhow::anyhow!("runner state lock poisoned"))?;
        if running.contains_key(&id) {bail!("command {id} is already running")}
        std::fs::create_dir(&scratch).context("create the command's scratch folder")?;
        running.insert(id,scratch.clone());
    }
    shared.pending.lock().map_err(|_| anyhow::anyhow!("runner state lock poisoned"))?.insert(id,Vec::new());
    let request=codex_windows_sandbox::SpawnRequest {
        command:argv, env:shared.environment.command_env(env,&scratch), timeout_ms, tty, stdin_open:true, ..shared.template.clone()
    };
    let shared=Arc::clone(shared);
    std::thread::spawn(move || {
        let sent=shared.deny_read.ensure_current()
            .context("The sandbox could not restore its read restrictions, so the command was not started")
            .and_then(|_| {
                let mut pending=shared.pending.lock().map_err(|_| anyhow::anyhow!("runner state lock poisoned"))?;
                let queued=pending.remove(&id).unwrap_or_default();
                send_frame(&shared.pipe_write,id,true,Message::SpawnRequest {payload:Box::new(request)})?;
                for message in queued {send_frame(&shared.pipe_write,id,false,message)?;}
                Ok(())
            });
        if let Err(err)=sent {
            if let Ok(mut pending)=shared.pending.lock() {pending.remove(&id);}
            if finish_shell_command(&shared.running,id) {
                let _=emit(json!({"type":"error","id":id,"message":format!("{err:#}")}));
            }
        }
    });
    Ok(())
}

/// Forgets a command that ended and deletes its scratch folder; false if it was already forgotten.
fn finish_shell_command(running:&Mutex<HashMap<u64,PathBuf>>, id:u64) -> bool {
    let scratch=running.lock().ok().and_then(|mut running| running.remove(&id));
    let known=scratch.is_some();
    if let Some(scratch)=scratch {let _=std::fs::remove_dir_all(scratch);}
    known
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
    let mut worker=false;
    let mut background=false;
    let mut shell_runner=false;
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
            "--worker" => worker=true,
            "--background" => background=true,
            "--shell-runner" => shell_runner=true,
            "--" => {command.extend(args);break;},
            _ => bail!("unknown supervisor argument: {arg}"),
        }
    }
    let explicit_state=state.is_some();
    let state=match state {Some(path)=>path,None=>default_state_directory()?};
    if !state.is_absolute() {bail!("state must be absolute")}
    if setup || status {
        if setup && status || retry && !setup || policy.is_some() || !command.is_empty() || tty || worker || background || shell_runner {bail!("setup/status must not include a command or policy")}
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
    if worker && shell_runner {bail!("choose either --worker or --shell-runner")}
    if shell_runner {
        if !command.is_empty() || tty {bail!("a shell runner receives its commands on stdin")}
    } else if worker {
        if !command.is_empty() || tty {bail!("a worker receives its commands on stdin")}
        if p.mode!="read_only" || p.network.egress || p.network.local_binding {bail!("a worker runs only read-only commands without network access")}
    } else if command.is_empty() {bail!("missing command")}
    if !state.is_absolute() || !cwd.is_absolute() {bail!("state and cwd must be absolute")}
    if !matches!(p.mode.as_str(),"read_only"|"workspace_write"|"auto") {bail!("unsupported restricted mode: {}",p.mode)}
    if !p.network.allowed_hosts.is_empty() || p.network.outgoing_proxy.is_some() {bail!("Windows host allowlist proxy is not available in this build")}
    if p.network.egress && !p.network.local_binding {bail!("Windows independent listener restriction is not available in this build")}
    if !p.network.egress && p.network.local_binding {bail!("Windows loopback-only networking requires a separate sandbox identity and is not available in this build")}
    for path in p.allowed_read_paths.iter().chain(&p.allowed_write_paths).chain(&p.denied_read_paths).chain(&p.denied_write_paths) {
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
    let denied_write=p.denied_write_paths.into_iter()
        // Outside every writable root the restricted token already denies writes.
        // Passing those paths to Codex's fallback adds each fresh scratch SID to
        // their permanent ACL, eventually exhausting Windows' 64 KiB ACL limit.
        .filter(|path|write_roots.iter().any(|root| codex_windows_sandbox::workspace_write_root_overlaps_path(root,path)))
        // A deny ACE needs an object to attach to, and the pinned setup helper would create a
        // missing one as an empty directory. Protected paths must stay absent instead, so a
        // missing one is left to the caller, which removes it if a command creates it.
        .filter(|path|path.exists())
        .map(AbsolutePathBuf::try_from).collect::<Result<Vec<_>,_>>()?;
    let profile:PermissionProfile=serde_json::from_value(json!({"type":"managed","file_system":{"type":"restricted","entries":entries},"network":if p.network.egress {"enabled"} else {"restricted"}}))?;
    let roots=vec![AbsolutePathBuf::try_from(cwd.clone())?];
    let mut env=launch_environment(std::env::vars().collect(), no_provision, explicit_state, is_background_launch(worker, background));
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
    if worker {
        let runner=spawn_windows_sandbox_served_runner(WindowsSandboxSessionRequest {
            permission_profile:&profile, workspace_roots:&roots, codex_home:&state,
            command:vec!["happy-sandbox-worker".into()], cwd:&cwd, env_map:env, windows_sandbox_level:WindowsSandboxLevel::Elevated,
            proxy_enforced:false, network_proxy_restricting_sid:None,
            proxy_settings_mode:WindowsSandboxProxySettingsMode::Reconcile,
            timeout_ms:None, read_roots_override:Some(&read_roots), read_roots_include_platform_defaults:false,
            write_roots_override:Some(&write_roots), deny_read_paths_override:&denied_read,
            deny_write_paths_override:&denied_write, tty:false, stdin_open:false, use_private_desktop:true,
        }).await?;
        // The scratch directory lives exactly as long as the worker that writes to it.
        let code=serve_worker(runner)?;
        drop(temporary);
        return Ok(code);
    }
    if shell_runner {
        let local_binding=p.network.local_binding;
        let runner=spawn_windows_sandbox_served_runner(WindowsSandboxSessionRequest {
            permission_profile:&profile, workspace_roots:&roots, codex_home:&state,
            command:vec!["happy-sandbox-shell-runner".into()], cwd:&cwd, env_map:env, windows_sandbox_level:WindowsSandboxLevel::Elevated,
            proxy_enforced:false, network_proxy_restricting_sid:None,
            proxy_settings_mode:WindowsSandboxProxySettingsMode::Reconcile,
            timeout_ms:None, read_roots_override:Some(&read_roots), read_roots_include_platform_defaults:false,
            write_roots_override:Some(&write_roots), deny_read_paths_override:&denied_read,
            // Each command asks for its own terminal and input; the runner itself has neither.
            deny_write_paths_override:&denied_write, tty:false, stdin_open:false, use_private_desktop:true,
        }).await?;
        // Every command scratch folder lives inside this one, which lives as long as the runner.
        let code=serve_shell_runner(runner,ShellRunnerEnvironment {cwd:cwd.clone(),local_binding,scratch:temporary_path.clone()})?;
        drop(temporary);
        return Ok(code);
    }
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

/// Ties every process this supervisor starts to the supervisor's own lifetime.
///
/// The caller stops a supervisor by killing it, for example when a worker's sandbox setup does
/// not finish in time. A setup helper started before that kill would otherwise keep running with
/// no parent, and a caller that retries starts another one each time. Children join this job when
/// they are created, and closing its last handle, which happens however the supervisor exits,
/// kills them. A UAC-elevated setup is started by the shell outside any job and is unaffected.
///
/// The one exception is a setup refresh helper, which asks to break away so that a rewrite of a
/// large folder's permissions finishes instead of being killed part-way and restarted by the next
/// command. It holds the read-ACL lock while it works, and the helpers it would race give up
/// within the lock wait, so this does not let helpers pile up.
fn kill_children_with_supervisor() {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let job=CreateJobObjectW(std::ptr::null(),std::ptr::null());
        if job==0 {return}
        let mut limits:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=std::mem::zeroed();
        // Only a child created with CREATE_BREAKAWAY_FROM_JOB leaves; every other stays.
        limits.BasicLimitInformation.LimitFlags=
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let configured=SetInformationJobObject(job,JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
        // The handle is deliberately never closed: the process exit closes it.
        if configured!=0 {AssignProcessToJobObject(job,GetCurrentProcess());}
    }
}

fn main() {
    kill_children_with_supervisor();
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

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(worker: bool, background_flag: bool) -> HashMap<String,String> {
        launch_environment(HashMap::new(), false, false, is_background_launch(worker, background_flag))
    }

    fn background(env: &HashMap<String,String>) -> Option<&str> {
        env.get("HAPPY_WINDOWS_SANDBOX_BACKGROUND").map(String::as_str)
    }

    #[test]
    fn workers_and_flagged_launches_are_background_launches() {
        assert_eq!(background(&launch(true, false)), Some("1"));
        assert_eq!(background(&launch(false, true)), Some("1"));
        // A shell runner serves a person's command, so it may open the prompt.
        assert_eq!(background(&launch(false, false)), None);
    }

    #[test]
    fn an_inherited_background_marker_does_not_make_a_launch_background() {
        let inherited = HashMap::from([("HAPPY_WINDOWS_SANDBOX_BACKGROUND".to_string(), "1".to_string())]);
        let env = launch_environment(inherited, false, false, false);
        assert!(!env.contains_key("HAPPY_WINDOWS_SANDBOX_BACKGROUND"));
    }

    #[test]
    fn automatic_setup_is_allowed_only_for_the_default_state() {
        let allowed = |explicit_state| launch_environment(HashMap::new(), false, explicit_state, false)["HAPPY_WINDOWS_SANDBOX_ALLOW_AUTO_SETUP"].clone();
        assert_eq!(allowed(false), "1");
        assert_eq!(allowed(true), "0");
        assert_eq!(launch_environment(HashMap::new(), true, false, false).get("HAPPY_WINDOWS_SANDBOX_NO_PROVISION").map(String::as_str), Some("1"));
    }
}
