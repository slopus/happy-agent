//! Real runner frames, native processes and runner-owned workspace catalogs.
use super::*;

struct RunnerLoop {
    _directory: tempfile::TempDir,
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    lifecycle: Arc<LifecycleModule>,
    runners: Arc<RunnersModule>,
    machine: crate::product::owners::Fixture,
    server: Arc<crate::product::owners::RunnerServer>,
    tools: Arc<crate::product::tools::ToolsModule>,
}

impl RunnerLoop {
    async fn new() -> Self {
        use crate::product::{
            history::HistoryModule, owners::RunnerTransport, secrets::SecretsModule,
            services::ServicesModule, tools::ToolsModule, usage::UsageModule,
        };
        crate::product::process::prepare_child_reaping().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let initial = ConfigModule::isolated(&directory.path().join(".happy")).unwrap();
        std::fs::create_dir_all(&initial.paths.configuration).unwrap();
        std::fs::write(initial.paths.configuration.join("happy.toml"), "[runners.fixture]\nname = \"Fixture runner\"\ntoken = \"0123456789012345678901234567890123456789012\"\n").unwrap();
        let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
        let runtime = Arc::new(RuntimeModule::new(config.clone()));
        runtime.load().await.unwrap();
        let lifecycle = Arc::new(LifecycleModule::new(config.clone()).unwrap());
        let runners =
            RunnersModule::new(config.clone(), runtime.clone(), lifecycle.clone()).unwrap();
        runners.load().await.unwrap();
        let machine = crate::product::owners::Fixture::new().await;
        let usage = Arc::new(
            UsageModule::new(
                machine.runtime.clone(),
                machine.events.clone(),
                machine.config.clone(),
            )
            .unwrap(),
        );
        let history = Arc::new(
            HistoryModule::new(
                machine.config.clone(),
                machine.runtime.clone(),
                machine.events.clone(),
                usage,
            )
            .unwrap(),
        );
        let secrets = SecretsModule::new(
            machine.config.clone(),
            machine.runtime.clone(),
            machine.durable.clone(),
            machine.events.clone(),
        )
        .unwrap();
        let services = ServicesModule::new(
            machine.config.clone(),
            machine.runtime.clone(),
            machine.durable.clone(),
            machine.lifecycle.clone(),
            machine.events.clone(),
        )
        .unwrap();
        let local = RunnersModule::new(
            machine.config.clone(),
            machine.runtime.clone(),
            machine.lifecycle.clone(),
        )
        .unwrap();
        let docker = crate::product::docker::DockerModule::new(
            machine.config.clone(),
            machine.runtime.clone(),
            machine.durable.clone(),
            machine.lifecycle.clone(),
            local.clone(),
        )
        .unwrap();
        let tools = Arc::new(
            ToolsModule::new(
                machine.config.clone(),
                history,
                machine.lifecycle.clone(),
                machine.runtime.clone(),
                secrets,
                services,
                machine.events.clone(),
                local.clone(),
                docker,
            )
            .unwrap(),
        );
        let server = local.native_server(tools.clone());
        let (to_daemon, from_runner) = tokio::sync::mpsc::channel(32);
        let (to_runner, from_daemon) = tokio::sync::mpsc::channel(32);
        let served = server.clone();
        tokio::spawn(async move {
            served
                .serve(RunnerTransport {
                    incoming: from_daemon,
                    outgoing: to_daemon,
                })
                .await
        });
        let accepting = runners.clone();
        tokio::spawn(async move {
            accepting
                .accept(
                    "fixture".into(),
                    RunnerTransport {
                        incoming: from_runner,
                        outgoing: to_runner,
                    },
                )
                .await
        });
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !runners.is_connected("fixture") {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the runner connects");
        Self {
            _directory: directory,
            config,
            runtime,
            lifecycle,
            runners,
            machine,
            server,
            tools,
        }
    }

    async fn close(self) {
        self.runners.close().await;
        self.lifecycle.begin_shutdown();
        self.runtime.close().await.unwrap();
        self.server.close().await.unwrap();
        self.tools.close().await;
        self.machine.close().await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_workspace_catalog_is_read_on_its_runner_and_only_missing_files_are_empty() {
    let loopback = RunnerLoop::new().await;
    let folder = loopback.machine.directory.path().join("runner-workspace");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(
        folder.join("mcp.toml"),
        "[mcp_servers.docs]\ncommand = \"docs-server\"\nargs = [\"--stdio\"]\n",
    )
    .unwrap();
    let cancel = CancellationToken::new();
    let read = |path: PathBuf| {
        let (config, runners, cancel) = (
            loopback.config.clone(),
            loopback.runners.clone(),
            cancel.clone(),
        );
        async move {
            read_runner_catalog(
                &config,
                &runners,
                "fixture",
                &path.display().to_string(),
                &cancel,
            )
            .await
        }
    };
    let servers = read(folder.clone()).await.unwrap();
    assert_eq!(servers.keys().collect::<Vec<_>>(), ["docs"]);
    assert_eq!(servers["docs"]["command"], "docs-server");
    assert_eq!(servers["docs"]["transport"], "stdio");
    let empty = loopback.machine.directory.path().join("empty");
    std::fs::create_dir_all(&empty).unwrap();
    assert!(read(empty).await.unwrap().is_empty());
    assert!(
        read(loopback.machine.directory.path().join("missing"))
            .await
            .unwrap()
            .is_empty()
    );
    let not_a_directory = loopback.machine.directory.path().join("file");
    std::fs::write(&not_a_directory, "ordinary file").unwrap();
    assert!(read(not_a_directory).await.unwrap().is_empty());
    std::fs::write(folder.join("mcp.toml"), "[providers]\n").unwrap();
    assert_eq!(
        read(folder.clone()).await.unwrap_err().to_string(),
        "MCP configuration may contain only mcp_servers, not providers."
    );
    std::fs::remove_file(folder.join("mcp.toml")).unwrap();
    std::fs::create_dir(folder.join("mcp.toml")).unwrap();
    assert!(
        read(folder)
            .await
            .unwrap_err()
            .to_string()
            .contains("Could not read Happy Agent configuration")
    );
    loopback.close().await;
}

const RUNNER_FIXTURE: &str = "HAPPY_MCP_RUNNER_FIXTURE";

#[test]
fn runner_fixture_server_process() {
    use std::io::{BufRead, Write};
    let Ok(mode) = std::env::var(RUNNER_FIXTURE) else {
        return;
    };
    let mut out = std::io::stdout();
    writeln!(out).unwrap();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let (Some(id), Some(method)) = (message.get("id"), message["method"].as_str()) else {
            continue;
        };
        let result = match method {
            "initialize" => {
                json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "runner-fixture", "version": "1.0.0"}})
            }
            "tools/list" => json!({"tools": [
                {"name": "where", "inputSchema": {"type": "object"}},
                {"name": "exit", "inputSchema": {"type": "object"}},
            ]}),
            "tools/call" => {
                json!({"content": [{"type": "text", "text": format!("{mode}|{}|{}", std::env::current_dir().unwrap().display(), std::process::id())}]})
            }
            _ => json!({}),
        };
        writeln!(
            out,
            "{}",
            json!({"jsonrpc": "2.0", "id": id, "result": result})
        )
        .unwrap();
        out.flush().unwrap();
        if method == "tools/call" && message["params"]["name"] == "exit" {
            break;
        }
    }
    std::process::exit(0);
}

