use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
    task::JoinHandle,
};

struct Fixture {
    _directory: tempfile::TempDir,
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    lifecycle: Arc<LifecycleModule>,
    durable: Arc<DurableFunctionsModule>,
    cloud: Arc<CloudModule>,
}
impl Fixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
        let (runtime, lifecycle, durable, cloud) = Self::open(config.clone()).await;
        Self {
            _directory: directory,
            config,
            runtime,
            lifecycle,
            durable,
            cloud,
        }
    }
    async fn open(
        config: Arc<ConfigModule>,
    ) -> (
        Arc<RuntimeModule>,
        Arc<LifecycleModule>,
        Arc<DurableFunctionsModule>,
        Arc<CloudModule>,
    ) {
        let runtime = Arc::new(RuntimeModule::new(config.clone()));
        runtime.load().await.unwrap();
        let lifecycle = Arc::new(LifecycleModule::new(config.clone()).unwrap());
        let durable =
            Arc::new(DurableFunctionsModule::new(runtime.clone(), lifecycle.clone()).unwrap());
        durable.load().await.unwrap();
        let events = Arc::new(EventsModule::new(runtime.clone()).unwrap());
        events.load().await.unwrap();
        let cloud = CloudModule::new(
            config,
            runtime.clone(),
            durable.clone(),
            lifecycle.clone(),
            events,
        )
        .unwrap();
        cloud.load().await.unwrap();
        (runtime, lifecycle, durable, cloud)
    }
    async fn seed(&self) -> Value {
        let module = self.cloud.clone();
        self.runtime.transact(move|ctx|module.replace(ctx,&json!({"error":null,"pending":false,"session":{"environment":"staging","refreshToken":"fixture-refresh-1","user":{"id":"user_fixture","email":"fixture@example.com","firstName":null,"lastName":null}}}),true,None)).await.unwrap()
    }
    async fn close(&self) {
        self.lifecycle.begin_shutdown();
        self.durable.stop().await;
        self.cloud.close().await.unwrap();
        self.runtime.close().await.unwrap();
    }
    async fn restart(&mut self) {
        self.close().await;
        (self.runtime, self.lifecycle, self.durable, self.cloud) =
            Self::open(self.config.clone()).await;
    }
    async fn state(&self) -> Value {
        self.cloud.read().await.unwrap().unwrap()
    }
    async fn counts(&self) -> (u64, u64) {
        self.runtime
            .transact(|ctx| {
                Ok((
                    ctx.database().query_row(
                        "SELECT count(*) FROM durable_function_calls",
                        [],
                        |row| row.get(0),
                    )?,
                    ctx.database().query_row(
                        "SELECT count(*) FROM happy_agent_events WHERE type='cloud.updated'",
                        [],
                        |row| row.get(0),
                    )?,
                ))
            })
            .await
            .unwrap()
    }
}

struct Request {
    method: String,
    path: String,
    headers: String,
    body: Value,
    response: oneshot::Sender<(u16, Value)>,
}

