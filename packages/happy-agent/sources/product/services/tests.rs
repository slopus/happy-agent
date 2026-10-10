use super::*;
use std::{fs, path::Path};

const WORKSPACE: &str = "serviceworkspacefixture";
const OWNER: &str = "serviceownerfixture";
struct Fixture {
    directory: tempfile::TempDir,
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    lifecycle: Arc<LifecycleModule>,
    durable: Arc<DurableFunctionsModule>,
    services: Arc<ServicesModule>,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
        let (runtime, lifecycle, durable, services) = Self::open(config.clone()).await;
        Self {
            directory,
            config,
            runtime,
            lifecycle,
            durable,
            services,
        }
    }
    async fn open(
        config: Arc<ConfigModule>,
    ) -> (
        Arc<RuntimeModule>,
        Arc<LifecycleModule>,
        Arc<DurableFunctionsModule>,
        Arc<ServicesModule>,
    ) {
        let runtime = Arc::new(RuntimeModule::new(config.clone()));
        runtime.load().await.unwrap();
        let lifecycle = Arc::new(LifecycleModule::new(config.clone()).unwrap());
        let durable =
            Arc::new(DurableFunctionsModule::new(runtime.clone(), lifecycle.clone()).unwrap());
        durable.load().await.unwrap();
        let events = Arc::new(EventsModule::new(runtime.clone()).unwrap());
        events.load().await.unwrap();
        let services = ServicesModule::new(
            config,
            runtime.clone(),
            durable.clone(),
            lifecycle.clone(),
            events,
        )
        .unwrap();
        services.load().await.unwrap();
        (runtime, lifecycle, durable, services)
    }
    async fn close(&self) {
        self.lifecycle.begin_shutdown();
        self.durable.stop().await;
        self.services.close().await.unwrap();
        self.runtime.close().await.unwrap();
    }
    async fn restart(&mut self) {
        self.close().await;
        (self.runtime, self.lifecycle, self.durable, self.services) =
            Self::open(self.config.clone()).await;
    }
    fn options(&self, id: &str, command: &str) -> Value {
        json!({"execution":{"id":id,"directory":self.config.paths.directory.join("services").join(id)},"command":command,"cwd":".","port":18437,"tty":false,"sandbox":{"inputs":["app.py"],"scratch":["scratch"],"outbound":[],"limits":{"memoryMiB":128,"processes":32}},"permissions":{"mode":"auto","network":{"egress":false,"localBinding":false}}})
    }
    async fn original(&self, id: &str) -> Value {
        self.original_for_owner(id, OWNER).await
    }
    async fn original_for_owner(&self, id: &str, owner: &str) -> Value {
        let options = self.options(id, "touch scratch/replayed");
        let service = json!({"id":id,"workspaceId":WORKSPACE,"agentId":owner,"processId":null,"name":"Original service","command":options["command"],"cwd":".","port":18437,"tty":false,"protocol":"http","access":"workspace","sandbox":options["sandbox"],"status":"starting","endpointStatus":"waiting","exitCode":null,"error":null,"version":Versions::new().next(),"createdAt":100,"updatedAt":100,"startedAt":null,"endedAt":null});
        let schemas = Schemas::new().unwrap();
        self.runtime
            .transact(move |ctx| {
                persistence::create(
                    ctx,
                    &schemas,
                    json!({"service":service,"execution":options["execution"]}),
                )
            })
            .await
            .unwrap()
    }
    async fn record(&self, id: &str) -> Value {
        let module = self.services.clone();
        let id = id.to_owned();
        self.runtime
            .transact(move |ctx| persistence::required(ctx, &module.schemas, WORKSPACE, &id))
            .await
            .unwrap()
    }
    async fn call(&self, id: &str, old_daemon: bool, claimed: bool) -> String {
        let module = self.services.clone();
        let options = self.options(id, "touch scratch/replayed");
        let daemon = if old_daemon {
            "previousservicedaemon".to_owned()
        } else {
            self.lifecycle.daemon_id().to_owned()
        };
        let id = id.to_owned();
        self.runtime.transact(move|ctx|{let call=module.durable.invoke(ctx,&json!({"function":"services.execution","arguments":{"workspaceId":WORKSPACE,"serviceId":id,"daemonId":daemon,"options":options}}))?;let id=call["callId"].as_str().unwrap().to_owned();if claimed{ctx.database().execute("INSERT INTO durable_function_kv(key,value_json) VALUES(?1,'true')",[format!("call.{id}.spawn-attempted!")])?;}Ok(id)}).await.unwrap()
    }
    async fn settled(&self, id: &str) {
        let id = id.to_owned();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let id = id.clone();
                if self
                    .runtime
                    .transact(move |ctx| {
                        Ok(ctx.database().query_row(
                            "SELECT count(*) FROM durable_function_calls WHERE id=?1",
                            [id],
                            |row| row.get::<_, usize>(0),
                        )?)
                    })
                    .await
                    .unwrap()
                    == 0
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test]
async fn original_catalog_and_closed_admission_survive_restart_without_rebinding() {
    let mut fixture = Fixture::new().await;
    let id = "originalservicefixture";
    let original = fixture.original(id).await;
    let module = fixture.services.clone();
    fixture
        .runtime
        .transact(move |ctx| {
            let cleanup = module
                .close_workspace_admission(ctx, &json!({"id":WORKSPACE}))?
                .unwrap();
            assert_eq!(cleanup["serviceIds"], json!([id]));
            Ok(())
        })
        .await
        .unwrap();
    fixture.restart().await;
    fixture
        .services
        .confirm_workspace_removal(WORKSPACE, &CancellationToken::new())
        .await
        .unwrap();
    let ended = fixture.record(id).await;
    assert_eq!(ended["service"]["status"], "failed");
    assert_eq!(ended["service"]["error"]["code"], "runtime_lost");
    assert_eq!(ended["execution"], original["execution"]);
    assert_eq!(ended["sequence"], original["sequence"]);
    for field in [
        "id",
        "agentId",
        "workspaceId",
        "command",
        "cwd",
        "port",
        "sandbox",
        "createdAt",
    ] {
        assert_eq!(ended["service"][field], original["service"][field]);
    }
    let schemas = Schemas::new().unwrap();
    let mut replacement = original.clone();
    replacement.as_object_mut().unwrap().remove("sequence");
    replacement["service"]["id"] = json!("replacementservicefixture");
    replacement["execution"]["id"] = json!("replacementservicefixture");
    assert!(
        fixture
            .runtime
            .transact(move |ctx| persistence::create(ctx, &schemas, replacement))
            .await
            .unwrap_err()
            .to_string()
            .contains("closed")
    );
    fixture.close().await;
}

