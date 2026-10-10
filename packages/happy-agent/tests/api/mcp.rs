//! MCP servers through the built daemon: a stdio server it starts (this test binary, run again as
//! the server) and a Streamable HTTP server on loopback. Agents see the servers' tools as ordinary
//! tools, every call and prompt is reviewed in Auto mode while listings are not, a server's
//! question reaches the person, and `mcp.toml` edits apply without a restart.
use super::*;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

/// Set in a server's configured environment, it makes this binary serve MCP on stdio.
const FIXTURE: &str = "HAPPY_MCP_FIXTURE";
const READY: &str = "HAPPY_MCP_FIXTURE_READY";
const MCP_AGENT: &str = "agentmcpfixture";
#[path = "mcp_runner.rs"]
mod runner_acceptance;

#[test]
fn fixture_server_process() {
    if std::env::var(FIXTURE).is_ok() {
        serve_stdio();
        std::process::exit(0);
    }
}

fn fixture_tools(with_questions: bool) -> Value {
    let mut tools = vec![
        json!({"name": "echo", "description": "Echo the text back.", "inputSchema": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}),
        json!({"name": "environment", "description": "List the environment variable names the server sees.", "inputSchema": {"type": "object"}}),
        json!({"name": "fail", "description": "Fail as a tool.", "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": true}}),
    ];
    if with_questions {
        tools.push(json!({"name": "ask", "description": "Ask which environment to deploy to.", "inputSchema": {"type": "object"}}));
        tools.push(json!({"name": "exit", "description": "Answer, then stop the server.", "inputSchema": {"type": "object"}}));
    }
    json!(tools)
}

/// The answer to every request a fixture serves the same way on either transport.
fn fixture_result(
    method: &str,
    params: &Value,
    with_questions: bool,
) -> Result<Value, (i64, &'static str)> {
    Ok(match method {
        "initialize" => json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}, "resources": {}, "prompts": {}},
            "serverInfo": {"name": "fixture", "version": "1.0.0"}
        }),
        "ping" => json!({}),
        "tools/list" => json!({"tools": fixture_tools(with_questions)}),
        "tools/call" => match params["name"].as_str() {
            Some("echo") => {
                json!({"content": [{"type": "text", "text": params["arguments"]["text"]}]})
            }
            Some("environment") => {
                let mut names: Vec<String> = std::env::vars().map(|(name, _)| name).collect();
                names.sort();
                let mode = std::env::var(FIXTURE).unwrap_or_default();
                json!({"content": [{"type": "text", "text": format!("{}\nmode={mode}\npid={}", names.join(","), std::process::id())}]})
            }
            Some("fail") => {
                json!({"content": [{"type": "text", "text": "It broke."}], "isError": true})
            }
            Some("exit") => {
                json!({"content": [{"type": "text", "text": format!("Stopping {}.", std::process::id())}]})
            }
            _ => json!({"content": [{"type": "text", "text": "Unknown tool."}], "isError": true}),
        },
        "resources/list" => {
            json!({"resources": [{"uri": "fixture://readme", "name": "Readme", "mimeType": "text/plain"}]})
        }
        "resources/templates/list" => {
            json!({"resourceTemplates": [{"uriTemplate": "fixture://notes/{name}", "name": "Notes"}]})
        }
        "resources/read" => {
            json!({"contents": [{"uri": params["uri"], "mimeType": "text/plain", "text": "Read me first."}]})
        }
        "prompts/list" => json!({"prompts": [{"name": "review", "description": "Review code."}]}),
        "prompts/get" => {
            json!({"messages": [{"role": "user", "content": {"type": "text", "text": "Review this change."}}]})
        }
        _ => return Err((-32601, "Method not found")),
    })
}