#[tokio::test]
async fn public_mint_echoes_its_mutation_on_profile_changes_and_authoritative_rejection() {
    for rejected in [false, true] {
        let fixture = Fixture::new().await;
        let mut http = Http::new(&fixture.config).await;
        fixture.seed().await;
        let owner = fixture.cloud.clone();
        let mint = tokio::spawn(async move {
            owner
                .mint_with_mutation(Some(json!("public-mint-echo")))
                .await
        });
        if rejected {
            http.reply(
                "POST",
                "/user_management/authenticate",
                400,
                json!({"error":"invalid_grant"}),
            )
            .await;
        } else {
            let mut response = authentication("rotated-echo", "fixture-access");
            response["user"]["first_name"] = json!("Updated");
            http.reply("POST", "/user_management/authenticate", 200, response)
                .await;
            http.reply(
                "GET",
                "/v0/hello",
                200,
                json!({"message":"hello","userId":"user_fixture"}),
            )
            .await;
        }
        assert_eq!(mint.await.unwrap().is_err(), rejected);
        fixture.runtime.transact(|ctx|{let payload:String=ctx.database().query_row("SELECT payload_json FROM happy_agent_events WHERE type='cloud.updated' ORDER BY event_id DESC LIMIT 1",[],|row|row.get(0))?;let payload:Value=serde_json::from_str(&payload)?;assert_eq!(payload["mutationId"],"public-mint-echo");Ok(())}).await.unwrap();
        fixture.close().await;
    }
}
struct Http {
    url: String,
    requests: mpsc::Receiver<Request>,
    task: JoinHandle<()>,
}
impl Drop for Http {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Http {
    async fn new(config: &ConfigModule) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind real local Cloud HTTP fixture");
        let url = format!("http://{}", listener.local_addr().unwrap());
        config.set_cloud_test_deployment(&url, &url).unwrap();
        let (sender, requests) = mpsc::channel(128);
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {result=listener.accept()=>{let Ok((mut socket,_))=result else{break;};if connections.len()>=128{continue;}let sender=sender.clone();connections.spawn(async move{let work=async{let mut bytes=Vec::new();let header_end=loop{let mut buffer=[0;1024];let count=socket.read(&mut buffer).await?;ensure!(count>0&&bytes.len()+count<=65536,"HTTP fixture request exceeded its bound.");bytes.extend_from_slice(&buffer[..count]);if let Some(index)=bytes.windows(4).position(|window|window==b"\r\n\r\n"){break index+4;}};let headers=String::from_utf8(bytes[..header_end].to_vec())?;let length=headers.lines().find_map(|line|line.split_once(':').filter(|(key,_)|key.eq_ignore_ascii_case("content-length")).map(|(_,value)|value.trim().parse::<usize>())).transpose()?.unwrap_or(0);ensure!(length<=32768,"HTTP fixture body exceeded its bound.");while bytes.len()<header_end+length{let mut buffer=[0;1024];let count=socket.read(&mut buffer).await?;ensure!(count>0,"HTTP fixture request ended early.");bytes.extend_from_slice(&buffer[..count]);}let mut first=headers.lines().next().context("HTTP fixture request has no start line.")?.split_whitespace();let method=first.next().unwrap().to_owned();let path=first.next().unwrap().to_owned();let body=if length==0{Value::Null}else{serde_json::from_slice(&bytes[header_end..header_end+length])?};let(response,receiver)=oneshot::channel();sender.send(Request{method,path,headers,body,response}).await.map_err(|_|anyhow::anyhow!("HTTP fixture stopped."))?;let(status,body)=receiver.await?;let body=if status==204{String::new()}else{body.to_string()};socket.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await?;socket.shutdown().await?;Ok::<_,anyhow::Error>(())};let _=tokio::time::timeout(Duration::from_secs(10),work).await;});},_=connections.join_next(),if !connections.is_empty()=>{}}
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }
    async fn next(&mut self, method: &str, path: &str) -> Request {
        let request = tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(request.method, method);
        assert_eq!(request.path, path);
        if path == "/user_management/authenticate" {
            assert!(!request.headers.to_lowercase().contains("authorization:"));
            assert!(request.body.get("client_secret").is_none());
        }
        request
    }
    async fn reply(&mut self, method: &str, path: &str, status: u16, body: Value) -> Value {
        let request = self.next(method, path).await;
        let value = request.body;
        request.response.send((status, body)).unwrap();
        value
    }
    async fn quiet(&mut self) {
        assert!(
            tokio::time::timeout(Duration::from_millis(80), self.requests.recv())
                .await
                .is_err(),
            "An HTTP attempt was replayed."
        );
    }
}
fn authentication(refresh: &str, access: &str) -> Value {
    json!({"access_token":access,"refresh_token":refresh,"user":{"id":"user_fixture","email":"fixture@example.com","first_name":null,"last_name":null,"ignored":"metadata"}})
}
fn jwt(config: &ConfigModule, org: &str, lifetime: u64) -> String {
    let client = config.cloud_deployment("staging").unwrap()["workosClientId"]
        .as_str()
        .unwrap()
        .to_owned();
    let issued = now() / 1000;
    let claims = json!({"sub":"user_fixture","org_id":org,"client_id":client,"iss":format!("https://api.workos.com/user_management/{client}"),"sid":"session_fixture","iat":issued,"exp":issued+lifetime});
    format!(
        "e30.{}.signature",
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}
fn operation_error(error: &anyhow::Error) -> &CloudOperationError {
    error
        .downcast_ref::<CloudOperationError>()
        .expect("public Cloud error")
}

#[tokio::test]
async fn signout_joins_transaction_and_rollback_preserves_credentials_jobs_and_events() {
    let fixture = Fixture::new().await;
    let connected = fixture.seed().await;
    let counts = fixture.counts().await;
    let cloud = fixture.cloud.clone();
    assert!(
        fixture
            .runtime
            .transact(move |ctx| -> Result<()> {
                assert_eq!(cloud.disconnect(ctx, None)?["status"], "disconnected");
                assert_eq!(cloud.status()["status"], "connected");
                anyhow::bail!("rollback")
            })
            .await
            .is_err()
    );
    assert_eq!(fixture.cloud.status(), connected);
    assert_eq!(
        fixture.state().await["session"]["refreshToken"],
        "fixture-refresh-1"
    );
    assert_eq!(fixture.counts().await, counts);
    let cloud = fixture.cloud.clone();
    let disconnected = fixture
        .runtime
        .transact(move |ctx| cloud.disconnect(ctx, None))
        .await
        .unwrap();
    assert_eq!(disconnected["status"], "disconnected");
    assert_eq!(fixture.counts().await, (0, counts.1 + 1));
    let cloud = fixture.cloud.clone();
    assert_eq!(
        fixture
            .runtime
            .transact(move |ctx| cloud.disconnect(ctx, None))
            .await
            .unwrap(),
        disconnected
    );
    assert_eq!(fixture.counts().await, (0, counts.1 + 1));
    fixture.close().await;
}

#[tokio::test]
async fn restored_pending_authorization_expires_without_restoring_a_verifier() {
    let mut fixture = Fixture::new().await;
    let original = fixture
        .cloud
        .start(&json!({"environment":"staging","redirectUri":"happy-agent://callback/cloud"}))
        .await
        .unwrap();
    assert_eq!(fixture.counts().await.0, 1);
    fixture.restart().await;
    assert_eq!(fixture.cloud.status()["version"], original["version"]);
    assert_eq!(
        fixture.cloud.status()["error"]["code"],
        "authorization_expired"
    );
    fixture.durable.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.state().await["pending"] == true || fixture.counts().await.0 > 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(
        fixture.cloud.status()["version"].as_str().unwrap() > original["version"].as_str().unwrap()
    );
    assert_eq!(fixture.counts().await.0, 0);
    fixture.close().await;
}

#[tokio::test]
async fn pkce_callbacks_are_bound_and_valid_callbacks_are_consumed_before_http() {
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    let request = json!({"environment":"staging","redirectUri":"happy-agent://callback/cloud"});
    let original = fixture.cloud.start(&request).await.unwrap();
    assert_eq!(fixture.cloud.start(&request).await.unwrap(), original);
    let url = reqwest::Url::parse(original["authorization"]["url"].as_str().unwrap()).unwrap();
    assert!(url.as_str().starts_with(&http.url));
    let parameters: std::collections::BTreeMap<_, _> = url
        .query_pairs()
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect();
    let state = &parameters["state"];
    assert_eq!(parameters["code_challenge_method"], "S256");
    for callback in [
        format!("happy-agent://wrong/cloud?state={state}&code=fixture"),
        format!("happy-agent://callback/cloud?state={state}&state={state}&code=fixture"),
        format!("happy-agent://callback/cloud?state={state}&code=fixture&error="),
    ] {
        assert_eq!(
            operation_error(
                &fixture
                    .cloud
                    .complete(&json!({"callbackUrl":callback}))
                    .await
                    .unwrap_err()
            )
            .code,
            "invalid_request"
        );
        assert_eq!(fixture.cloud.status(), original);
    }
    let module = fixture.cloud.clone();
    let callback = format!("happy-agent://callback/cloud?state={state}&code=fixture-code");
    let request = json!({"callbackUrl":callback});
    let clone = request.clone();
    let complete = tokio::spawn(async move { module.complete(&clone).await });
    let exchange = http.next("POST", "/user_management/authenticate").await;
    assert!(
        exchange
            .headers
            .to_lowercase()
            .find("authorization:")
            .is_none()
    );
    assert!(exchange.body.get("client_secret").is_none());
    assert_eq!(exchange.body["grant_type"], "authorization_code");
    use sha2::Digest;
    assert_eq!(
        URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(
            exchange.body["code_verifier"].as_str().unwrap()
        )),
        parameters["code_challenge"]
    );
    exchange
        .response
        .send((503, json!({"error":"fixture_unavailable"})))
        .unwrap();
    assert_eq!(
        operation_error(&complete.await.unwrap().unwrap_err()).code,
        "cloud_unavailable"
    );
    assert_eq!(
        operation_error(&fixture.cloud.complete(&request).await.unwrap_err()).code,
        "invalid_request"
    );
    http.quiet().await;
    assert!(fixture.state().await["session"].is_null());
    fixture.close().await;
}