#[tokio::test]
async fn exact_owner_stop_waits_for_teardown_and_preserves_other_owners() {
    let fixture = Fixture::new().await;
    fixture.original("ownedservicefixture").await;
    fixture
        .original_for_owner("otherservicefixture", "otherownerfixture")
        .await;
    fixture
        .services
        .stop_owner_and_wait(OWNER, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        fixture.record("ownedservicefixture").await["service"]["status"],
        "failed"
    );
    assert_eq!(
        fixture.record("ownedservicefixture").await["service"]["error"]["code"],
        "runtime_lost"
    );
    assert!(
        !fixture
            .config
            .paths
            .directory
            .join("services/ownedservicefixture")
            .exists()
    );
    assert_eq!(
        fixture.record("otherservicefixture").await["service"]["status"],
        "starting"
    );
    fixture
        .services
        .stop_owner_and_wait(OWNER, &CancellationToken::new())
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn incomplete_native_ownership_retains_catalog_slot_and_workspace_files() {
    let fixture = Fixture::new().await;
    let id = "incompleteservicefixture";
    let original = fixture.original(id).await;
    let workspace = fixture.directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("keep.txt"), "must remain").unwrap();
    let controls = Path::new(original["execution"]["directory"].as_str().unwrap());
    private_dir(controls.parent().unwrap());
    private_dir(controls);
    assert!(
        fixture
            .services
            .confirm_workspace_removal(WORKSPACE, &CancellationToken::new())
            .await
            .is_err()
    );
    let current = fixture.record(id).await;
    assert_eq!(current["service"]["status"], "stopping");
    assert_eq!(current["service"]["error"]["code"], "cleanup_unconfirmed");
    assert!(workspace.join("keep.txt").exists());
    assert!(controls.exists());
    let module = fixture.services.clone();
    fixture
        .runtime
        .transact(move |ctx| {
            let (services, _) = module.list(ctx, WORKSPACE, false, 32, None)?;
            assert_eq!(services.len(), 1);
            assert_eq!(services[0]["id"], id);
            Ok(())
        })
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn admission_and_lifecycle_publication_roll_back_with_the_callers_transaction() {
    let fixture = Fixture::new().await;
    let id = "rollbackservicefixture";
    let original = fixture.original(id).await;
    let cursor = fixture.services.events.cursor();
    let module = fixture.services.clone();
    let result: Result<()> = fixture
        .runtime
        .transact(move |ctx| {
            module.close_workspace_admission(ctx, &json!({"id":WORKSPACE}))?;
            bail!("fixture rollback")
        })
        .await;
    assert!(result.is_err());
    assert_eq!(fixture.record(id).await, original);
    assert_eq!(fixture.services.events.cursor(), cursor);
    let schemas = Schemas::new().unwrap();
    fixture
        .runtime
        .transact(move |ctx| {
            let value: String = ctx.database().query_row(
                "SELECT value_json FROM happy_agent_values WHERE owner_id='' AND key=?1",
                [format!(
                    "agentSystem.modules.services.workspace.{WORKSPACE}.header!"
                )],
                |row| row.get(0),
            )?;
            let header: Value = serde_json::from_str(&value)?;
            assert!(schemas.valid("serviceHeader", &header)?);
            assert_eq!(header["closed"], false);
            Ok(())
        })
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn thirty_two_active_slots_are_released_only_after_confirmed_teardown() {
    let fixture = Fixture::new().await;
    let mut first = Value::Null;
    for number in 0..32 {
        let record = fixture
            .original(&format!("capacityservicefixture{number}"))
            .await;
        if number == 0 {
            first = record;
        }
    }
    let mut next = first.clone();
    next.as_object_mut().unwrap().remove("sequence");
    next["service"]["id"] = json!("capacityoverflowfixture");
    next["execution"]["id"] = json!("capacityoverflowfixture");
    let schemas = Schemas::new().unwrap();
    let overflow = next.clone();
    assert!(
        fixture
            .runtime
            .transact(move |ctx| persistence::create(ctx, &schemas, overflow))
            .await
            .unwrap_err()
            .to_string()
            .contains("32 active")
    );
    let mut ended = first["service"].clone();
    ended["status"] = json!("killed");
    ended["endpointStatus"] = json!("unavailable");
    ended["endedAt"] = json!(1000);
    ended["updatedAt"] = json!(1000);
    ended["version"] = json!(Versions::new().next());
    let previous = first["service"]["version"].as_str().unwrap().to_owned();
    let schemas = Schemas::new().unwrap();
    assert!(
        fixture
            .runtime
            .transact(move |ctx| persistence::replace(ctx, &schemas, &ended, &previous, false))
            .await
            .unwrap_err()
            .to_string()
            .contains("confirmed sandbox cleanup")
    );
    fixture
        .services
        .stop_and_wait(
            WORKSPACE,
            "capacityservicefixture0",
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let schemas = Schemas::new().unwrap();
    fixture
        .runtime
        .transact(move |ctx| persistence::create(ctx, &schemas, next))
        .await
        .unwrap();
    let module = fixture.services.clone();
    fixture
        .runtime
        .transact(move |ctx| {
            let (active, _) = module.list(ctx, WORKSPACE, false, 32, None)?;
            assert_eq!(active.len(), 32);
            Ok(())
        })
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn service_pages_keep_original_order_and_bind_cursor_scope() {
    let fixture = Fixture::new().await;
    for number in 0..3 {
        fixture
            .original(&format!("pagedservicefixture{number}"))
            .await;
    }
    let module = fixture.services.clone();
    let page = fixture
        .runtime
        .transact(move |ctx| module.list_page(ctx, WORKSPACE, &json!({"limit":2})))
        .await
        .unwrap();
    assert_eq!(page["services"].as_array().unwrap().len(), 2);
    assert_eq!(page["services"][0]["id"], "pagedservicefixture2");
    let cursor = page["nextPageCursor"].as_str().unwrap().to_owned();
    let module = fixture.services.clone();
    let after = cursor.clone();
    let page = fixture
        .runtime
        .transact(move |ctx| {
            module.list_page(ctx, WORKSPACE, &json!({"pageCursor":after,"limit":2}))
        })
        .await
        .unwrap();
    assert_eq!(page["services"][0]["id"], "pagedservicefixture0");
    assert!(page["nextPageCursor"].is_null());
    for (workspace, stopped) in [("differentworkspacefixture", false), (WORKSPACE, true)] {
        let module = fixture.services.clone();
        let cursor = cursor.clone();
        assert!(
            fixture
                .runtime
                .transact(move |ctx| module.list_page(
                    ctx,
                    workspace,
                    &json!({"pageCursor":cursor,"includeStopped":stopped})
                ))
                .await
                .is_err()
        );
    }
    fixture.close().await;
}

#[tokio::test]
async fn old_daemon_intent_and_committed_spawn_claim_reconcile_without_replaying() {
    for (old_daemon, claimed) in [(true, false), (false, true)] {
        let fixture = Fixture::new().await;
        let id = "claimedservicefixture";
        fixture.original(id).await;
        let call = fixture.call(id, old_daemon, claimed).await;
        fixture.durable.start().await.unwrap();
        fixture.settled(&call).await;
        assert_eq!(
            fixture.record(id).await["service"]["error"]["code"],
            "runtime_lost"
        );
        assert!(
            !fixture
                .config
                .paths
                .directory
                .join("services")
                .join(id)
                .exists()
        );
        fixture.close().await;
    }
}

#[tokio::test]
async fn unproven_cleanup_keeps_the_original_durable_call_and_spawn_claim() {
    let fixture = Fixture::new().await;
    let id = "pendingservicefixture";
    let original = fixture.original(id).await;
    let call = fixture.call(id, false, true).await;
    let controls = Path::new(original["execution"]["directory"].as_str().unwrap());
    private_dir(controls.parent().unwrap());
    private_dir(controls);
    fixture.durable.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if fixture.record(id).await["service"]["error"]["code"] == "cleanup_unconfirmed" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    fixture.lifecycle.begin_shutdown();
    fixture.durable.stop().await;
    fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                ctx.database().query_row(
                    "SELECT count(*) FROM durable_function_calls WHERE id=?1",
                    [&call],
                    |row| row.get::<_, usize>(0)
                )?,
                1
            );
            assert_eq!(
                ctx.database().query_row(
                    "SELECT value_json FROM durable_function_kv WHERE key=?1",
                    [format!("call.{call}.spawn-attempted!")],
                    |row| row.get::<_, String>(0)
                )?,
                "true"
            );
            Ok(())
        })
        .await
        .unwrap();
    fixture.services.close().await.unwrap();
    fixture.runtime.close().await.unwrap();
}

#[test]
fn access_credentials_are_bound_to_principal_execution_and_daemon_lifetime() {
    let schemas = Schemas::new().unwrap();
    let tokens = tokens::AccessTokens::new();
    let scope = json!({"principalId":"alice","workspaceId":WORKSPACE,"serviceId":"tokenservicefixture","executionId":"tokenexecutionfixture"});
    let issued = tokens.issue(&schemas, &scope).unwrap();
    let token = issued["accessToken"].as_str().unwrap();
    tokens.authorize(&schemas, &scope, Some(token)).unwrap();
    for (field, value) in [
        ("principalId", "bob"),
        ("workspaceId", "differentworkspacefixture"),
        ("serviceId", "differentservicefixture"),
        ("executionId", "differentexecutionfixture"),
    ] {
        let mut other = scope.clone();
        other[field] = json!(value);
        assert!(tokens.authorize(&schemas, &other, Some(token)).is_err());
    }
    assert!(
        tokens::AccessTokens::new()
            .authorize(&schemas, &scope, Some(token))
            .is_err()
    );
}

#[tokio::test]
async fn full_access_services_still_refuse_protected_and_symlinked_inputs() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new().await;
    let workspace = fixture.directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("AGENTS.md"), "controls").unwrap();
    fs::write(workspace.join("credential.txt"), "private fixture").unwrap();
    symlink(
        workspace.join("credential.txt"),
        workspace.join("alias.txt"),
    )
    .unwrap();
    let mut options = fixture.options("protectedservicefixture", "true");
    options["permissions"]["mode"] = json!("full_access");
    private_dir(
        Path::new(options["execution"]["directory"].as_str().unwrap())
            .parent()
            .unwrap(),
    );
    for (input, expected) in [
        ("AGENTS.md", "protected workspace"),
        ("alias.txt", "symlinks"),
        ("credential.txt", "protected private path"),
    ] {
        options["sandbox"]["inputs"] = json!([input]);
        let error = execution::Execution::start(
            &workspace,
            &fixture.config.paths.directory,
            &[workspace
                .join("credential.txt")
                .to_string_lossy()
                .into_owned()],
            &options,
            &fixture.services.schemas,
            CancellationToken::new(),
        )
        .await
        .err()
        .unwrap();
        assert!(error.to_string().contains(expected), "{error:#}");
        assert!(!Path::new(options["execution"]["directory"].as_str().unwrap()).exists());
    }
    fixture.close().await;
}