fn reply(id: &Value, outcome: Result<Value, (i64, &'static str)>) -> Value {
    match outcome {
        Ok(result) => json!({"jsonrpc": "2.0", "id": id, "result": result}),
        Err((code, message)) => {
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
        }
    }
}

/// One JSON-RPC message per line. Its `ask` tool asks the client for input and answers with what
/// came back.
fn serve_stdio() {
    let stdin = std::io::stdin();
    let mut lines = stdin.lock().lines();
    let mut out = std::io::stdout();
    // The test harness has already begun a line of its own on stdout; end it, so the first
    // message stands on a line of its own and the harness line is skipped as noise.
    writeln!(out).unwrap();
    let mut write = |message: Value| {
        writeln!(out, "{message}").unwrap();
        out.flush().unwrap();
    };
    while let Some(Ok(line)) = lines.next() {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if message["method"] == "notifications/initialized" {
            if let Ok(ready) = std::env::var(READY) {
                std::fs::write(&ready, std::process::id().to_string()).unwrap();
                let mut started = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(format!("{ready}.started"))
                    .unwrap();
                writeln!(started, "{}", std::process::id()).unwrap();
            }
        }
        let (Some(id), Some(method)) = (message.get("id"), message["method"].as_str()) else {
            continue;
        };
        if std::env::var(FIXTURE).as_deref() == Ok("runner") && method == "tools/call" {
            let ready = std::env::var(READY).unwrap();
            if message["params"]["arguments"]["text"] == "wait-for-disconnect" {
                std::fs::write(format!("{ready}.waiting"), id.to_string()).unwrap();
                loop {
                    std::thread::park();
                }
            }
            if message["params"]["arguments"]["text"] == "protocol-error" {
                write(reply(id, Err((-32042, "Fixture RPC failure."))));
                continue;
            }
        }
        if method == "tools/call" && message["params"]["name"] == "ask" {
            write(
                json!({"jsonrpc": "2.0", "id": "question-1", "method": "elicitation/create", "params": {
                    "message": "Which environment should receive the deploy?",
                    "requestedSchema": {"type": "object", "properties": {
                        "environment": {"type": "string", "title": "Environment", "enum": ["staging", "production"]}
                    }, "required": ["environment"]}
                }}),
            );
            let answer = loop {
                let Some(Ok(line)) = lines.next() else { return };
                let Ok(answer) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if answer["id"] == "question-1" {
                    break answer;
                }
            };
            write(reply(
                id,
                Ok(json!({"content": [{"type": "text", "text": answer["result"].to_string()}]})),
            ));
            continue;
        }
        write(reply(id, fixture_result(method, &message["params"], true)));
        if method == "tools/call" && message["params"]["name"] == "exit" {
            return;
        }
    }
}

/// What the HTTP fixture saw of each POST: the message and its headers.
type Seen = Arc<Mutex<Vec<(Value, Value)>>>;

/// A Streamable HTTP server on loopback: JSON answers, a server-sent event stream for tool calls,
/// a session ID from initialization on, and no stream of its own (GET is refused with 405).
async fn serve_http() -> (String, Seen, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/mcp", listener.local_addr().unwrap());
    let seen = Seen::default();
    let recorded = seen.clone();
    let task = tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let seen = recorded.clone();
            tokio::spawn(async move {
                let service =
                    hyper::service::service_fn(move |request: Request<hyper::body::Incoming>| {
                        let seen = seen.clone();
                        async move {
                            let headers: serde_json::Map<String, Value> = request
                                .headers()
                                .iter()
                                .map(|(name, value)| {
                                    (name.to_string(), json!(value.to_str().unwrap_or_default()))
                                })
                                .collect();
                            let method = request.method().clone();
                            let body = request
                                .into_body()
                                .collect()
                                .await
                                .map(|body| body.to_bytes())
                                .unwrap_or_default();
                            let respond = |status: u16, kind: &str, body: String| {
                                let mut response = Response::builder()
                                    .status(status)
                                    .header("mcp-session-id", "fixture-session");
                                if !kind.is_empty() {
                                    response = response.header("content-type", kind);
                                }
                                Ok::<_, std::convert::Infallible>(
                                    response.body(Full::new(Bytes::from(body))).unwrap(),
                                )
                            };
                            if method != hyper::Method::POST {
                                return respond(405, "", String::new());
                            }
                            let message: Value =
                                serde_json::from_slice(&body).unwrap_or(Value::Null);
                            seen.lock()
                                .unwrap()
                                .push((message.clone(), Value::Object(headers.clone())));
                            if headers.get("authorization") != Some(&json!("Bearer fixture-token"))
                            {
                                return respond(401, "text/plain", "Unauthorized".into());
                            }
                            let (Some(id), Some(name)) =
                                (message.get("id"), message["method"].as_str())
                            else {
                                return respond(202, "", String::new());
                            };
                            let answer = reply(id, fixture_result(name, &message["params"], false));
                            if name == "tools/call" {
                                return respond(
                                    200,
                                    "text/event-stream",
                                    format!(
                                        ": a comment\nevent: message\nid: 7\ndata: {answer}\n\n"
                                    ),
                                );
                            }
                            respond(200, "application/json", answer.to_string())
                        }
                    });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(stream), service)
                    .await;
            });
        }
    });
    (url, seen, task)
}