#[tokio::test]
async fn rotated_credentials_are_saved_before_failed_verification_without_public_churn() {
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    let original = fixture.seed().await;
    let counts = fixture.counts().await;
    let module = fixture.cloud.clone();
    let mint = tokio::spawn(async move { module.mint().await });
    let body = http
        .reply(
            "POST",
            "/user_management/authenticate",
            200,
            authentication("fixture-refresh-2", "fixture-access-2"),
        )
        .await;
    assert_eq!(body["refresh_token"], "fixture-refresh-1");
    let hello = http.next("GET", "/v0/hello").await;
    assert!(hello.headers.contains("Bearer fixture-access-2"));
    assert_eq!(
        fixture.state().await["session"]["refreshToken"],
        "fixture-refresh-2"
    );
    hello
        .response
        .send((401, json!({"error":"verifier_unavailable"})))
        .unwrap();
    assert_eq!(
        operation_error(&mint.await.unwrap().unwrap_err()).code,
        "cloud_unavailable"
    );
    assert_eq!(fixture.cloud.status(), original);
    assert_eq!(fixture.counts().await, counts);
    let module = fixture.cloud.clone();
    let mint = tokio::spawn(async move { module.mint().await });
    assert_eq!(
        http.reply(
            "POST",
            "/user_management/authenticate",
            400,
            json!({"error":"invalid_grant"})
        )
        .await["refresh_token"],
        "fixture-refresh-2"
    );
    assert_eq!(
        operation_error(&mint.await.unwrap().unwrap_err()).code,
        "cloud_unauthorized"
    );
    assert_eq!(
        fixture.cloud.status()["error"]["code"],
        "credentials_rejected"
    );
    assert_eq!(fixture.counts().await.0, 0);
    http.quiet().await;
    fixture.close().await;
}