fn private_dir(path: &Path) {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .unwrap();
}

#[tokio::test]
#[ignore = "Requires the real Linux namespace and administrator-delegated cgroup CI lane."]
async fn native_service_uses_a_pty_and_revokes_an_established_gateway_before_cleanup() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fixture = Fixture::new().await;
    let workspace = fixture.directory.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    fs::write(workspace.join("app.py"),"import sys, threading\nfrom http.server import HTTPServer, BaseHTTPRequestHandler\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'service alive')\n def log_message(self,*args): pass\nserver=HTTPServer(('127.0.0.1',18437),Handler)\nthreading.Thread(target=server.serve_forever,daemon=True).start()\nprint('real tty',sys.stdin.isatty(),flush=True)\nfor line in sys.stdin:\n print('input:'+line.strip(),flush=True)\n").unwrap();
    let id = "nativeservicefixture";
    let mut options = fixture.options(id, "python3 app.py");
    options["tty"] = json!(true);
    let configuration = fixture
        .config
        .agent_configuration(
            workspace.to_str().unwrap(),
            "serviceprojectfixture",
            WORKSPACE,
            None,
        )
        .unwrap();
    let module = fixture.services.clone();
    let definition = json!({"name":"Native fixture","command":options["command"],"cwd":options["cwd"],"port":options["port"],"tty":options["tty"],"sandbox":options["sandbox"]});
    fixture.runtime.transact(move|ctx|{assert!(module.schemas.valid("agentConfig",&configuration)?);ctx.database().execute("INSERT INTO happy_agent_values(owner_id,key,value_json) VALUES('',?1,?2)",rusqlite::params![format!("agentSystem.config.{OWNER}"),configuration.to_string()])?;ctx.database().execute("INSERT INTO happy_agent_values(owner_id,key,value_json) VALUES(?1,'agentConfig',?2)",rusqlite::params![OWNER,configuration.to_string()])?;module.create(ctx,WORKSPACE,OWNER,&definition,&options)?;Ok(())}).await.unwrap();
    fixture.durable.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let service = fixture.record(id).await["service"].clone();
            assert!(
                !persistence::terminal(&service),
                "native service failed: {service}"
            );
            if service["status"] == "running" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let cancel = CancellationToken::new();
    let module = fixture.services.clone();
    let credential = fixture
        .runtime
        .transact(move |ctx| module.access_token(ctx, "alice", WORKSPACE, id))
        .await
        .unwrap();
    let token = credential["accessToken"].as_str().unwrap();
    let mut connection = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if let Ok(connection) = fixture
                .services
                .connect("alice", WORKSPACE, id, Some(token), &cancel)
                .await
            {
                break connection;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    connection
        .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut response = [0u8; 512];
    assert!(connection.read(&mut response).await.unwrap() > 0);
    let input = fixture
        .services
        .input(
            WORKSPACE,
            id,
            &json!({"kind":"agent","agentId":OWNER}),
            &json!({"chars":"hello\n","waitMs":1000,"maxOutputBytes":65536}),
            "auto",
            &cancel,
        )
        .await
        .unwrap();
    let mut output = input["output"].as_str().unwrap().to_owned();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if output.contains("input:hello") {
                assert!(output.contains("real tty True"));
                break;
            }
            let input = fixture
                .services
                .input(
                    WORKSPACE,
                    id,
                    &json!({"kind":"agent","agentId":OWNER}),
                    &json!({"waitMs":1000,"maxOutputBytes":65536}),
                    "auto",
                    &cancel,
                )
                .await
                .unwrap();
            output.push_str(input["output"].as_str().unwrap());
        }
    })
    .await
    .unwrap();
    let module = fixture.services.clone();
    let rolled_back: Result<()> = fixture
        .runtime
        .transact(move |ctx| {
            module.stop(ctx, WORKSPACE, id)?;
            bail!("fixture rollback")
        })
        .await;
    assert!(rolled_back.is_err());
    assert_eq!(fixture.record(id).await["service"]["status"], "running");
    let mut open = fixture
        .services
        .connect("alice", WORKSPACE, id, Some(token), &cancel)
        .await
        .unwrap();
    let module = fixture.services.clone();
    fixture
        .runtime
        .transact(move |ctx| {
            module
                .close_workspace_admission(ctx, &json!({"id":WORKSPACE}))
                .map(|_| ())
        })
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(1), open.read(&mut response))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    fixture
        .services
        .confirm_workspace_removal(WORKSPACE, &cancel)
        .await
        .unwrap();
    let ended = fixture.record(id).await;
    assert_eq!(ended["service"]["status"], "killed");
    assert!(!Path::new(ended["execution"]["directory"].as_str().unwrap()).exists());
    fixture.close().await;
}
