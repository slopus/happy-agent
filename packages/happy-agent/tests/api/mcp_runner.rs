//! Native daemon, runner executable, product process and MCP handshake.
use super::*;

struct RunnerProcess(std::process::Child);
impl Drop for RunnerProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

const RUNNER_TOKEN: &str = "0123456789012345678901234567890123456789012";

fn spawn_runner(installation: &Installation, environment: &[(&str, &str)]) -> RunnerProcess {
    let log = std::fs::File::create(installation._directory.path().join("runner.log")).unwrap();
    let child = Command::new(native_executable())
        .arg("runner")
        .arg("--endpoint")
        .arg(format!(
            "unix:{}",
            installation.home.join("agent/server.sock").display()
        ))
        .env(
            "HAPPY_HOME_DIR",
            installation._directory.path().join("runner/.happy"),
        )
        .env("HAPPY_RUNNER_TOKEN", RUNNER_TOKEN)
        .envs(environment.iter().copied())
        .stdin(std::process::Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    RunnerProcess(child)
}

fn descends_from(pid: u32, ancestor: u32) -> bool {
    let mut current = pid;
    while current > 1 {
        if current == ancestor {
            return true;
        }
        let stat = std::fs::read_to_string(format!("/proc/{current}/stat")).unwrap_or_default();
        let Some(parent) = stat
            .rsplit_once(") ")
            .and_then(|(_, rest)| rest.split(' ').nth(1))
        else {
            return false;
        };
        current = parent.parse().unwrap_or(0);
    }
    false
}

fn initial_environment(pid: u32) -> Vec<String> {
    let environ = std::fs::read(format!("/proc/{pid}/environ")).unwrap();
    let mut names: Vec<String> = environ
        .split(|byte| *byte == 0)
        .filter_map(|entry| {
            std::str::from_utf8(entry)
                .ok()?
                .split_once('=')
                .map(|(name, _)| name.to_owned())
        })
        .collect();
    names.sort();
    names
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stdio_server_starts_on_the_default_runner_once_it_connects() {
    let installation = Installation::new();
    let ready = installation._directory.path().join("server-ready");
    std::fs::create_dir_all(mcp_toml(&installation).parent().unwrap()).unwrap();
    std::fs::write(mcp_toml(&installation), format!(
        "[mcp_servers.fixture]\ncommand = {:?}\nargs = [\"--exact\", \"mcp_acceptance::fixture_server_process\", \"--nocapture\", \"--test-threads=1\"]\nenv = {{ {FIXTURE} = \"runner\", {READY} = {:?} }}\n",
        std::env::current_exe().unwrap().display().to_string(), ready.display().to_string()
    )).unwrap();
    prepare(&installation, "http://127.0.0.1:9");
    let configuration = installation
        ._directory
        .path()
        .join("happy/config/happy.toml");
    let mut text = std::fs::read_to_string(&configuration).unwrap();
    text.push_str(&format!(
        "\n[runners.fixture]\nname = \"Fixture runner\"\ntoken = \"{RUNNER_TOKEN}\"\n"
    ));
    std::fs::write(&configuration, text).unwrap();
    launch(&installation, &[("FIXTURE_DAEMON_ONLY", "daemon")]);
    let _cleanup = compute_acceptance::StopDaemon(&installation);
    let (client, token) = installation.client();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let snapshot: Value = client
                .get("http://happy/v0/runners")
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            let runner = &snapshot["runners"][0];
            assert_eq!(
                (&runner["id"], &runner["status"]),
                (&json!("fixture"), &json!("disconnected")),
                "{snapshot}"
            );
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            if now.saturating_sub(runner["since"].as_u64().unwrap()) > 10_500 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("the runner is away past the daemon's wait");
    assert!(!ready.exists(), "The server started without its runner.");
    let runner = spawn_runner(&installation, &[("FIXTURE_RUNNER_ONLY", "runner")]);
    let pid: u32 = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(pid) = std::fs::read_to_string(&ready)
                .ok()
                .and_then(|pid| pid.parse().ok())
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "The server never started on the runner.\nrunner: {}\ndaemon: {}",
            std::fs::read_to_string(installation._directory.path().join("runner.log"))
                .unwrap_or_default(),
            std::fs::read_to_string(installation.home.join("agent/daemon.log")).unwrap_or_default()
        )
    });
    assert!(
        descends_from(pid, runner.0.id()),
        "The server {pid} is not one of the runner's programs."
    );
    let variables = initial_environment(pid);
    for expected in [FIXTURE, READY, "FIXTURE_RUNNER_ONLY"] {
        assert!(
            variables.iter().any(|name| name == expected),
            "{expected} is missing: {variables:?}"
        );
    }
    for leaked in [
        "FIXTURE_DAEMON_ONLY",
        "HAPPY_RUNNER_TOKEN",
        "HAPPY_RUNNER_ENDPOINT",
    ] {
        assert!(
            !variables.iter().any(|name| name == leaked),
            "{leaked} reached the server: {variables:?}"
        );
    }
    installation.command("stop");
    wait_for_exit(pid).await;
    drop(runner);
}