#[tokio::test]
async fn aborted_callers_do_not_abandon_rotation_and_signout_fences_late_credentials() {
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    fixture.seed().await;
    let module = fixture.cloud.clone();
    let caller = tokio::spawn(async move { module.mint().await });
    let refresh = http.next("POST", "/user_management/authenticate").await;
    caller.abort();
    refresh
        .response
        .send((200, authentication("fixture-refresh-2", "fixture-access-2")))
        .unwrap();
    let hello = http.next("GET", "/v0/hello").await;
    assert_eq!(
        fixture.state().await["session"]["refreshToken"],
        "fixture-refresh-2"
    );
    hello
        .response
        .send((200, json!({"message":"hello","userId":"user_fixture"})))
        .unwrap();
    let module = fixture.cloud.clone();
    let caller = tokio::spawn(async move { module.mint().await });
    let refresh = http.next("POST", "/user_management/authenticate").await;
    let module = fixture.cloud.clone();
    fixture
        .runtime
        .transact(move |ctx| module.disconnect(ctx, None))
        .await
        .unwrap();
    refresh
        .response
        .send((200, authentication("fixture-refresh-3", "fixture-access-3")))
        .unwrap();
    assert_eq!(
        operation_error(&caller.await.unwrap().unwrap_err()).code,
        "cloud_not_authenticated"
    );
    assert_eq!(fixture.cloud.status()["status"], "disconnected");
    assert!(fixture.state().await["session"].is_null());
    http.quiet().await;
    fixture.close().await;
}

