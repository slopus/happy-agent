use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn codex_command_text(message: &happy_providers::Message) -> (&str, &str) {
    let happy_providers::Message::Tool {
        content,
        is_error: false,
        ..
    } = message
    else {
        panic!("{message:?}")
    };
    let happy_providers::Block::Text { text } = &content[0] else {
        panic!("{content:?}")
    };
    // Source formatUnifiedExecOutput renders the model-visible status and
    // output as text. These short fixtures have no truncation metadata.
    let (wall_time, sections) = text.split_once('\n').expect("Missing Codex wall time.");
    assert!(
        wall_time.starts_with("Wall time: ") && wall_time.ends_with(" seconds"),
        "{text}"
    );
    let (status, output) = sections
        .split_once("\nOutput:\n")
        .expect("Missing Codex output section.");
    assert!(!status.contains('\n'), "Unexpected Codex metadata: {text}");
    (status, output)
}

#[tokio::test]
async fn docker_output_preserves_split_frames_and_separate_stderr_without_disclosing_it() {
    let (mut input, read) = tokio::io::duplex(128);
    let (write, mut output) = tokio::io::duplex(128);
    let task = tokio::spawn(engine::stdout(read, write, CancellationToken::new()));
    for (channel, text) in [
        (1u8, b"hello".as_slice()),
        (2, b"secret-diagnostic".as_slice()),
        (1, b"world".as_slice()),
    ] {
        let mut bytes = vec![channel, 0, 0, 0];
        bytes.extend_from_slice(&(text.len() as u32).to_be_bytes());
        bytes.extend_from_slice(text);
        for byte in bytes {
            input.write_all(&[byte]).await.unwrap();
        }
    }
    drop(input);
    let mut bytes = Vec::new();
    output.read_to_end(&mut bytes).await.unwrap();
    task.await.unwrap().unwrap();
    assert_eq!(bytes, b"helloworld");
    // A clean stream EOF is complete; a partial Engine header is an unproven
    // carrier failure and cannot masquerade as a successful worker shutdown.
    let (mut input, read) = tokio::io::duplex(128);
    input.write_all(&[1, 0]).await.unwrap();
    drop(input);
    assert!(
        engine::stdout(read, tokio::io::sink(), CancellationToken::new())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn container_frames_reject_oversized_and_truncated_payloads() {
    for bytes in [vec![4, 0, 0, 1], vec![0, 0, 0, 3, 1, 2]] {
        let (mut writer, reader) = tokio::io::duplex(128);
        writer.write_all(&bytes).await.unwrap();
        drop(writer);
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        assert!(framing::read(reader, sender).await.is_err());
        assert!(receiver.recv().await.is_none());
    }
}

#[test]
fn selected_docker_preserves_source_image_mounts_and_inner_sandbox_admission() {
    let directory = tempfile::tempdir().unwrap();
    let mut config = ConfigModule::isolated(&directory.path().join("private")).unwrap();
    let configuration = json!({"modules":{"compute":{"cwd":directory.path(),"docker":{"image":"original-configured-image"}}}});
    let selected = config
        .docker_configuration("selected", &configuration)
        .unwrap();
    assert_eq!(
        selected.request["docker"]["image"],
        "original-configured-image"
    );
    assert_eq!(
        selected.request["docker"]["mounts"],
        json!([{"source":directory.path(),"target":directory.path()}])
    );
    let creation = container_request(&selected, "selected").unwrap();
    assert_eq!(creation["Image"], "original-configured-image");
    assert!(creation["HostConfig"].get("Privileged").is_none());
    assert_eq!(
        creation["HostConfig"]["SecurityOpt"],
        json!(["seccomp=unconfined", "apparmor=unconfined"])
    );
    assert_eq!(creation["HostConfig"]["MaskedPaths"], json!([]));
    assert_eq!(creation["HostConfig"]["ReadonlyPaths"], json!([]));
    assert_eq!(
        creation["HostConfig"]["Devices"],
        json!([{"PathOnHost":"/dev/fuse","PathInContainer":"/dev/fuse","CgroupPermissions":"rw"}])
    );
    assert!(creation["Env"].as_array().unwrap().is_empty());
    assert!(
        creation["HostConfig"]["Mounts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|mount| mount["Target"] == engine::EXECUTABLE && mount["ReadOnly"] == true)
    );
    config.set_container_worker_fixture();
    let private = directory.path().join("declared-private");
    let caller_denied = directory.path().join("caller-denied");
    let request = json!({"computeId":"container-policy","cwd":directory.path(),"policy":{"privateDirectories":[private]}});
    let policy = config
        .runner_shell_policy(
            &request,
            &json!({"mode":"workspace_write","deniedReadPaths":[caller_denied],"network":{"egress":false,"localBinding":false}}),
        )
        .unwrap();
    let home = config.runner_file_environment(&request).unwrap().home;
    let denied = policy["deniedReadPaths"].as_array().unwrap();
    assert!(denied.contains(&json!(private)));
    assert!(denied.contains(&json!(caller_denied)));
    assert!(
        !denied.contains(&json!(home)),
        "Source does not declare the image's whole home private: {policy}"
    );
    assert!(
        !denied.contains(&json!(home.join(".ssh"))),
        "Image credential paths require an explicit Docker policy: {policy}"
    );
}

struct Fixture {
    directory: tempfile::TempDir,
    root: std::path::PathBuf,
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    lifecycle: Arc<LifecycleModule>,
    runners: Arc<RunnersModule>,
    docker: Arc<DockerModule>,
    history: Arc<crate::product::history::HistoryModule>,
    secrets: Arc<crate::product::secrets::SecretsModule>,
    tools: Arc<crate::product::tools::ToolsModule>,
    configuration: Value,
    agent: String,
}
impl Fixture {
    async fn new() -> Self {
        Self::with_worker(false).await
    }
    async fn with_worker(worker: bool) -> Self {
        Self::setup(worker, true).await
    }
    async fn setup(worker: bool, start: bool) -> Self {
        crate::product::process::prepare_child_reaping().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("workspace");
        std::fs::create_dir(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Source's live Docker fixture permits the image's root identity to
            // write through a host bind after entering its user namespace.
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o777)).unwrap();
        }
        let mut config = ConfigModule::isolated(&directory.path().join("private")).unwrap();
        if worker {
            config.set_container_worker_fixture();
        }
        let config = Arc::new(config);
        let runtime = Arc::new(RuntimeModule::new(config.clone()));
        runtime.load().await.unwrap();
        let lifecycle = Arc::new(LifecycleModule::new(config.clone()).unwrap());
        let durable =
            Arc::new(DurableFunctionsModule::new(runtime.clone(), lifecycle.clone()).unwrap());
        durable.load().await.unwrap();
        let events = Arc::new(crate::product::events::EventsModule::new(runtime.clone()).unwrap());
        events.load().await.unwrap();
        let usage = Arc::new(
            crate::product::usage::UsageModule::new(
                runtime.clone(),
                events.clone(),
                config.clone(),
            )
            .unwrap(),
        );
        usage.load().await.unwrap();
        let history = Arc::new(
            crate::product::history::HistoryModule::new(
                config.clone(),
                runtime.clone(),
                events.clone(),
                usage,
            )
            .unwrap(),
        );
        history.load().await.unwrap();
        let secrets = crate::product::secrets::SecretsModule::new(
            config.clone(),
            runtime.clone(),
            durable.clone(),
            events.clone(),
        )
        .unwrap();
        secrets.load().await.unwrap();
        let services = crate::product::services::ServicesModule::new(
            config.clone(),
            runtime.clone(),
            durable.clone(),
            lifecycle.clone(),
            events.clone(),
        )
        .unwrap();
        let runners =
            RunnersModule::new(config.clone(), runtime.clone(), lifecycle.clone()).unwrap();
        runners.load().await.unwrap();
        let docker = DockerModule::new(
            config.clone(),
            runtime.clone(),
            durable.clone(),
            lifecycle.clone(),
            runners.clone(),
        )
        .unwrap();
        docker.load().await.unwrap();
        let tools = Arc::new(
            crate::product::tools::ToolsModule::new(
                config.clone(),
                history.clone(),
                lifecycle.clone(),
                runtime.clone(),
                secrets.clone(),
                services,
                events,
                runners.clone(),
                docker.clone(),
            )
            .unwrap(),
        );
        if start {
            durable.start().await.unwrap();
        }
        let agent = cuid2::create_id();
        let configuration =
            json!({"modules":{"compute":{"cwd":root,"docker":{"image":"ubuntu:24.04"}}}});
        Self {
            directory,
            root,
            config,
            runtime,
            durable,
            lifecycle,
            runners,
            docker,
            history,
            secrets,
            tools,
            configuration,
            agent,
        }
    }
    async fn close(&self) {
        self.tools.close().await;
        self.lifecycle.begin_shutdown();
        self.durable.stop().await;
        self.runners.close().await;
        self.runtime.close().await.unwrap();
    }
    async fn file(&self, name: &str, args: Value, mode: &str) -> happy_providers::Message {
        use happy_agent_base::AgentModule;
        let model = if matches!(
            name,
            "apply_patch" | "exec_command" | "write_stdin" | "kill_session"
        ) {
            "openai/gpt-6.1-sol"
        } else {
            "xai/grok-4.7"
        };
        let settings = json!({"permissionMode":mode,"model":model});
        let call =
            json!({"id":cuid2::create_id(),"call":{"name":name,"arguments":args.to_string()}});
        let history = self.history.clone();
        let agent = self.agent.clone();
        let record = json!({"role":"assistant","recordId":cuid2::create_id(),"blocks":[{"type":"tool_call","callId":call["id"],"name":name,"arguments":args}]});
        self.runtime
            .transact(move |ctx| history.append(ctx, &agent, &record))
            .await
            .unwrap();
        self.tools
            .before_tool(
                &happy_agent_base::AgentScope {
                    id: &self.agent,
                    configuration: &self.configuration,
                    settings: &settings,
                },
                &call,
            )
            .await
            .unwrap();
        let outcome = self
            .tools
            .execute(
                &self.agent,
                &self.configuration,
                &settings,
                &call,
                CancellationToken::new(),
            )
            .await;
        let tools = self.tools.clone();
        let agent = self.agent.clone();
        let cfg = self.configuration.clone();
        let message = outcome.message.clone();
        self.runtime
            .transact(move |ctx| {
                tools.before_tool_result(
                    ctx,
                    &happy_agent_base::AgentScope {
                        id: &agent,
                        configuration: &cfg,
                        settings: &settings,
                    },
                    &call,
                    &message,
                )
            })
            .await
            .unwrap();
        outcome.message
    }
}

#[tokio::test]
async fn docker_intent_joins_rollback_and_missing_engine_never_reads_or_runs_on_the_host() {
    let fixture = Fixture::new().await;
    let requested = fixture
        .config
        .docker_configuration(&fixture.agent, &fixture.configuration)
        .unwrap()
        .request;
    let module = fixture.docker.clone();
    let id = fixture.agent.clone();
    let rolled_back:Result<()>=fixture.runtime.transact(move|ctx| {
        persistence::put_record(ctx,&id,&json!({"request":requested,"closing":false}))?;
        module.durable.invoke(ctx,&json!({"function":"docker.environment","operationId":"rolled-back-docker","arguments":requested}))?;
        anyhow::bail!("Rollback this Docker start intent.")
    }).await;
    assert!(rolled_back.is_err());
    let id = fixture.agent.clone();
    assert!(
        fixture
            .runtime
            .transact(move |ctx| persistence::query_record(ctx, &id))
            .await
            .unwrap()
            .is_none()
    );
    std::fs::write(fixture.root.join("marker"), "host data must remain here").unwrap();
    let missing = fixture.directory.path().join("absent-engine.sock");
    let request = json!({"computeId":"missing-engine","cwd":fixture.root,"docker":{"image":"ubuntu:24.04","workingDirectory":fixture.root,"socketPath":missing}});
    let result = fixture
        .docker
        .compute(&request, &CancellationToken::new())
        .await;
    assert!(result.is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("marker")).unwrap(),
        "host data must remain here"
    );
    // There was no acquired container. Cancellation leaves only idempotent
    // cleanup, and shutdown must not go looking for a different host socket.
    fixture.lifecycle.begin_shutdown();
    fixture.durable.stop().await;
    fixture.runners.close().await;
    fixture.runtime.close().await.unwrap();
}

