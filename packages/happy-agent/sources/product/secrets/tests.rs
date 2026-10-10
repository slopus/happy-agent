use super::*;
use crate::product::lifecycle::LifecycleModule;
use happy_agent_base::{AgentModule, AgentScope};
use tokio_util::sync::CancellationToken;
struct Fixture {
    _directory: tempfile::TempDir,
    config: Arc<ConfigModule>,
    runtime: Arc<RuntimeModule>,
    durable: Arc<DurableFunctionsModule>,
    lifecycle: Arc<LifecycleModule>,
    secrets: Arc<SecretsModule>,
}
impl Fixture {
    async fn open(
        config: Arc<ConfigModule>,
    ) -> (
        Arc<RuntimeModule>,
        Arc<DurableFunctionsModule>,
        Arc<LifecycleModule>,
        Arc<SecretsModule>,
    ) {
        let runtime = Arc::new(RuntimeModule::new(config.clone()));
        runtime.load().await.unwrap();
        let lifecycle = Arc::new(LifecycleModule::new(config.clone()).unwrap());
        let durable =
            Arc::new(DurableFunctionsModule::new(runtime.clone(), lifecycle.clone()).unwrap());
        durable.load().await.unwrap();
        let events = Arc::new(EventsModule::new(runtime.clone()).unwrap());
        events.load().await.unwrap();
        let secrets = SecretsModule::new(config, runtime.clone(), durable.clone(), events).unwrap();
        secrets.load().await.unwrap();
        (runtime, durable, lifecycle, secrets)
    }
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
        let (runtime, durable, lifecycle, secrets) = Self::open(config.clone()).await;
        Self {
            _directory: directory,
            config,
            runtime,
            durable,
            lifecycle,
            secrets,
        }
    }
    async fn close(&self) {
        self.lifecycle.begin_shutdown();
        self.durable.stop().await;
        self.runtime.close().await.unwrap();
    }
    async fn restart(&mut self) {
        self.close().await;
        (self.runtime, self.durable, self.lifecycle, self.secrets) =
            Self::open(self.config.clone()).await;
    }
    async fn count(&self) -> u64 {
        self.runtime
            .transact(|ctx| {
                Ok(ctx.database().query_row(
                    "SELECT count(*) FROM happy_agent_events WHERE type LIKE 'secret.%'",
                    [],
                    |row| row.get(0),
                )?)
            })
            .await
            .unwrap()
    }
    async fn create(&self, id: &str, environment: Value) -> Value {
        let owner = self.secrets.clone();
        let id = id.to_owned();
        self.runtime.transact(move|ctx|owner.create(ctx,&json!({"id":id,"description":"  fixture credentials  ","environment":environment}),None)).await.unwrap()
    }
}