/// This binary as an MCP stdio server entry for `mcp.toml`.
fn stdio_server(name: &str, mode: &str) -> String {
    let executable = std::env::current_exe().unwrap();
    format!(
        "[mcp_servers.{name}]\ncommand = {:?}\nargs = [\"--exact\", \"mcp_acceptance::fixture_server_process\", \"--nocapture\", \"--test-threads=1\"]\nenv = {{ {FIXTURE} = {mode:?} }}\n",
        executable.display().to_string()
    )
}

fn mcp_toml(installation: &Installation) -> PathBuf {
    installation
        ._directory
        .path()
        .join(if cfg!(target_os = "macos") {
            "Happy/Config/mcp.toml"
        } else {
            "happy/config/mcp.toml"
        })
}

fn workspace_folder(installation: &Installation) -> PathBuf {
    installation._directory.path().join("workspace")
}

/// A seeded installation without the recovered agent, started with extra daemon environment.
fn start(installation: &Installation, endpoint: &str, environment: &[(&str, &str)]) {
    prepare(installation, endpoint);
    launch(installation, environment);
}

fn prepare(installation: &Installation, endpoint: &str) {
    installation.seed(endpoint);
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    database
        .execute(
            "DELETE FROM happy_agent_values WHERE owner_id=?1 OR (owner_id='' AND key=?2)",
            params![AGENT, format!("agentSystem.config.{AGENT}")],
        )
        .unwrap();
    database
        .execute(
            "DELETE FROM happy_agent_module_project_root_agents WHERE agent_id=?1",
            [AGENT],
        )
        .unwrap();
    drop(database);
}

fn launch(installation: &Installation, environment: &[(&str, &str)]) {
    let output = Command::new(native_executable())
        .arg("start")
        .env("HAPPY_HOME_DIR", &installation.home)
        .envs(environment.iter().copied())
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stderr),
        std::fs::read_to_string(installation.home.join("agent/daemon.log")).unwrap_or_default()
    );
}

async fn create_agent(installation: &Installation) {
    let (client, token) = installation.client();
    let created = client
        .post("http://happy/v0/agents")
        .bearer_auth(&token)
        .json(&json!({"workspaceId": WORKSPACE, "id": MCP_AGENT}))
        .send()
        .await
        .unwrap();
    let status = created.status();
    assert_eq!(status, 201, "{}", created.text().await.unwrap());
}

async fn send(installation: &Installation, message: &str, text: &str, permission_mode: &str) {
    let (client, token) = installation.client();
    let mode = json!({"providerId": "fixture", "modelId": "openai/gpt-5.6-sol", "effort": "medium", "serviceTier": null, "permissionMode": permission_mode});
    let sent = client
        .post(format!("http://happy/v0/agents/{MCP_AGENT}/send"))
        .bearer_auth(&token)
        .json(&json!({"id": message, "text": text, "profile": null, "mode": mode}))
        .send()
        .await
        .unwrap();
    assert_eq!(sent.status(), 202);
}