#[tokio::test]
async fn container_file_calls_keep_read_knowledge_diffs_and_the_reviewed_symlink_target() {
    let fixture = Fixture::with_worker(true).await;
    let configuration = json!({"modules":{"compute":{"cwd":fixture.root}},"_dockerRequest":{"computeId":"worker-files","cwd":fixture.root}});
    let cancel = CancellationToken::new();
    std::fs::write(fixture.root.join("known.txt"), "before\n").unwrap();
    // This nanosecond timestamp exposes lossy JSON parsing of retained read
    // knowledge: a second operation must observe the exact first read stamp.
    std::fs::File::open(fixture.root.join("known.txt"))
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::new(1_791_615_436, 209_500))
        .unwrap();
    let call = json!({"id":cuid2::create_id(),"call":{"name":"read_file","arguments":json!({"target_file":"known.txt"}).to_string()}});
    let mut request = json!({"computeId":"worker-files","agent":fixture.agent,"vendor":"grok","mode":"workspace_write","call":call,"reads":[]});
    let policy = fixture
        .tools
        .container_file_policy(&configuration, &request)
        .unwrap();
    request["bindings"] = policy["bindings"].clone();
    let read = fixture
        .tools
        .container_file_tool(&configuration, &request, &cancel)
        .await
        .unwrap();
    assert_eq!(read["isError"], false);
    assert_eq!(read["reads"].as_array().unwrap().len(), 1);
    request["call"] = json!({"id":cuid2::create_id(),"call":{"name":"search_replace","arguments":json!({"file_path":"known.txt","old_string":"before","new_string":"after"}).to_string()}});
    request["reads"] = json!([{"path":fixture.root.join("known.txt"),"mtimeMs":0}]);
    request["bindings"] = fixture
        .tools
        .container_file_policy(&configuration, &request)
        .unwrap()["bindings"]
        .clone();
    let unproven = fixture
        .tools
        .container_file_tool(&configuration, &request, &cancel)
        .await
        .unwrap();
    assert_eq!(unproven["isError"], true);
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("known.txt")).unwrap(),
        "before\n"
    );
    request["reads"] = read["reads"].clone();
    request["call"]["id"] = json!(cuid2::create_id());
    let edited = fixture
        .tools
        .container_file_tool(&configuration, &request, &cancel)
        .await
        .unwrap();
    assert_eq!(edited["isError"], false, "{edited}");
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("known.txt")).unwrap(),
        "after\n"
    );
    assert_eq!(edited["presentation"]["type"], "file_diff");
    assert!(edited["presentation"].to_string().contains("before"));
    #[cfg(unix)]
    {
        let outside = fixture.directory.path().join("outside.txt");
        std::fs::write(&outside, "keep outside\n").unwrap();
        let link = fixture.root.join("reviewed-link");
        std::os::unix::fs::symlink(fixture.root.join("known.txt"), &link).unwrap();
        request["call"] = json!({"id":cuid2::create_id(),"call":{"name":"write","arguments":json!({"file_path":"reviewed-link","content":"must not escape"}).to_string()}});
        request["mode"] = json!("auto");
        let reviewed = fixture
            .tools
            .container_file_policy(&configuration, &request)
            .unwrap();
        assert_eq!(reviewed["review"], false);
        request["bindings"] = reviewed["bindings"].clone();
        std::fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        request["mode"] = json!("full_access");
        let replaced = fixture
            .tools
            .container_file_tool(&configuration, &request, &cancel)
            .await
            .unwrap();
        assert_eq!(replaced["isError"], true);
        assert_eq!(std::fs::read_to_string(outside).unwrap(), "keep outside\n");
    }
    fixture.close().await;
}