struct FixtureProcesses(Vec<(u32, String)>);
impl FixtureProcesses {
    fn track(&mut self, pid: u32) {
        self.0.push((
            pid,
            process_start(pid).expect("the fixture process is alive"),
        ));
    }
}
fn process_start(pid: u32) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    Some(stat.rsplit_once(") ")?.1.split_whitespace().nth(19)?.into())
}
impl Drop for FixtureProcesses {
    fn drop(&mut self) {
        for (pid, started) in &self.0 {
            if process_start(*pid).as_ref() == Some(started) {
                unsafe {
                    libc::kill(*pid as i32, libc::SIGTERM);
                }
            }
        }
    }
}

async fn ready_pid(path: &Path, previous: Option<u32>) -> u32 {
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if let Some(pid) = std::fs::read_to_string(path)
                .ok()
                .and_then(|pid| pid.parse().ok())
            {
                if previous != Some(pid) {
                    return pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the runner's MCP program starts")
}

#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_runner_disconnect_ends_pending_mcp_calls_and_return_starts_one_replacement() {
    let (endpoint, mut requests, provider) = scripted_provider(8).await;
    let installation = Installation::new();
    let ready = installation._directory.path().join("server-ready");
    std::fs::create_dir_all(mcp_toml(&installation).parent().unwrap()).unwrap();
    std::fs::write(mcp_toml(&installation), format!(
        "[mcp_servers.fixture]\ncommand = {:?}\nargs = [\"--exact\", \"mcp_acceptance::fixture_server_process\", \"--nocapture\", \"--test-threads=1\"]\nenv = {{ {FIXTURE} = \"runner\", {READY} = {:?} }}\n",
        std::env::current_exe().unwrap().display().to_string(), ready.display().to_string()
    )).unwrap();
    prepare(&installation, &endpoint);
    // Restore an existing agent: new runner-backed agent creation belongs to the API port.
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    database
        .execute(
            "UPDATE happy_agent_module_projects SET runner_id='fixture' WHERE id=?1",
            [WORKSPACE],
        )
        .unwrap();
    let folder = workspace_folder(&installation);
    // This headless agent uses MCP without a compute module. Otherwise skill discovery opens
    // a runner compute again before each inference and independently waits for an absent runner.
    let configuration = json!({"provenance":{"createdAt":1700000000000u64},"environment":{"osVersion":"fixture","platform":"linux","workingDirectory":folder,"shell":"/bin/bash"},"modules":{},"metadata":{"title":"Runner MCP fixture","version":1,"updatedAt":1700000000000u64}});
    database
        .execute(
            "INSERT INTO happy_agent_values VALUES('',?1,?2)",
            params![
                format!("agentSystem.config.{MCP_AGENT}"),
                configuration.to_string()
            ],
        )
        .unwrap();
    database
        .execute(
            "INSERT INTO happy_agent_values VALUES(?1,'agentConfig',?2)",
            params![MCP_AGENT, configuration.to_string()],
        )
        .unwrap();
    database.execute("INSERT INTO happy_agent_module_project_root_agents(project_id,agent_id,order_key) VALUES(?1,?2,'5')", params![WORKSPACE,MCP_AGENT]).unwrap();
    drop(database);
    let configuration = installation
        ._directory
        .path()
        .join("happy/config/happy.toml");
    let mut text = std::fs::read_to_string(&configuration).unwrap();
    text.push_str(&format!(
        "\n[runners.fixture]\nname = \"Fixture runner\"\ntoken = \"{RUNNER_TOKEN}\"\n"
    ));
    std::fs::write(&configuration, text).unwrap();
    launch(&installation, &[]);
    let _cleanup = compute_acceptance::StopDaemon(&installation);
    let runner = spawn_runner(&installation, &[]);
    let pid = ready_pid(&ready, None).await;
    assert!(descends_from(pid, runner.0.id()));
    let mut processes = FixtureProcesses(Vec::new());
    processes.track(pid);
    send(
        &installation,
        "messagemcprunner",
        "Call the runner's MCP server and recover after it disconnects.",
        "full_access",
    )
    .await;
    let turn = exchange(&mut requests).await;
    assert!(tool_names(&turn.request).contains(&"mcp__fixture__echo".into()));
    let next = call(
        &mut requests,
        turn,
        "r1",
        "mcp__fixture__echo",
        json!({"text": "before"}),
    )
    .await;
    assert_eq!(output(&next.request, "r1"), "before");
    let next = call(
        &mut requests,
        next,
        "r2",
        "mcp__fixture__echo",
        json!({"text": "protocol-error"}),
    )
    .await;
    assert!(output(&next.request, "r2").contains("MCP error -32042: Fixture RPC failure."));
    next.respond
        .send(command_response(
            "r3",
            "mcp__fixture__echo",
            json!({"text": "wait-for-disconnect"}),
        ))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !ready.with_extension("waiting").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the server is handling the pending call");
    drop(runner);
    let following = tokio::time::timeout(Duration::from_secs(2), requests.recv()).await;
    if following.is_err() {
        eprintln!(
            "Daemon: {}",
            std::fs::read_to_string(installation.home.join("agent/daemon.log")).unwrap_or_default()
        );
    }
    let next = following
        .expect("a disconnected runner must end an already pending MCP call immediately")
        .expect("the model receives the pending call's failure");
    assert!(output(&next.request, "r3").contains("MCP error -32000: Connection closed"));
    let next = call(&mut requests, next, "r4", "list_mcp_servers", json!({})).await;
    assert!(
        output(&next.request, "r4")
            .contains("fixture\tfailed\t0 tools — The runner Fixture runner is not connected."),
        "{}",
        output(&next.request, "r4")
    );
    let replacement = spawn_runner(&installation, &[]);
    let new_pid = ready_pid(&ready, Some(pid)).await;
    processes.track(new_pid);
    assert!(descends_from(new_pid, replacement.0.id()));
    let next = call(&mut requests, next, "r5", "list_mcp_servers", json!({})).await;
    assert_eq!(output(&next.request, "r5"), "fixture\tconnected\t5 tools");
    let next = call(
        &mut requests,
        next,
        "r6",
        "mcp__fixture__echo",
        json!({"text": "after"}),
    )
    .await;
    assert_eq!(output(&next.request, "r6"), "after");
    let next = call(
        &mut requests,
        next,
        "r7",
        "reload_mcp_servers",
        json!({"global": true}),
    )
    .await;
    assert_eq!(output(&next.request, "r7"), "fixture\tconnected\t5 tools");
    let started: Vec<u32> = std::fs::read_to_string(ready.with_extension("started"))
        .unwrap()
        .lines()
        .map(|pid| pid.parse().unwrap())
        .collect();
    assert_eq!(
        started,
        [pid, new_pid],
        "a return and repeated reconciliation launch only one replacement"
    );
    next.respond.send(text_response("Recovered.")).unwrap();
    settled(&installation, 1).await;
    installation.command("stop");
    wait_for_exit(new_pid).await;
    drop(replacement);
    drop(processes);
    provider.await.unwrap();
}