async fn wait_for_exit(pid: u32) {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap_or_default();
            if status.is_empty() || status.contains("State:\tZ") {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("Process {pid} did not exit."));
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_runner_stdio_server_uses_its_cwd_and_closes_with_its_connection() {
    let loopback = RunnerLoop::new().await;
    let folder = loopback.machine.directory.path().join("server-folder");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = folder.canonicalize().unwrap();
    let config = json!({
        "transport": "stdio", "command": std::env::current_exe().unwrap().display().to_string(),
        "args": ["--exact", "product::mcp::tests::runner::runner_fixture_server_process", "--nocapture", "--test-threads=1"],
        "cwd": folder.display().to_string(), "env": {RUNNER_FIXTURE: "on-runner"},
    });
    let lifetime = CancellationToken::new();
    let connect = |runner: &'static str| {
        let (config, runners, lifetime) =
            (config.clone(), loopback.runners.clone(), lifetime.clone());
        async move {
            McpConnection::connect(
                "fixture",
                &config,
                Some(OnRunner {
                    runners: &runners,
                    id: runner,
                    lifetime: &lifetime,
                }),
            )
            .await
        }
    };
    let decline: protocol::ElicitationHandler =
        Arc::new(|_| Box::pin(async { Ok(json!({"action": "decline"})) }));
    let cancel = CancellationToken::new();
    let connection = connect("fixture").await.unwrap();
    let listed = connection.list_tools(&cancel, None).await.unwrap();
    assert_eq!(
        listed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["where", "exit"]
    );
    let answer = connection
        .call_tool(&cancel, "where", None, decline.clone())
        .await
        .unwrap();
    let place = answer["content"][0]["text"].as_str().unwrap();
    let [mode, cwd, pid]: [&str; 3] = place.split('|').collect::<Vec<_>>().try_into().unwrap();
    assert_eq!(
        (mode, cwd),
        ("on-runner", folder.display().to_string().as_str())
    );
    let pid: u32 = pid.parse().unwrap();
    connection.close().await;
    wait_for_exit(pid).await;
    let connection = connect("fixture").await.unwrap();
    let (stopped, closed) = tokio::sync::oneshot::channel();
    connection.on_close(move || {
        let _ = stopped.send(());
    });
    connection
        .call_tool(&cancel, "exit", None, decline)
        .await
        .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), closed)
        .await
        .expect("the connection ends")
        .unwrap();
    assert_eq!(
        connection
            .list_tools(&cancel, None)
            .await
            .unwrap_err()
            .to_string(),
        "Not connected"
    );
    assert_eq!(
        connect("elsewhere").await.err().unwrap(),
        "The runner elsewhere is not configured."
    );
    loopback.close().await;
}