#[tokio::test]
#[ignore = "Requires a disposable Linux Docker engine, ubuntu:24.04 and the built single executable."]
async fn native_docker_recovers_abandoned_ownership_and_preserves_attached_containers_and_environment()
 {
    use futures_util::FutureExt;
    assert!(std::env::var_os("HAPPY_AGENT_TEST_COMPUTE_BINARY").is_some());
    let fixture = Fixture::setup(false, false).await;
    let outcome=std::panic::AssertUnwindSafe(async {
    let id = format!("recovered-{}", fixture.agent);
    let name = format!("compute-{id}");
    let request = json!({"computeId":id,"cwd":fixture.root,"docker":{"image":"ubuntu:24.04","workingDirectory":fixture.root,"mounts":[{"source":fixture.root,"target":fixture.root}]}});
    let selected = fixture
        .config
        .docker_runner_configuration(&request)
        .unwrap();
    let engine = engine::Engine {
        socket: selected.socket.clone(),
    };
    let creation = engine
        .call(
            "POST",
            &format!("/containers/create?name={name}"),
            &container_request(&selected, &id).unwrap(),
        )
        .await
        .unwrap();
    let container = creation["Id"].clone();
    engine
        .call(
            "POST",
            &format!("/containers/{}/start", container.as_str().unwrap()),
            &Value::Null,
        )
        .await
        .unwrap();
    let record = json!({"request":request,"closing":false,"container":container});
    let durable = fixture.durable.clone();
    let identity = id.clone();
    fixture.runtime.transact(move|ctx| {
        persistence::put_record(ctx,&identity,&record)?;
        durable.invoke(ctx,&json!({"function":"docker.environment","operationId":format!("docker-{identity}"),"arguments":record["request"],"lockKeys":[format!("docker-{identity}")]}))?;
        Ok(())
    }).await.unwrap();
    fixture.docker.load().await.unwrap();
    fixture.durable.start().await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(45), async {
        loop {
            let identity = id.clone();
            if fixture
                .runtime
                .transact(move |ctx| persistence::query_record(ctx, &identity))
                .await
                .unwrap()
                .is_none()
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        engine
            .call("GET", &format!("/containers/{name}/json"), &Value::Null)
            .await
            .unwrap_err()
            .downcast_ref::<engine::NotFound>()
            .is_some()
    );
    let cancel = CancellationToken::new();
    let id = format!("environment-{}", fixture.agent);
    let request = json!({"computeId":id,"cwd":fixture.root,"docker":{"image":"ubuntu:24.04","workingDirectory":fixture.root,"mounts":[{"source":fixture.root,"target":fixture.root}],"environment":{"COMPUTE_ALLOWED":"configured-value","COMPUTE_PRIVATE_DIR":"/tmp/configured-private"},"hostPolicy":{"privatePathVariables":["COMPUTE_PRIVATE_DIR"],"readableDirectories":["/tmp/configured-readable"]}}});
    let compute = fixture.docker.compute(&request, &cancel).await.unwrap();
    let full = compute.permissions("full_access").unwrap();
    let write = compute.permissions("workspace_write").unwrap();
    let process=compute.start(json!({"command":"test \"$COMPUTE_ALLOWED\" = configured-value && test -z \"${CARGO_MANIFEST_DIR+x}\" && test -r /opt/happy-agent/compute && printf configured","permissions":full}),&cancel).await.unwrap();
    let result = process.read(5000, false, &cancel).await.unwrap().unwrap();
    assert_eq!(result["exitCode"], 0, "{result}");
    assert_eq!(result["stdoutDelta"], "configured");
    for directory in ["/tmp/configured-private", "/tmp/configured-readable"] {
        compute
            .mkdir(&full, std::path::Path::new(directory), &cancel)
            .await
            .unwrap();
    }
    compute
        .write_file(
            &full,
            std::path::Path::new("/tmp/configured-private/value"),
            b"private",
            &cancel,
        )
        .await
        .unwrap();
    compute
        .write_file(
            &full,
            std::path::Path::new("/tmp/configured-readable/value"),
            b"readable",
            &cancel,
        )
        .await
        .unwrap();
    assert!(
        compute
            .read_file(
                &write,
                std::path::Path::new("/tmp/configured-private/value"),
                64,
                false,
                &cancel
            )
            .await
            .is_err()
    );
    assert_eq!(
        compute
            .read_file(
                &write,
                std::path::Path::new("/tmp/configured-readable/value"),
                64,
                false,
                &cancel
            )
            .await
            .unwrap(),
        b"readable"
    );
    assert!(
        compute
            .write_file(
                &write,
                std::path::Path::new("/tmp/configured-readable/value"),
                b"forbidden",
                &cancel
            )
            .await
            .is_err()
    );
    assert_eq!(
        compute
            .read_file(
                &full,
                std::path::Path::new("/tmp/configured-private/value"),
                64,
                false,
                &cancel
            )
            .await
            .unwrap(),
        b"private"
    );
    let name = format!("compute-{id}");
    let details = engine
        .call("GET", &format!("/containers/{name}/json"), &Value::Null)
        .await
        .unwrap();
    assert_eq!(details["Config"]["Image"], "ubuntu:24.04");
    assert_eq!(details["HostConfig"]["Privileged"], false);
    let attached_id = format!("attached-{}", fixture.agent);
    let attached_request = json!({"computeId":attached_id,"cwd":fixture.root,"docker":{"container":details["Id"],"workingDirectory":fixture.root}});
    let attached = fixture
        .docker
        .compute(&attached_request, &cancel)
        .await
        .unwrap();
    let live = attached
        .start(
            json!({"command":"sleep 300 & wait","permissions":full}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        live.read(0, true, &cancel).await.unwrap().unwrap()["status"],
        "running"
    );
    fixture.docker.dispose(&attached_id).await.unwrap();
    assert!(
        engine
            .call("GET", &format!("/containers/{name}/json"), &Value::Null)
            .await
            .is_ok()
    );
    fixture.docker.dispose(&id).await.unwrap();
    assert!(
        engine
            .call("GET", &format!("/containers/{name}/json"), &Value::Null)
            .await
            .unwrap_err()
            .downcast_ref::<engine::NotFound>()
            .is_some()
    );
    }).catch_unwind().await;
    fixture.close().await;
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
}

#[tokio::test]
#[ignore = "Requires a disposable Linux Docker engine, ubuntu:24.04 and the built single executable."]
async fn native_docker_owns_skills_files_stdin_pty_processes_permissions_and_cleanup() {
    use futures_util::FutureExt;
    assert!(
        std::env::var_os("HAPPY_AGENT_TEST_COMPUTE_BINARY").is_some(),
        "Build the single executable and select it for this native test."
    );
    let fixture = Fixture::new().await;
    let outcome=std::panic::AssertUnwindSafe(async {
    let skill = fixture.root.join(".agents/skills/container-skill");
    std::fs::create_dir_all(&skill).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: container-skill\ndescription: Container proof\n---\nContainer-only skill.",
    )
    .unwrap();
    let cancel = CancellationToken::new();
    let settings = json!({"permissionMode":"workspace_write"});
    let fs = fixture
        .tools
        .compute_filesystem(
            &happy_agent_base::AgentScope {
                id: &fixture.agent,
                configuration: &fixture.configuration,
                settings: &settings,
            },
            &cancel,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(!fs.is_native());
    assert!(fs.exists(&skill.join("SKILL.md"), &cancel).await.unwrap());
    assert!(
        String::from_utf8(
            fs.read_file(&skill.join("SKILL.md"), 4096, true, &cancel)
                .await
                .unwrap()
        )
        .unwrap()
        .contains("Container-only skill")
    );
    let compute = fixture
        .docker
        .agent_compute(&fixture.agent, &fixture.configuration, &cancel)
        .await
        .unwrap();
    let full = compute.permissions("full_access").unwrap();
    let write = compute.permissions("workspace_write").unwrap();
    let secrets = fixture.secrets.clone();
    let agent = fixture.agent.clone();
    fixture.runtime.transact(move|ctx| {
        secrets.create(ctx,&json!({"id":"container-selected","description":"Selected container environment fixture","environment":{"COMPUTE_SELECTED":"selected-fixture-value"}}),None)?;
        secrets.create(ctx,&json!({"id":"container-hidden","description":"Omitted container environment fixture","environment":{"COMPUTE_HIDDEN":"hidden-fixture-value"}}),None)?;
        for id in ["container-selected","container-hidden"] {secrets.attach(ctx,id,&json!({"type":"agent","id":agent}),None)?;}
        Ok(())
    }).await.unwrap();
    let omitted=fixture.file("exec_command",json!({"cmd":"test -z \"${COMPUTE_SELECTED+x}\" && test -z \"${COMPUTE_HIDDEN+x}\" && test -z \"${CARGO_MANIFEST_DIR+x}\" && test -z \"${HAPPY_CONTAINER_WORKER+x}\" && printf hidden","yield_time_ms":1000}),"full_access").await;
    let (status, output) = codex_command_text(&omitted);
    assert_eq!(status, "Process exited with code 0", "{omitted:?}");
    assert_eq!(output, "hidden");
    std::fs::write(
        fixture.root.join("selected-fixture-expected"),
        "selected-fixture-value\n",
    )
    .unwrap();
    let selected=fixture.file("exec_command",json!({"cmd":"read -r expected < selected-fixture-expected && test \"$COMPUTE_SELECTED\" = \"$expected\" && test -z \"${COMPUTE_HIDDEN+x}\" && printf selected","secrets":["container-selected"],"yield_time_ms":1000}),"full_access").await;
    let (status, output) = codex_command_text(&selected);
    assert_eq!(status, "Process exited with code 0", "{selected:?}");
    assert_eq!(output, "selected");
    let protected = fixture.root.join("happy.toml");
    assert!(
        compute
            .write_file(&write, &protected, b"must remain absent", &cancel)
            .await
            .is_err()
    );
    assert!(!protected.exists());
    compute
        .write_file(
            &write,
            &fixture.root.join("plain.txt"),
            b"container bytes",
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(fixture.root.join("plain.txt")).unwrap(),
        b"container bytes"
    );
    let process=compute.start(json!({"command":"printf ready; read -r line; printf 'received:%s' \"$line\"; printf stderr >&2","permissions":full}),&cancel).await.unwrap();
    assert_eq!(
        process.read(2000, false, &cancel).await.unwrap().unwrap()["stdoutDelta"],
        "ready"
    );
    assert!(process.write(&full, b"input\n", &cancel).await.unwrap());
    let result = process.read(5000, false, &cancel).await.unwrap().unwrap();
    assert_eq!(result["status"], "completed");
    assert_eq!(result["stdoutDelta"], "received:input");
    assert_eq!(result["stderrDelta"], "stderr");
    assert_eq!(
        process.read(0, false, &cancel).await.unwrap().unwrap()["stdoutDelta"],
        ""
    );
    let program=compute.program(&json!({"command":"/bin/sh","args":["-c","test -t 0 && read -r line && stty size && printf 'pty:%s' \"$line\""],"terminal":{"cols":91,"rows":31,"name":"xterm"}}),&cancel).await.unwrap();
    program.resize(103, 37, &cancel).await.unwrap();
    let mut out = program.take_stdout().unwrap();
    let mut err = program.take_stderr().unwrap();
    program.write(b"terminal input\n", &cancel).await.unwrap();
    program.end_input(&cancel).await.unwrap();
    let mut output = Vec::new();
    while let Some(bytes) = out.recv().await.unwrap() {
        output.extend(bytes);
    }
    while err.recv().await.unwrap().is_some() {}
    assert_eq!(program.wait().await.unwrap().exit_code, Some(0));
    let output = String::from_utf8_lossy(&output);
    assert!(output.contains("37 103"), "{output}");
    assert!(output.contains("pty:terminal input"), "{output}");
    let allowed=compute.start(json!({"command":"printf inspected","permissions":compute.permissions("read_only").unwrap()}),&cancel).await.unwrap();
    let result=allowed.read(5000,false,&cancel).await.unwrap().unwrap();assert_eq!(result["exitCode"],0,"A restricted read-only shell did not start in the configured Docker image: {result}");assert_eq!(result["stdoutDelta"],"inspected");
    let allowed=compute.start(json!({"command":"printf allowed > allowed-shell.txt","permissions":write}),&cancel).await.unwrap();
    let result=allowed.read(5000,false,&cancel).await.unwrap().unwrap();assert_eq!(result["exitCode"],0,"A restricted workspace-write shell did not start in the configured Docker image: {result}");assert_eq!(std::fs::read(fixture.root.join("allowed-shell.txt")).unwrap(),b"allowed");
    let restricted = compute
        .start(
            json!({"command":"printf forbidden > happy.toml","permissions":write}),
            &cancel,
        )
        .await
        .unwrap();
    let result = restricted
        .read(5000, false, &cancel)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(result["exitCode"], 0, "{result}");
    assert_ne!(result["exitCode"], 125, "This must prove the workload's protected-path refusal after successful sandbox admission: {result}");
    assert!(!protected.exists());
    let file = fixture
        .file(
            "apply_patch",
            json!({"patch":"*** Begin Patch\n*** Add File: edited.txt\n+original\n*** End Patch"}),
            "workspace_write",
        )
        .await;
    assert!(
        matches!(
            file,
            happy_providers::Message::Tool {
                is_error: false,
                ..
            }
        ),
        "{file:?}"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("edited.txt")).unwrap(),
        "original\n"
    );
    let knowledge = fixture
        .file(
            "read_file",
            json!({"target_file":"edited.txt"}),
            "workspace_write",
        )
        .await;
    assert!(
        matches!(
            knowledge,
            happy_providers::Message::Tool {
                is_error: false,
                ..
            }
        ),
        "{knowledge:?}"
    );
    let id = fixture.agent.clone();
    let history=fixture.runtime.transact(move|ctx| {
        let reads=ctx.value(&id,&format!("kv.{id}.module.compute.reads"))?.unwrap();
        let mut statement=ctx.database().prepare("SELECT value_json FROM happy_agent_values WHERE owner_id=?1 AND key LIKE 'native.history.toolPresentation.%'")?;
        let diffs=statement.query_map([id],|row|row.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok((reads,diffs))
    }).await.unwrap();
    assert!(
        history
            .0
            .as_array()
            .unwrap()
            .iter()
            .any(|read| read["path"].as_str().unwrap().ends_with("edited.txt"))
    );
    assert!(
        history
            .1
            .iter()
            .any(|diff| diff.contains("original") && diff.contains("file_diff"))
    );
    let selected = fixture
        .config
        .docker_configuration(&fixture.agent, &fixture.configuration)
        .unwrap();
    #[cfg(unix)]
    {
        let outside = std::path::PathBuf::from(format!("/tmp/{}-outside.txt", fixture.agent));
        compute
            .write_file(&full, &outside, b"container outside", &cancel)
            .await
            .unwrap();
        std::os::unix::fs::symlink(&outside, fixture.root.join("outside-link")).unwrap();
        let denied = fixture
            .file(
                "write",
                json!({"file_path":"outside-link","content":"forbidden"}),
                "workspace_write",
            )
            .await;
        assert!(
            matches!(
                denied,
                happy_providers::Message::Tool { is_error: true, .. }
            ),
            "{denied:?}"
        );
        assert_eq!(
            compute
                .read_file(&full, &outside, 4096, false, &cancel)
                .await
                .unwrap(),
            b"container outside"
        );
        let settings = json!({"permissionMode":"auto","model":"xai/grok-4.7"});
        let call = json!({"id":cuid2::create_id(),"call":{"name":"write","arguments":json!({"file_path":"plain.txt","content":"reviewed bytes"}).to_string()}});
        use happy_agent_base::AgentModule;
        fixture
            .tools
            .before_tool(
                &happy_agent_base::AgentScope {
                    id: &fixture.agent,
                    configuration: &fixture.configuration,
                    settings: &settings,
                },
                &call,
            )
            .await
            .unwrap();
        std::fs::remove_file(fixture.root.join("plain.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, fixture.root.join("plain.txt")).unwrap();
        let outcome = fixture
            .tools
            .execute(
                &fixture.agent,
                &fixture.configuration,
                &json!({"permissionMode":"full_access","model":"xai/grok-4.7"}),
                &call,
                cancel.clone(),
            )
            .await;
        assert!(
            matches!(
                outcome.message,
                happy_providers::Message::Tool { is_error: true, .. }
            ),
            "{:?}",
            outcome.message
        );
        assert_eq!(
            compute
                .read_file(&full, &outside, 4096, false, &cancel)
                .await
                .unwrap(),
            b"container outside"
        );
    }
    let engine = engine::Engine {
        socket: selected.socket,
    };
    let name = format!("compute-agent-{}", fixture.agent);
    assert!(
        engine
            .call("GET", &format!("/containers/{name}/json"), &Value::Null)
            .await
            .is_ok()
    );
    let live = compute
        .start(
            json!({"command":"sleep 300 & wait","permissions":full}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(
        live.read(0, true, &cancel).await.unwrap().unwrap()["status"],
        "running"
    );
    let descendant = fixture
        .file(
            "exec_command",
            json!({"cmd":"sleep 300 & wait","yield_time_ms":1000}),
            "full_access",
        )
        .await;
    assert!(
        matches!(
            descendant,
            happy_providers::Message::Tool {
                is_error: false,
                ..
            }
        ),
        "{descendant:?}"
    );
    let (status, output) = codex_command_text(&descendant);
    assert_eq!(output, "(no new output)");
    let id = status
        .strip_prefix("Process running with session ID ")
        .expect("The live command must expose its Codex session ID.")
        .parse::<u64>()
        .unwrap();
    assert!(id > 0, "{descendant:?}");
    fixture
        .tools
        .hard_kill_agent_processes(&fixture.agent)
        .await
        .unwrap();
    let stopped = fixture
        .file(
            "write_stdin",
            json!({"session_id":id,"chars":"","yield_time_ms":1000}),
            "full_access",
        )
        .await;
    let (status, output) = codex_command_text(&stopped);
    // Source deliberately omits exit_code for a signal-stopped session. Its
    // terminal text also carries no running session ID.
    assert_eq!(
        status,
        "Process ended without an exit code, which is what a stopped session looks like",
        "{stopped:?}"
    );
    assert_eq!(output, "(no new output)");
    assert_eq!(
        live.read(5000, true, &cancel).await.unwrap().unwrap()["status"],
        "running",
        "Abort only owns the agent tool shells; the independent compute shell remains owned until archive."
    );
    fixture
        .tools
        .archive_agent(&fixture.agent, &cancel)
        .await
        .unwrap();
    assert!(
        engine
            .call("GET", &format!("/containers/{name}/json"), &Value::Null)
            .await
            .unwrap_err()
            .downcast_ref::<engine::NotFound>()
            .is_some()
    );
    }).catch_unwind().await;
    fixture.close().await;
    if let Err(error) = outcome {
        std::panic::resume_unwind(error);
    }
}
