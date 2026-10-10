//! Built native daemon, real inference transport, real PTY, and public process routes.
use super::*;

pub(super) struct StopDaemon<'a>(pub(super) &'a Installation);
impl Drop for StopDaemon<'_> {
    fn drop(&mut self) {
        use std::io::{Read, Write};
        // A failing assertion may leave a scripted inference unanswered. The
        // ordinary stop command drains that work, so request bounded shutdown
        // directly rather than blocking unwinding on an unfinished fixture turn.
        let directory = self.0.home.join("agent");
        if let (Ok(token), Ok(mut socket)) = (std::fs::read_to_string(directory.join("token")), std::os::unix::net::UnixStream::connect(directory.join("server.sock"))) {
            let _ = socket.set_read_timeout(Some(Duration::from_secs(1)));
            let _ = socket.set_write_timeout(Some(Duration::from_secs(1)));
            let request = format!("POST /v0/shutdown HTTP/1.1\r\nHost: happy\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", token.trim());
            let _ = socket.write_all(request.as_bytes());
            let mut response = [0; 4096];
            let _ = socket.read(&mut response);
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while directory.join("daemon.pid").exists() && std::time::Instant::now() < deadline { std::thread::sleep(Duration::from_millis(20)); }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_tty_tools_and_public_process_stops_share_one_real_execution() {
    let (endpoint, mut requests, provider) = scripted_provider(3).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let _cleanup = StopDaemon(&installation);
    let first = exchange(&mut requests).await;
    first.respond.send(command_response("native-tty-start", "exec_command", json!({
        "cmd":"test -t 0 && test -t 1 && test -t 2 && test -r /dev/tty && printf 'terminal dimensions:' && stty size && stty -echo && printf 'pty-ready\\n'; IFS= read -r first; printf 'accepted:%s\\n' \"$first\"; IFS= read -r second",
        "tty":true,"yield_time_ms":250,
    }))).unwrap();
    let started = exchange(&mut requests).await;
    let output = command_output(&started.request, "native-tty-start");
    assert!(output.contains("terminal dimensions:24 80"), "{output}");
    assert!(output.contains("pty-ready"), "{output}");
    let session: u64 = output
        .lines()
        .find_map(|line| line.strip_prefix("Process running with session ID "))
        .expect("native background terminal identity")
        .parse()
        .unwrap();
    let (client, token) = installation.client();
    let activity: Value = client
        .get(format!("http://happy/v0/agents/{AGENT}/activity"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let records = activity["processes"].as_array().unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["status"], "running");
    assert_eq!(records[0]["agentId"], AGENT);
    let id = records[0]["id"].as_str().unwrap().to_owned();
    assert_ne!(id, session.to_string());
    let focused: Value = client
        .get(format!("http://happy/v0/agents/{AGENT}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(focused["agent"]["processes"]["running"], 1);
    started
        .respond
        .send(command_response(
            "native-tty-input",
            "write_stdin",
            json!({"session_id":session,"chars":"hello from the provider\n","yield_time_ms":250}),
        ))
        .unwrap();
    let typed = exchange(&mut requests).await;
    let output = command_output(&typed.request, "native-tty-input");
    assert!(
        output.contains("accepted:hello from the provider"),
        "{output}"
    );
    assert!(!output.contains("pty-ready"));
    let response = client
        .delete(format!("http://happy/v0/agents/{AGENT}/processes/{id}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let stopped: Value = response.json().await.unwrap();
    assert_eq!(stopped["process"]["id"], id);
    assert_eq!(stopped["process"]["status"], "exited");
    assert!(stopped["process"]["endedAt"].is_u64());
    let again: Value = client
        .delete(format!("http://happy/v0/agents/{AGENT}/processes/{id}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again, stopped);
    let missing = client
        .delete(format!(
            "http://happy/v0/agents/{AGENT}/processes/missingprocessfixture"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);
    let final_activity: Value = client
        .get(format!("http://happy/v0/agents/{AGENT}/activity"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(final_activity["processes"][0], stopped["process"]);
    let focused: Value = client
        .get(format!("http://happy/v0/agents/{AGENT}"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(focused["agent"]["processes"]["running"], 0);
    typed
        .respond
        .send(text_response(
            "The real terminal was stopped through its public process identity.",
        ))
        .unwrap();
    completed(&installation).await;
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    let public_process_rows: usize = database
        .query_row(
            "SELECT count(*) FROM happy_agent_events WHERE type LIKE 'process.%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        public_process_rows, 0,
        "Source's process projection is daemon-lifetime state."
    );
    provider.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restricted_native_tty_receives_input_without_losing_its_sandbox() {
    let (endpoint, mut requests, provider) = scripted_provider(3).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    let workspace = installation._directory.path().join("workspace");
    std::fs::create_dir(workspace.join(".git")).unwrap();
    for path in ["AGENTS.md", "AGENTS_SECURITY.md", "happy.toml"] { std::fs::write(workspace.join(path), "").unwrap(); }
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    database.execute("UPDATE happy_agent_values SET value_json=json_set(value_json,'$.permissionMode','workspace_write') WHERE owner_id=?1 AND key='settings'", [AGENT]).unwrap();
    drop(database);
    installation.command("start");
    let _cleanup = StopDaemon(&installation);
    let first = exchange(&mut requests).await;
    first.respond.send(command_response("restricted-tty-start", "exec_command", json!({
        "cmd":"test -t 0 && test -t 1 && test -t 2 && printf 'restricted terminal ready\\n'; IFS= read -r line; printf 'received:%s\\n' \"$line\"",
        "tty":true,"yield_time_ms":250,
    }))).unwrap();
    let started = exchange(&mut requests).await;
    let output = command_output(&started.request, "restricted-tty-start");
    assert!(output.contains("restricted terminal ready"), "{output}");
    let session: u64 = output.lines().find_map(|line| line.strip_prefix("Process running with session ID ")).expect("The restricted terminal must remain running until it receives input").parse().unwrap();
    started.respond.send(command_response("restricted-tty-input", "write_stdin", json!({"session_id":session,"chars":"input within the sandbox\n","yield_time_ms":1000}))).unwrap();
    let typed = exchange(&mut requests).await;
    let output = command_output(&typed.request, "restricted-tty-input");
    assert!(output.contains("received:input within the sandbox"), "{output}");
    assert!(output.contains("Process exited with code 0"), "{output}");
    typed.respond.send(text_response("The restricted terminal accepted input.")).unwrap();
    completed(&installation).await;
    provider.await.unwrap();
}