#[tokio::test]
async fn catalog_conflicts_rotation_noops_and_restart_preserve_write_only_values() {
    let mut f = Fixture::new().await;
    let original = f
        .create("fixture-token", json!({"Token":"fixture-value-one"}))
        .await;
    assert_eq!(original["description"], "fixture credentials");
    assert!(!original.to_string().contains("fixture-value-one"));
    let owner = f.secrets.clone();
    let before = f.count().await;
    let previous = original.clone();
    let unchanged = f
        .runtime
        .transact(move |ctx| {
            owner.update(
                ctx,
                "fixture-token",
                &json!({"environment":{"TOKEN":"fixture-value-one"}}),
                previous["version"].as_str().unwrap(),
                None,
            )
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged, original);
    assert_eq!(f.count().await, before);
    let owner = f.secrets.clone();
    let previous = original.clone();
    let current = f
        .runtime
        .transact(move |ctx| {
            owner.update(
                ctx,
                "fixture-token",
                &json!({"environment":{"token":"fixture-value-two"}}),
                previous["version"].as_str().unwrap(),
                Some(&json!("fixture-mutation")),
            )
        })
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current["environmentVariables"], json!(["Token"]));
    assert!(current["version"].as_str().unwrap() > original["version"].as_str().unwrap());
    assert!(current["updatedAt"].as_u64().unwrap() > original["updatedAt"].as_u64().unwrap());
    let owner = f.secrets.clone();
    let previous = original.clone();
    let error = f
        .runtime
        .transact(move |ctx| {
            owner.update(
                ctx,
                "fixture-token",
                &json!({"description":"stale"}),
                previous["version"].as_str().unwrap(),
                None,
            )
        })
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<SecretConflictError>().unwrap().current,
        Some(current.clone())
    );
    let owner = f.secrets.clone();
    let error=f.runtime.transact(move|ctx|owner.create(ctx,&json!({"id":"fixture-token","description":"overwrite","environment":{"Token":"bad-overwrite"}}),None)).await.unwrap_err();
    assert!(error.downcast_ref::<SecretConflictError>().is_some());
    f.restart().await;
    let owner = f.secrets.clone();
    let after = f
        .runtime
        .transact(move |ctx| owner.get(ctx, "fixture-token"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after, current);
    f.runtime
        .transact(|ctx| {
            let mut query = ctx.database().prepare(
                "SELECT payload_json FROM happy_agent_events WHERE type LIKE 'secret.%'",
            )?;
            for payload in query.query_map([], |row| row.get::<_, String>(0))? {
                let payload = payload?;
                assert!(!payload.contains("fixture-value"));
                assert!(!payload.contains("environment_json"));
            }
            Ok(())
        })
        .await
        .unwrap();
    f.close().await;
}
#[tokio::test]
async fn direct_grants_are_immutable_idempotent_and_transaction_composable() {
    let f = Fixture::new().await;
    f.create("fixture-secret", json!({"TOKEN":"value"})).await;
    let target = json!({"type":"agent","id":cuid2::create_id()});
    let owner = f.secrets.clone();
    let requested = target.clone();
    let first = f
        .runtime
        .transact(move |ctx| owner.attach(ctx, "fixture-secret", &requested, None))
        .await
        .unwrap();
    assert!(first.1);
    let count = f.count().await;
    let owner = f.secrets.clone();
    let requested = target.clone();
    assert_eq!(
        f.runtime
            .transact(move |ctx| owner.attach(ctx, "fixture-secret", &requested, None))
            .await
            .unwrap(),
        (first.0.clone(), false)
    );
    assert_eq!(f.count().await, count);
    let owner = f.secrets.clone();
    let requested = target.clone();
    let error: Result<()> = f
        .runtime
        .transact(move |ctx| {
            owner.detach(ctx, "fixture-secret", &requested, None)?;
            anyhow::bail!("fixture rollback")
        })
        .await;
    assert!(error.is_err());
    assert_eq!(f.count().await, count);
    let owner = f.secrets.clone();
    let requested = target.clone();
    assert_eq!(
        f.runtime
            .transact(move |ctx| owner.detach(ctx, "fixture-secret", &requested, None))
            .await
            .unwrap(),
        Some(first.0)
    );
    let count = f.count().await;
    let owner = f.secrets.clone();
    assert_eq!(
        f.runtime
            .transact(move |ctx| owner.detach(ctx, "fixture-secret", &target, None))
            .await
            .unwrap(),
        None
    );
    assert_eq!(f.count().await, count);
    f.close().await;
}
#[tokio::test]
async fn command_selection_hides_all_attached_names_and_rejects_case_collisions() {
    let f = Fixture::new().await;
    f.create("project-token", json!({"PROJECT_TOKEN":"project"}))
        .await;
    f.create("workspace-token", json!({"Token":"workspace"}))
        .await;
    f.create("agent-token", json!({"TOKEN":"agent"})).await;
    f.create("hidden-token", json!({"HIDDEN":"hidden"})).await;
    let project = cuid2::create_id();
    let workspace = cuid2::create_id();
    let agent = cuid2::create_id();
    let targets = json!([{"type":"project","id":project},{"type":"workspace","id":workspace},{"type":"agent","id":agent}]);
    let owner = f.secrets.clone();
    let scope = targets.clone();
    f.runtime
        .transact(move |ctx| {
            for (id, target) in [
                ("project-token", &scope[0]),
                ("workspace-token", &scope[1]),
                ("agent-token", &scope[2]),
                ("hidden-token", &scope[2]),
            ] {
                owner.attach(ctx, id, target, None)?;
            }
            ctx.database().execute(
                "UPDATE happy_agent_secrets SET available_to_model=0 WHERE id='hidden-token'",
                [],
            )?;
            let none = owner.resolve_for_command_targets(ctx, &scope, &json!([]))?;
            assert_eq!(none["environment"], json!({}));
            assert_eq!(
                none["hiddenEnvironmentVariables"],
                json!(["HIDDEN", "PROJECT_TOKEN", "TOKEN"])
            );
            let selected =
                owner.resolve_for_command_targets(ctx, &scope, &json!(["project-token"]))?;
            assert_eq!(selected["environment"], json!({"PROJECT_TOKEN":"project"}));
            assert!(
                owner
                    .resolve_for_command_targets(
                        ctx,
                        &scope,
                        &json!(["workspace-token", "agent-token"])
                    )
                    .is_err()
            );
            assert!(
                owner
                    .resolve_for_command_targets(ctx, &scope, &json!(["hidden-token"]))
                    .is_err()
            );
            assert!(
                owner
                    .resolve_for_command_targets(ctx, &scope, &json!(["unattached"]))
                    .is_err()
            );
            Ok(())
        })
        .await
        .unwrap();
    let owner = f.secrets.clone();
    let child_targets = json!([{"type":"project","id":project},{"type":"workspace","id":cuid2::create_id()},{"type":"agent","id":cuid2::create_id()}]);
    f.runtime
        .transact(move |ctx| {
            let inherited = owner.resolve_for_command_targets(
                ctx,
                &child_targets,
                &json!(["project-token"]),
            )?;
            assert_eq!(inherited["environment"], json!({"PROJECT_TOKEN":"project"}));
            assert!(
                owner
                    .resolve_for_command_targets(ctx, &child_targets, &json!(["workspace-token"]))
                    .is_err()
            );
            assert!(
                owner
                    .resolve_for_command_targets(ctx, &child_targets, &json!(["agent-token"]))
                    .is_err()
            );
            Ok(())
        })
        .await
        .unwrap();
    f.close().await;
}
#[tokio::test]
async fn disabling_requires_all_grants_removed_and_managed_retirement_checks_owner() {
    let f = Fixture::new().await;
    let record = f.create("managed-token", json!({"TOKEN":"value"})).await;
    let owner = f.secrets.clone();
    let target = json!({"type":"agent","id":cuid2::create_id()});
    f.runtime.transact(move|ctx|{
        owner.attach(ctx,"managed-token",&target,None)?;
        ctx.database().execute("INSERT INTO happy_agent_secret_attachments VALUES('global','legacy-scope','managed-token')",[])?;
        assert!(owner.update(ctx,"managed-token",&json!({"availableToAgents":false}),record["version"].as_str().unwrap(),None).unwrap_err().downcast_ref::<SecretConflictError>().is_some());
        ctx.database().execute("UPDATE happy_agent_secrets SET kind='github',available_to_model=0 WHERE id='managed-token'",[])?;
        assert!(owner.retire_managed_catalog_secret(ctx,"project-git","managed-token").is_err());
        let scope=json!([target]);assert!(owner.resolve_for_command_targets(ctx,&scope,&json!(["managed-token"])).is_err());
        assert_eq!(owner.resolve_for_host(ctx,"global","legacy-scope",None)?,json!({"TOKEN":"value"}));
        assert!(owner.retire_managed_catalog_secret(ctx,"github","managed-token")?);
        assert!(!owner.retire_managed_catalog_secret(ctx,"github","managed-token")?);
        assert!(owner.get(ctx,"managed-token")?.is_none());
        let count:u64=ctx.database().query_row("SELECT (SELECT count(*) FROM happy_agent_secret_attachments)+(SELECT count(*) FROM happy_agent_secret_api_attachments)",[],|row|row.get(0))?;assert_eq!(count,0);Ok(())
    }).await.unwrap();
    f.close().await;
}
#[tokio::test]
async fn pagination_filters_exact_grants_and_unknown_cursors_without_reading_unrelated_values() {
    let f = Fixture::new().await;
    f.create("aa", json!({"A":"a"})).await;
    f.create("bb", json!({"B":"b"})).await;
    f.create("cc", json!({"C":"c"})).await;
    let owner = f.secrets.clone();
    let target = json!({"type":"project","id":cuid2::create_id()});
    f.runtime
        .transact(move |ctx| {
            owner.attach(ctx, "aa", &target, None)?;
            owner.attach(ctx, "cc", &target, None)?;
            ctx.database().execute(
                "UPDATE happy_agent_secrets SET created_at=1 WHERE owner_agent_id='global'",
                [],
            )?;
            let first = owner.list(ctx, &json!({"target":target,"limit":1}))?;
            assert_eq!(first["secrets"][0]["id"], "aa");
            assert_eq!(first["nextCursor"], "aa");
            let next = owner.list(ctx, &json!({"target":target,"limit":1,"cursor":"aa"}))?;
            assert_eq!(next["secrets"][0]["id"], "cc");
            assert!(next["nextCursor"].is_null());
            assert_eq!(
                owner.list(ctx, &json!({"target":target,"cursor":"bb"}))?["secrets"][0]["id"],
                "cc"
            );
            assert!(
                owner
                    .list(ctx, &json!({"cursor":"unknown"}))
                    .unwrap_err()
                    .downcast_ref::<SecretInputError>()
                    .is_some()
            );
            Ok(())
        })
        .await
        .unwrap();
    f.close().await;
}
#[tokio::test]
async fn real_tool_definitions_own_review_and_dotenv_elevation_without_value_disclosure() {
    let f = Fixture::new().await;
    let agent = cuid2::create_id();
    let config = json!({});
    let settings = json!({});
    let scope = AgentScope {
        id: &agent,
        configuration: &config,
        settings: &settings,
    };
    let names = f
        .secrets
        .tools(&scope)
        .into_iter()
        .map(|d| d.name)
        .collect::<Vec<_>>();
    assert_eq!(
        names,
        vec![
            "list_secrets",
            "reference_secret",
            "create_secret",
            "update_secret",
            "attach_secret",
            "detach_secret"
        ]
    );
    for name in names {
        let args = if name == "reference_secret" {
            json!({"id":"fixture"})
        } else if name == "list_secrets" {
            json!({})
        } else {
            json!({"secretId":"fixture","description":"sensitive-description","environment":{"TOKEN":"sensitive-value"}})
        };
        let call = json!({"id":"call","call":{"name":name,"arguments":args.to_string()}});
        let policy = f.secrets.permission_policy(&scope, &call).unwrap().unwrap();
        assert_eq!(
            policy.should_review_in_auto_mode,
            !matches!(name.as_str(), "list_secrets" | "reference_secret")
        );
        assert_eq!(
            policy.requires_auto_or_full_access,
            matches!(name.as_str(), "create_secret" | "update_secret")
        );
        assert!(!policy.should_run_in_full_access_in_auto_mode);
        assert!(!policy.action.contains("sensitive"));
    }
    let call = json!({"id":"call","call":{"name":"create_secret","arguments":json!({"description":"fixture","dotenvFile":"/host/fixture\u{202e}.env"}).to_string()}});
    let policy = f.secrets.permission_policy(&scope, &call).unwrap().unwrap();
    assert!(
        policy.should_review_in_auto_mode
            && policy.should_run_in_full_access_in_auto_mode
            && policy.requires_auto_or_full_access
    );
    assert!(policy.action.contains("unrestricted host filesystem read"));
    assert!(policy.action.contains("\\u{202e}"));
    f.close().await;
}
#[tokio::test]
async fn dotenv_replacement_removes_obsolete_names_and_keeps_attachments() {
    let f = Fixture::new().await;
    f.create("fixture", json!({"Token":"old","OLD":"obsolete"}))
        .await;
    let agent = cuid2::create_id();
    let configuration = json!({});
    let settings = json!({});
    let scope = AgentScope {
        id: &agent,
        configuration: &configuration,
        settings: &settings,
    };
    let owner = f.secrets.clone();
    let target = json!({"type":"agent","id":agent});
    let attachment = f
        .runtime
        .transact(move |ctx| owner.attach(ctx, "fixture", &target, None))
        .await
        .unwrap()
        .0;
    let path = f._directory.path().join("fixture.env");
    std::fs::write(&path, "TOKEN=rotated\nNEW='fresh'\n").unwrap();
    let call = json!({"id":"tool-replace","call":{"name":"update_secret","arguments":json!({"secretId":"fixture","dotenvFile":path}).to_string()}});
    let result = f
        .secrets
        .execute_tool(&scope, &call, CancellationToken::new())
        .await
        .unwrap();
    assert!(!serde_json::to_string(&result).unwrap().contains("rotated"));
    assert!(!serde_json::to_string(&result).unwrap().contains("fresh"));
    let owner = f.secrets.clone();
    f.runtime
        .transact(move |ctx| {
            let record = owner.get(ctx, "fixture")?.unwrap();
            assert_eq!(record["environmentVariables"], json!(["NEW", "Token"]));
            assert_eq!(
                owner.attachment_page(ctx, "fixture", &json!({}))?.unwrap()["attachments"],
                json!([attachment])
            );
            Ok(())
        })
        .await
        .unwrap();
    f.close().await;
}