#[tokio::test]
async fn organization_mints_share_work_and_valid_tokens_bypass_other_refreshes() {
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    fixture.seed().await;
    let access = jwt(&fixture.config, "org_fixture", 3600);
    let module = fixture.cloud.clone();
    let first = tokio::spawn(async move {
        module
            .mint_for_organization("org_fixture", CancellationToken::new())
            .await
    });
    let refresh = http.next("POST", "/user_management/authenticate").await;
    assert_eq!(refresh.body["organization_id"], "org_fixture");
    let module = fixture.cloud.clone();
    let second = tokio::spawn(async move {
        module
            .mint_for_organization("org_fixture", CancellationToken::new())
            .await
    });
    refresh
        .response
        .send((200, authentication("fixture-refresh-2", &access)))
        .unwrap();
    http.reply(
        "GET",
        "/v0/hello",
        200,
        json!({"message":"hello","userId":"user_fixture"}),
    )
    .await;
    assert_eq!(first.await.unwrap().unwrap(), access);
    assert_eq!(second.await.unwrap().unwrap(), access);
    let module = fixture.cloud.clone();
    let other = tokio::spawn(async move {
        module
            .mint_for_organization("org_other", CancellationToken::new())
            .await
    });
    let blocked = http.next("POST", "/user_management/authenticate").await;
    assert_eq!(
        tokio::time::timeout(
            Duration::from_millis(100),
            fixture
                .cloud
                .mint_for_organization("org_fixture", CancellationToken::new())
        )
        .await
        .unwrap()
        .unwrap(),
        access
    );
    let other_access = jwt(&fixture.config, "org_other", 300);
    blocked
        .response
        .send((200, authentication("fixture-refresh-3", &other_access)))
        .unwrap();
    http.reply(
        "GET",
        "/v0/hello",
        200,
        json!({"message":"hello","userId":"user_fixture"}),
    )
    .await;
    assert_eq!(other.await.unwrap().unwrap(), other_access);
    http.quiet().await;
    fixture.close().await;
}

#[tokio::test]
async fn short_lived_mint_withholds_long_tokens_after_rotation_and_cache_stays_ephemeral() {
    let mut fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    fixture.seed().await;
    let token = jwt(&fixture.config, "org_fixture", 3600);
    let module = fixture.cloud.clone();
    let mint = tokio::spawn(async move {
        module
            .mint_short_lived_for_organization("org_fixture")
            .await
    });
    http.reply(
        "POST",
        "/user_management/authenticate",
        200,
        authentication("fixture-refresh-2", &token),
    )
    .await;
    http.reply(
        "GET",
        "/v0/hello",
        200,
        json!({"message":"hello","userId":"user_fixture"}),
    )
    .await;
    assert!(
        mint.await
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("longer than five minutes")
    );
    assert_eq!(
        fixture.state().await["session"]["refreshToken"],
        "fixture-refresh-2"
    );
    assert!(fixture.cloud.cache.lock().unwrap().is_empty());
    fixture.restart().await;
    assert!(fixture.cloud.cache.lock().unwrap().is_empty());
    assert_eq!(
        fixture.state().await["session"]["refreshToken"],
        "fixture-refresh-2"
    );
    http.quiet().await;
    fixture.close().await;
}

#[tokio::test]
async fn hourly_refresh_checkpoints_next_deadline_before_http_and_restart_does_not_replay() {
    let mut fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    fixture.seed().await;
    let module = fixture.cloud.clone();
    fixture.runtime.transact(move|ctx|{module.durable.cancel(ctx,REFRESH_OPERATION)?;module.durable.invoke(ctx,&json!({"function":"cloud.refresh-session","operationId":REFRESH_OPERATION,"arguments":{"refreshAt":0}}))?;Ok(())}).await.unwrap();
    fixture.durable.start().await.unwrap();
    let refresh = http.next("POST", "/user_management/authenticate").await;
    let schedule: Value = fixture
        .runtime
        .transact(|ctx| {
            let schedule: String = ctx.database().query_row(
                "SELECT value_json FROM durable_function_kv WHERE key LIKE 'call.%.schedule'",
                [],
                |row| row.get(0),
            )?;
            Ok(serde_json::from_str(&schedule)?)
        })
        .await
        .unwrap();
    assert!(schedule["refreshAt"].as_u64().unwrap() > now() + HOUR - 10_000);
    assert!(refresh.body.get("organization_id").is_none());
    refresh
        .response
        .send((200, authentication("fixture-refresh-2", "fixture-access-2")))
        .unwrap();
    http.reply("GET", "/v0/hello", 503, json!({"error":"fixture"}))
        .await;
    fixture.restart().await;
    fixture.durable.start().await.unwrap();
    http.quiet().await;
    assert_eq!(
        fixture.state().await["session"]["refreshToken"],
        "fixture-refresh-2"
    );
    assert_eq!(fixture.counts().await.0, 1);
    fixture.close().await;
}