async fn settled(installation: &Installation, runs: usize) {
    let (client, token) = installation.client();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let page: Value = client
                .get(format!("http://happy/v0/agents/{MCP_AGENT}/messages"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if page["runs"].as_array().is_some_and(|all| {
                all.len() == runs && all.iter().all(|run| run["status"] == "completed")
            }) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the agent settles");
}

fn tool_names(request: &Value) -> Vec<String> {
    request["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
        .collect()
}

fn tool_description(request: &Value, name: &str) -> String {
    request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == name)
        .unwrap()["description"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// The text a tool returned, in either output form.
fn output(request: &Value, id: &str) -> String {
    let item = request["input"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == id)
        .unwrap_or_else(|| panic!("No result for {id} reached the model: {request}"));
    match &item["output"] {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

/// Answers the next request as the main model calling one tool, and returns what came next.
async fn call(
    requests: &mut mpsc::Receiver<Exchange>,
    turn: Exchange,
    id: &str,
    name: &str,
    arguments: Value,
) -> Exchange {
    turn.respond
        .send(command_response(id, name, arguments))
        .unwrap();
    exchange(requests).await
}

/// The proposed action a private review judged.
fn reviewed_action(review: &Value) -> Option<String> {
    // A reused Source reviewer retains prior actions in its own conversation.
    // Read the latest user prompt rather than the first action anywhere in the request.
    let text = review["input"]
        .as_array()?
        .iter()
        .rev()
        .find(|item| item["role"] == "user")?["content"]
        .as_str()?;
    let (_, prompt) = text.rsplit_once("\n\n<proposed_action>\n")?;
    let prompt = prompt.strip_suffix("\n</proposed_action>")?;
    serde_json::from_str::<Value>(prompt).ok()?["description"]
        .as_str()
        .map(str::to_owned)
}

/// Allows the private review this exchange is, and returns the action it judged with what came next.
async fn allow(requests: &mut mpsc::Receiver<Exchange>, review: Exchange) -> (String, Exchange) {
    let action = reviewed_action(&review.request)
        .unwrap_or_else(|| panic!("Expected a private review: {}", review.request));
    review.respond.send(text_response("<review><outcome>allow</outcome><risk_level>low</risk_level><user_authorization>high</user_authorization><rationale>The person asked for this.</rationale></review>")).unwrap();
    (action, exchange(requests).await)
}

fn assert_not_review(request: &Value) {
    assert!(
        reviewed_action(request).is_none(),
        "A listing or read must not be reviewed: {request}"
    );
}

/// Wait until a process has exited, reaped or not.
async fn wait_for_exit(pid: u32) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap_or_default();
        if status.is_empty() || status.contains("State:\tZ") {
            return;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Process {pid} did not exit."
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

const CALL_ACCESS: &str =
    "Access: the MCP server can perform actions outside Happy Agent’s filesystem sandbox";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn configured_servers_offer_their_tools_and_every_call_is_reviewed() {
    let (endpoint, mut requests, provider) = scripted_provider(18).await;
    let (url, seen, http) = serve_http().await;
    let installation = Installation::new();
    std::fs::create_dir_all(mcp_toml(&installation).parent().unwrap()).unwrap();
    std::fs::write(
        mcp_toml(&installation),
        format!(
            "{}\n[mcp_servers.remote]\nurl = {url:?}\nbearer_token_env_var = \"FIXTURE_TOKEN\"\nhttp_headers = {{ X-Fixture = \"yes\" }}\n\n[mcp_servers.broken]\ncommand = \"/nonexistent/mcp-server\"\n\n[mcp_servers.off]\ncommand = \"/nonexistent/other\"\nenabled = false\n",
            stdio_server("fixture", "stdio")
        ),
    )
    .unwrap();
    start(
        &installation,
        &endpoint,
        &[
            ("FIXTURE_TOKEN", "fixture-token"),
            ("FIXTURE_SECRET", "do-not-leak"),
        ],
    );
    create_agent(&installation).await;
    send(
        &installation,
        "messagemcpone",
        "Use the MCP servers.",
        "auto",
    )
    .await;
    let first = exchange(&mut requests).await;

    // The connected servers' tools are ordinary tools beside the protocol tools; a failed or
    // disabled server contributes none.
    let names = tool_names(&first.request);
    for expected in [
        "list_mcp_servers",
        "configure_mcp_server",
        "reload_mcp_servers",
        "mcp__fixture__echo",
        "mcp__fixture__environment",
        "mcp__fixture__fail",
        "mcp__fixture__ask",
        "mcp__remote__echo",
        "call_mcp_tool",
        "list_mcp_tools",
        "list_mcp_resources",
        "list_mcp_resource_templates",
        "read_mcp_resource",
        "list_mcp_prompts",
        "get_mcp_prompt",
    ] {
        assert!(
            names.iter().any(|name| name == expected),
            "{expected} in {names:?}"
        );
    }
    assert!(
        !names
            .iter()
            .any(|name| name.starts_with("mcp__broken__") || name.starts_with("mcp__off__")),
        "{names:?}"
    );
    assert!(
        tool_description(&first.request, "call_mcp_tool")
            .ends_with("Available servers: Fixture, Remote.")
    );

    // Calls and prompts are reviewed, whatever a server's annotations say; listings and reads are
    // not. Each review discloses that the server acts outside the sandbox.
    let main_model = first.request["model"].clone();
    let review = call(
        &mut requests,
        first,
        "c1",
        "mcp__fixture__echo",
        json!({"text": "hello"}),
    )
    .await;
    let review_model = review.request["model"].clone();
    assert_ne!(
        review_model, main_model,
        "The private reviewer uses the Source hidden same-account route."
    );
    let first_review_prompt = review.request["input"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|item| item["role"] == "user")
        .unwrap()["content"]
        .as_str()
        .unwrap()
        .to_owned();
    let (action, next) = allow(&mut requests, review).await;
    assert_eq!(
        action,
        format!(
            r#"calling "Echo" from "Fixture" with arguments "{{\"text\":\"hello\"}}". {CALL_ACCESS}"#
        )
    );
    assert_eq!(output(&next.request, "c1"), "hello");
    let next = call(&mut requests, next, "c2", "list_mcp_servers", json!({})).await;
    assert_not_review(&next.request);
    assert_eq!(
        output(&next.request, "c2"),
        "broken\tfailed\t0 tools — spawn /nonexistent/mcp-server ENOENT\nfixture\tconnected\t5 tools\noff\tdisabled\t0 tools\nremote\tconnected\t3 tools"
    );
    let review = call(
        &mut requests,
        next,
        "c3",
        "call_mcp_tool",
        json!({"server": "fixture", "name": "environment"}),
    )
    .await;
    assert_eq!(review.request["model"], review_model);
    let prompts: Vec<_> = review.request["input"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| item["role"] == "user")
        .map(|item| item["content"].as_str().unwrap())
        .collect();
    assert_eq!(
        prompts.len(),
        2,
        "The reused reviewer retains its own previous review."
    );
    assert_eq!(prompts[0], first_review_prompt);
    assert!(
        prompts[1].contains("<conversation continued=\"true\">"),
        "Source sends only the new evidence to the reused reviewer."
    );
    let (_, next) = allow(&mut requests, review).await;
    // A stdio server inherits only a small safe environment and what its configuration sets,
    // never the daemon's own credentials.
    let environment = output(&next.request, "c3");
    let variables: Vec<&str> = environment.lines().next().unwrap().split(',').collect();
    assert!(
        variables.contains(&FIXTURE) && variables.contains(&"PATH"),
        "{environment}"
    );
    for leaked in ["FIXTURE_SECRET", "FIXTURE_TOKEN", "HAPPY_HOME_DIR"] {
        assert!(
            !variables.contains(&leaked),
            "{leaked} reached the server: {environment}"
        );
    }
    let next = call(
        &mut requests,
        next,
        "c4",
        "read_mcp_resource",
        json!({"server": "fixture", "uri": "fixture://readme"}),
    )
    .await;
    assert_not_review(&next.request);
    assert_eq!(output(&next.request, "c4"), "Read me first.");
    let review = call(
        &mut requests,
        next,
        "c5",
        "get_mcp_prompt",
        json!({"server": "fixture", "name": "review"}),
    )
    .await;
    let (action, next) = allow(&mut requests, review).await;
    assert_eq!(
        action,
        r#"loading prompt "Review" from "Fixture". Access: the MCP server can return instructions from outside Happy Agent’s local sandbox"#
    );
    assert!(
        output(&next.request, "c5").contains("Review this change."),
        "{}",
        output(&next.request, "c5")
    );
    let review = call(
        &mut requests,
        next,
        "c6",
        "mcp__remote__echo",
        json!({"text": "over http"}),
    )
    .await;
    let (_, next) = allow(&mut requests, review).await;
    assert_eq!(output(&next.request, "c6"), "over http");
    let review = call(&mut requests, next, "c7", "mcp__fixture__fail", json!({})).await;
    let (action, next) = allow(&mut requests, review).await;
    assert!(
        action.starts_with(r#"calling "Fail" from "Fixture""#),
        "A read-only annotation is not trusted: {action}"
    );
    assert_eq!(output(&next.request, "c7"), "It broke.");
    let next = call(
        &mut requests,
        next,
        "c8",
        "list_mcp_tools",
        json!({"server": "remote"}),
    )
    .await;
    assert_not_review(&next.request);
    assert_eq!(
        output(&next.request, "c8"),
        "echo — Echo the text back.\nenvironment — List the environment variable names the server sees.\nfail — Fail as a tool."
    );
    let review = call(
        &mut requests,
        next,
        "c9",
        "call_mcp_tool",
        json!({"server": "nowhere", "name": "echo"}),
    )
    .await;
    let (action, next) = allow(&mut requests, review).await;
    assert!(
        action.starts_with(r#"calling "Echo" from "Nowhere""#),
        "{action}"
    );
    assert!(
        output(&next.request, "c9")
            .contains("Unknown MCP server \"nowhere\". Available servers: Fixture, Remote."),
        "{}",
        output(&next.request, "c9")
    );
    next.respond.send(text_response("Done.")).unwrap();
    settled(&installation, 1).await;

    // The HTTP server received the configured headers, the bearer token from the daemon's
    // environment, the session it issued, and the negotiated protocol version.
    let posts = seen.lock().unwrap().clone();
    let tool_call = posts
        .iter()
        .find(|(message, _)| message["method"] == "tools/call")
        .expect("an HTTP tool call");
    assert_eq!(tool_call.1["x-fixture"], "yes");
    assert_eq!(tool_call.1["mcp-session-id"], "fixture-session");
    assert_eq!(tool_call.1["mcp-protocol-version"], "2025-06-18");
    assert_eq!(tool_call.1["accept"], "application/json, text/event-stream");
    assert_eq!(
        posts[0].0["params"]["clientInfo"],
        json!({"name": "happy-agent", "version": "1.0.0"})
    );
    assert_eq!(
        posts[0].0["params"]["capabilities"],
        json!({"elicitation": {}})
    );

    // A durable index of what the agent saw is kept beside its history.
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    let rows: Vec<(String, String, i64, Option<String>)> = database
        .prepare("SELECT name, status, tool_count, error_message FROM mcp_module_index WHERE agent_id = ?1 ORDER BY name")
        .unwrap()
        .query_map([MCP_AGENT], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        rows,
        [
            (
                "broken".into(),
                "failed".into(),
                0,
                Some("spawn /nonexistent/mcp-server ENOENT".into())
            ),
            ("fixture".into(), "connected".into(), 5, None),
            ("off".into(), "disabled".into(), 0, None),
            ("remote".into(), "connected".into(), 3, None),
        ]
    );
    drop(database);

    // Outside Auto and Full access the MCP tools are refused rather than reviewed or run.
    send(
        &installation,
        "messagemcptwo",
        "Try it in workspace write.",
        "workspace_write",
    )
    .await;
    let turn = exchange(&mut requests).await;
    let next = call(
        &mut requests,
        turn,
        "w1",
        "mcp__fixture__echo",
        json!({"text": "contained?"}),
    )
    .await;
    assert_not_review(&next.request);
    assert_ne!(output(&next.request, "w1"), "contained?");
    next.respond.send(text_response("Understood.")).unwrap();
    settled(&installation, 2).await;

    // Stopping the daemon stops the servers it started.
    let pid: u32 = environment
        .lines()
        .find_map(|line| line.strip_prefix("pid="))
        .unwrap()
        .parse()
        .unwrap();
    assert!(Path::new(&format!("/proc/{pid}")).exists());
    installation.command("stop");
    wait_for_exit(pid).await;
    use sha2::{Digest, Sha256};
    let reviewer = format!(
        "r{}",
        &format!("{:x}", Sha256::digest(MCP_AGENT.as_bytes()))[..31]
    );
    let private = Connection::open(installation.home.join("agent/auto-agent.sqlite")).unwrap();
    assert_eq!(private.query_row::<i64, _, _>("SELECT count(*) FROM happy_agent_records WHERE owner_id=?1 AND json_extract(record_json,'$.type')='user'", [&reviewer], |row| row.get(0)).unwrap(), 6, "All six reviews retain one stable private identity and conversation.");
    let cursor: String = private
        .query_row(
            "SELECT value_json FROM happy_agent_values WHERE owner_id='' AND key=?1",
            [format!("agentSystem.autoCursor.{reviewer}")],
            |row| row.get(0),
        )
        .unwrap();
    let cursor: Value = serde_json::from_str(&cursor).unwrap();
    assert_eq!(cursor["lastReviewNormal"], true);
    assert_eq!(
        cursor["reportedOwnEntryCount"], 1,
        "A review capture contains only that review's response, despite retaining the private conversation."
    );
    http.abort();
    provider.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_servers_question_reaches_the_person_and_their_answer_returns_to_it() {
    let (endpoint, mut requests, provider) = scripted_provider(3).await;
    let installation = Installation::new();
    std::fs::create_dir_all(mcp_toml(&installation).parent().unwrap()).unwrap();
    std::fs::write(mcp_toml(&installation), stdio_server("fixture", "stdio")).unwrap();
    start(&installation, &endpoint, &[]);
    create_agent(&installation).await;
    send(&installation, "messagemcpask", "Deploy it.", "auto").await;
    let turn = exchange(&mut requests).await;
    let review = call(&mut requests, turn, "a1", "mcp__fixture__ask", json!({})).await;
    let action = reviewed_action(&review.request).expect("a private review");
    assert!(
        action.starts_with(r#"calling "Ask" from "Fixture""#),
        "{action}"
    );
    review.respond.send(text_response("<review><outcome>allow</outcome><risk_level>low</risk_level><user_authorization>high</user_authorization><rationale>The person asked for this.</rationale></review>")).unwrap();
    let (client, token) = installation.client();
    let question = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let body: Value = client
                .get(format!("http://happy/v0/agents/{MCP_AGENT}/question"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if body["question"].is_object() {
                break body["question"].clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the server's question opens");
    assert_eq!(
        question["questions"],
        json!([{
            "id": "environment", "header": "Environment", "question": "Which environment should receive the deploy?", "multiSelect": false,
            "options": [{"label": "staging", "description": "Use staging."}, {"label": "production", "description": "Use production."}],
        }])
    );
    let id = question["id"].as_str().unwrap();
    let answered = client
        .post(format!(
            "http://happy/v0/agents/{MCP_AGENT}/question/{id}/answer"
        ))
        .bearer_auth(&token)
        .json(&json!({"answers": {"environment": ["production"]}}))
        .send()
        .await
        .unwrap();
    assert_eq!(answered.status(), 200);
    let next = exchange(&mut requests).await;
    assert_eq!(
        output(&next.request, "a1"),
        r#"{"action":"accept","content":{"environment":"production"}}"#
    );
    next.respond.send(text_response("Deploying.")).unwrap();
    settled(&installation, 1).await;
    installation.command("stop");
    provider.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mcp_toml_edits_apply_without_a_restart() {
    let (endpoint, mut requests, provider) = scripted_provider(22).await;
    let installation = Installation::new();
    start(&installation, &endpoint, &[]);
    create_agent(&installation).await;
    let server = json!({
        "transport": "stdio",
        "command": std::env::current_exe().unwrap().display().to_string(),
        "args": ["--exact", "mcp_acceptance::fixture_server_process", "--nocapture", "--test-threads=1"],
        "env": {FIXTURE: "stdio"},
    });

    // Nothing is configured: only the listing and configuration tools are offered.
    send(
        &installation,
        "messagemcpadd",
        "Add the fixture server.",
        "auto",
    )
    .await;
    let turn = exchange(&mut requests).await;
    let first = tool_names(&turn.request);
    assert!(
        [
            "list_mcp_servers",
            "configure_mcp_server",
            "reload_mcp_servers"
        ]
        .iter()
        .all(|name| first.iter().any(|offered| offered == name)),
        "{first:?}"
    );
    assert!(
        !first
            .iter()
            .any(|name| name.starts_with("mcp__") || name == "call_mcp_tool"),
        "{first:?}"
    );
    let review = call(
        &mut requests,
        turn,
        "m1",
        "configure_mcp_server",
        json!({"action": "set", "name": "fixture", "server": server}),
    )
    .await;
    let (action, next) = allow(&mut requests, review).await;
    // Configuration edits are reviewed and disclose what they change.
    assert_eq!(
        action,
        "updating MCP server “fixture” in ~/Happy/Config/mcp.toml and reloading external MCP connections"
    );
    assert_eq!(output(&next.request, "m1"), "fixture\tconnected\t5 tools");
    // The very next request carries the new server's tools.
    assert!(tool_names(&next.request).contains(&"mcp__fixture__echo".to_string()));
    let review = call(
        &mut requests,
        next,
        "m2",
        "mcp__fixture__echo",
        json!({"text": "configured"}),
    )
    .await;
    let (_, next) = allow(&mut requests, review).await;
    assert_eq!(output(&next.request, "m2"), "configured");
    let review = call(
        &mut requests,
        next,
        "m3",
        "configure_mcp_server",
        json!({"action": "remove", "name": "fixture", "server": server}),
    )
    .await;
    let (_, next) = allow(&mut requests, review).await;
    assert_eq!(
        output(&next.request, "m3"),
        "Removing an MCP server must not include configuration."
    );
    next.respond.send(text_response("Configured.")).unwrap();
    settled(&installation, 1).await;
    let written = std::fs::read_to_string(mcp_toml(&installation)).unwrap();
    assert!(
        written.contains("[mcp_servers.fixture]") && written.contains("fixture_server_process"),
        "{written}"
    );

    // A workspace's own mcp.toml joins on reload; the user's entry keeps a colliding name until
    // it is removed and the workspace's takes the name.
    std::fs::write(
        workspace_folder(&installation).join("mcp.toml"),
        format!(
            "{}\n{}",
            stdio_server("local", "stdio"),
            stdio_server("fixture", "shadowed")
        ),
    )
    .unwrap();
    send(
        &installation,
        "messagemcpreload",
        "Reload the servers.",
        "auto",
    )
    .await;
    let turn = exchange(&mut requests).await;
    let review = call(&mut requests, turn, "r1", "reload_mcp_servers", json!({})).await;
    let (action, next) = allow(&mut requests, review).await;
    assert_eq!(
        action,
        "reconciling external MCP servers from this workspace's mcp.toml"
    );
    assert_eq!(
        output(&next.request, "r1"),
        "fixture\tconnected\t5 tools\nlocal\tconnected\t5 tools"
    );
    let review = call(
        &mut requests,
        next,
        "r2",
        "call_mcp_tool",
        json!({"server": "fixture", "name": "environment"}),
    )
    .await;
    let (_, next) = allow(&mut requests, review).await;
    assert!(
        output(&next.request, "r2").contains("\nmode=stdio\n"),
        "{}",
        output(&next.request, "r2")
    );
    let review = call(
        &mut requests,
        next,
        "r3",
        "configure_mcp_server",
        json!({"action": "remove", "name": "fixture"}),
    )
    .await;
    let (_, next) = allow(&mut requests, review).await;
    assert_eq!(
        output(&next.request, "r3"),
        "fixture\tconnected\t5 tools\nlocal\tconnected\t5 tools"
    );
    let review = call(
        &mut requests,
        next,
        "r4",
        "call_mcp_tool",
        json!({"server": "fixture", "name": "environment"}),
    )
    .await;
    let (_, next) = allow(&mut requests, review).await;
    assert!(
        output(&next.request, "r4").contains("\nmode=shadowed\n"),
        "{}",
        output(&next.request, "r4")
    );
    next.respond.send(text_response("Reloaded.")).unwrap();
    settled(&installation, 2).await;
    assert!(
        !std::fs::read_to_string(mcp_toml(&installation))
            .unwrap()
            .contains("[mcp_servers.fixture]")
    );

    // A server that stops on its own is shown as failed until a reload starts it again.
    send(
        &installation,
        "messagemcpstop",
        "Stop the local server.",
        "auto",
    )
    .await;
    let turn = exchange(&mut requests).await;
    let review = call(&mut requests, turn, "s1", "mcp__local__exit", json!({})).await;
    let (_, next) = allow(&mut requests, review).await;
    let stopped = output(&next.request, "s1");
    let pid: u32 = stopped
        .strip_prefix("Stopping ")
        .and_then(|rest| rest.strip_suffix('.'))
        .unwrap()
        .parse()
        .unwrap();
    wait_for_exit(pid).await;
    let next = call(&mut requests, next, "s2", "list_mcp_servers", json!({})).await;
    assert_eq!(
        output(&next.request, "s2"),
        "fixture\tconnected\t5 tools\nlocal\tfailed\t0 tools — The MCP server stopped."
    );
    let review = call(&mut requests, next, "s3", "reload_mcp_servers", json!({})).await;
    let (_, next) = allow(&mut requests, review).await;
    assert_eq!(
        output(&next.request, "s3"),
        "fixture\tconnected\t5 tools\nlocal\tconnected\t5 tools"
    );
    next.respond.send(text_response("Back.")).unwrap();
    settled(&installation, 3).await;
    installation.command("stop");
    provider.await.unwrap();
}