#[tokio::test]
async fn partial_team_creation_reports_created_id_without_compensating_or_replaying() {
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    fixture.seed().await;
    let module = fixture.cloud.clone();
    let create = tokio::spawn(async move {
        module
            .create_team("Fixture team", "https://fixture.example")
            .await
    });
    http.reply(
        "POST",
        "/user_management/authenticate",
        200,
        authentication("fixture-refresh-2", "fixture-access-2"),
    )
    .await;
    http.reply(
        "GET",
        "/v0/hello",
        200,
        json!({"message":"hello","userId":"user_fixture"}),
    )
    .await;
    assert_eq!(
        http.reply(
            "POST",
            "/v0/organizations",
            201,
            json!({"id":"org_fixture","name":"Fixture team","endpoint":null})
        )
        .await,
        json!({"name":"Fixture team"})
    );
    assert_eq!(
        http.reply(
            "PUT",
            "/v0/organizations/org_fixture/endpoint",
            503,
            json!({"error":"fixture"})
        )
        .await,
        json!({"endpoint":"https://fixture.example/"})
    );
    let error = create.await.unwrap().unwrap_err();
    assert_eq!(operation_error(&error).code, "cloud_unavailable");
    assert!(error.to_string().contains("org_fixture was created"));
    http.quiet().await;
    fixture.close().await;
}

#[test]
fn callback_and_verified_claims_reject_duplicates_identity_and_invalid_lifetimes() {
    let schemas = Schemas::new().unwrap();
    assert!(validation::redirect("http://example.com/callback").is_none());
    assert!(validation::redirect("javascript:fixture").is_none());
    assert!(validation::redirect("http://127.2.3.4/callback").is_some());
    assert!(
        validation::callback(
            "https://fixture.example/cb?state=fixture&code=code&error=",
            "https://fixture.example/cb",
            "fixture"
        )
        .is_none()
    );
    assert!(
        validation::callback(
            "https://fixture.example/cb?state=fixture&code=code",
            "https://fixture.example/cb",
            "fixture"
        )
        .is_some()
    );
    let issued = now() / 1000;
    let claims = json!({"sub":"user_fixture","org_id":"org_fixture","client_id":"client_fixture","iss":"https://api.workos.com/user_management/client_fixture","sid":"session_fixture","iat":issued,"exp":issued+300});
    let token = format!(
        "e30.{}.signature",
        URL_SAFE_NO_PAD.encode(claims.to_string())
    );
    assert!(
        validation::token(
            &schemas,
            &token,
            "org_fixture",
            "user_fixture",
            "client_fixture",
            true
        )
        .is_ok()
    );
    assert!(
        validation::token(
            &schemas,
            &token,
            "org_other",
            "user_fixture",
            "client_fixture",
            true
        )
        .is_err()
    );
}

#[tokio::test]
async fn original_migrations_retire_account_tables_preserve_tokens_profile_and_other_owner_values()
{
    let directory = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
    let runtime = Arc::new(RuntimeModule::new(config.clone()));
    runtime.load().await.unwrap();
    runtime
        .migrate("cloud", &persistence::MIGRATIONS[..7])
        .await
        .unwrap();
    let version = Versions::new().next();
    let original_version = version.clone();
    runtime.transact(move |ctx| {
        let state = json!({"error":null,"pending":false,"updatedAt":now(),"version":version,"session":{"environment":"staging","refreshToken":"fixture-original-refresh","user":{"id":"user_fixture","email":"fixture@example.com","firstName":null,"lastName":null},"enrollment":{"status":"enrolled"},"keys":{"status":"restore_required"},"keysReconciliationCallId":"fixture-retired-call"}});
        ctx.database().execute("INSERT INTO happy_agent_cloud_state(singleton_id,state_json) VALUES(1,?1)", [state.to_string()])?;
        ctx.database().execute_batch("CREATE TABLE happy_agent_profile(singleton_id INTEGER PRIMARY KEY,profile_json TEXT NOT NULL);INSERT INTO happy_agent_profile VALUES(1,'{\"name\":\"Local fixture\"}');INSERT INTO happy_agent_values(owner_id,key,value_json) VALUES('','unrelated.owner.secret','\"fixture-kept\"');")?;
        Ok(())
    }).await.unwrap();
    let lifecycle = Arc::new(LifecycleModule::new(config.clone()).unwrap());
    let durable =
        Arc::new(DurableFunctionsModule::new(runtime.clone(), lifecycle.clone()).unwrap());
    durable.load().await.unwrap();
    let events = Arc::new(EventsModule::new(runtime.clone()).unwrap());
    events.load().await.unwrap();
    let cloud = CloudModule::new(
        config,
        runtime.clone(),
        durable.clone(),
        lifecycle.clone(),
        events,
    )
    .unwrap();
    cloud.load().await.unwrap();
    let state = cloud.read().await.unwrap().unwrap();
    assert_eq!(state["version"], original_version);
    assert_eq!(state["session"]["refreshToken"], "fixture-original-refresh");
    assert!(state["session"].get("keys").is_none());
    assert!(state["session"].get("enrollment").is_none());
    runtime.transact(|ctx| {
        assert_eq!(ctx.database().query_row("SELECT profile_json FROM happy_agent_profile", [], |row| row.get::<_, String>(0))?, "{\"name\":\"Local fixture\"}");
        assert_eq!(ctx.database().query_row("SELECT value_json FROM happy_agent_values WHERE key='unrelated.owner.secret'", [], |row| row.get::<_, String>(0))?, "\"fixture-kept\"");
        assert_eq!(ctx.database().query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('happy_agent_cloud_social_state','happy_agent_cloud_keys','happy_agent_cloud_murmur_store','happy_agent_cloud_disconnect')", [], |row| row.get::<_, u64>(0))?, 0);
        Ok(())
    }).await.unwrap();
    lifecycle.begin_shutdown();
    durable.stop().await;
    cloud.close().await.unwrap();
    runtime.close().await.unwrap();
}

#[tokio::test]
async fn pending_cache_capacity_is_bounded_and_cancelled_queued_requests_never_consume_credentials()
{
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    fixture.seed().await;
    let lock = fixture.cloud.credentials.lock().await;
    let mut calls = JoinSet::new();
    let mut cancellations = Vec::new();
    for index in 0..100 {
        let module = fixture.cloud.clone();
        let cancel = CancellationToken::new();
        cancellations.push(cancel.clone());
        calls.spawn(async move {
            module
                .mint_for_organization(&format!("org_fixture{index}"), cancel)
                .await
        });
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while fixture.cloud.cache.lock().unwrap().len() < 100 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    let error = fixture
        .cloud
        .mint_for_organization("org_overflow", CancellationToken::new())
        .await
        .unwrap_err();
    assert_eq!(operation_error(&error).code, "cloud_unavailable");
    for cancel in cancellations {
        cancel.cancel();
    }
    while let Some(call) = calls.join_next().await {
        assert!(call.unwrap().is_err());
    }
    drop(lock);
    http.quiet().await;
    fixture.close().await;
}

#[tokio::test]
async fn cancelling_one_shared_waiter_keeps_other_waiters_and_rotation_alive() {
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    fixture.seed().await;
    let cancel = CancellationToken::new();
    let signal = cancel.clone();
    let module = fixture.cloud.clone();
    let first =
        tokio::spawn(async move { module.mint_for_organization("org_fixture", signal).await });
    let request = http.next("POST", "/user_management/authenticate").await;
    let module = fixture.cloud.clone();
    let second = tokio::spawn(async move {
        module
            .mint_for_organization("org_fixture", CancellationToken::new())
            .await
    });
    cancel.cancel();
    assert!(first.await.unwrap().is_err());
    let access = jwt(&fixture.config, "org_fixture", 300);
    request
        .response
        .send((200, authentication("fixture-refresh-2", &access)))
        .unwrap();
    http.reply(
        "GET",
        "/v0/hello",
        200,
        json!({"message":"hello","userId":"user_fixture"}),
    )
    .await;
    assert_eq!(second.await.unwrap().unwrap(), access);
    assert_eq!(
        fixture.state().await["session"]["refreshToken"],
        "fixture-refresh-2"
    );
    http.quiet().await;
    fixture.close().await;
}

#[tokio::test]
async fn failed_background_renewal_keeps_valid_token_backs_off_and_never_serves_expired_token() {
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    fixture.seed().await;
    let access = jwt(&fixture.config, "org_fixture", 300);
    let module = fixture.cloud.clone();
    let first = tokio::spawn(async move {
        module
            .mint_for_organization("org_fixture", CancellationToken::new())
            .await
    });
    http.reply(
        "POST",
        "/user_management/authenticate",
        200,
        authentication("fixture-refresh-2", &access),
    )
    .await;
    http.reply(
        "GET",
        "/v0/hello",
        200,
        json!({"message":"hello","userId":"user_fixture"}),
    )
    .await;
    assert_eq!(first.await.unwrap().unwrap(), access);
    let entry = fixture.cloud.cache.lock().unwrap()[0].1.clone();
    entry.refresh_after.store(0, Ordering::Release);
    assert_eq!(
        fixture
            .cloud
            .mint_for_organization("org_fixture", CancellationToken::new())
            .await
            .unwrap(),
        access
    );
    http.reply(
        "POST",
        "/user_management/authenticate",
        503,
        json!({"error":"fixture_unavailable"}),
    )
    .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        while entry.pending.lock().unwrap().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        fixture
            .cloud
            .mint_for_organization("org_fixture", CancellationToken::new())
            .await
            .unwrap(),
        access
    );
    http.quiet().await;
    entry.token.lock().unwrap().as_mut().unwrap().expires_at = now() - 1;
    let module = fixture.cloud.clone();
    let expired = tokio::spawn(async move {
        module
            .mint_for_organization("org_fixture", CancellationToken::new())
            .await
    });
    http.reply(
        "POST",
        "/user_management/authenticate",
        400,
        json!({"error":"invalid_grant"}),
    )
    .await;
    assert_eq!(
        operation_error(&expired.await.unwrap().unwrap_err()).code,
        "cloud_unauthorized"
    );
    assert!(fixture.cloud.cache.lock().unwrap().is_empty());
    fixture.close().await;
}

#[tokio::test]
async fn invitation_normalizes_recipient_and_preserves_membership_conflict_without_replay() {
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    fixture.seed().await;
    assert_eq!(
        operation_error(
            &fixture
                .cloud
                .invite_team_member("other", "fixture@example.com")
                .await
                .unwrap_err()
        )
        .code,
        "invalid_request"
    );
    let module = fixture.cloud.clone();
    let invite = tokio::spawn(async move {
        module
            .invite_team_member("org_fixture", "  Fixture@Example.COM  ")
            .await
    });
    http.reply(
        "POST",
        "/user_management/authenticate",
        200,
        authentication("fixture-refresh-2", "fixture-access-2"),
    )
    .await;
    http.reply(
        "GET",
        "/v0/hello",
        200,
        json!({"message":"hello","userId":"user_fixture"}),
    )
    .await;
    assert_eq!(
        http.reply(
            "POST",
            "/v0/organizations/org_fixture/invitations",
            409,
            json!({"error":"already_member"})
        )
        .await,
        json!({"email":"fixture@example.com"})
    );
    let error = invite.await.unwrap().unwrap_err();
    assert_eq!(operation_error(&error).status, 409);
    assert_eq!(operation_error(&error).code, "conflict");
    assert!(error.to_string().contains("already belongs"));
    assert_eq!(fixture.cloud.status()["status"], "connected");
    assert!(
        !operation_error(&error)
            .cloud
            .to_string()
            .contains("fixture-refresh")
    );
    http.quiet().await;
    fixture.close().await;
}

#[tokio::test]
async fn remote_team_endpoints_must_already_be_normalized() {
    let fixture = Fixture::new().await;
    let mut http = Http::new(&fixture.config).await;
    let boundary = Boundary::new(&fixture.config, "staging").unwrap();
    let roster = tokio::spawn(async move { boundary.organizations("fixture-access", true).await });
    http.reply("GET", "/v0/organizations", 200, json!({"organizations":[{"id":"org_fixture","name":"Fixture team","endpoint":"https://fixture.example"}]})).await;
    assert!(roster.await.unwrap().is_err());
    let boundary = Boundary::new(&fixture.config, "staging").unwrap();
    let create = tokio::spawn(async move {
        boundary
            .create_organization("fixture-access", "Fixture team", true)
            .await
    });
    http.reply(
        "POST",
        "/v0/organizations",
        201,
        json!({"id":"org_fixture","name":"Fixture team","endpoint":"https://fixture.example"}),
    )
    .await;
    assert!(create.await.unwrap().is_err());
    fixture.close().await;
}
