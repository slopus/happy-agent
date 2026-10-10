use super::*;
use crate::product::{
    history::HistoryModule,
    owners::{Fixture, RunnersModule},
    secrets::SecretsModule,
    services::ServicesModule,
    usage::UsageModule,
};
use std::path::{Path, PathBuf};
struct Graph {
    fixture: Fixture,
    compute_directory: tempfile::TempDir,
    module: Arc<SystemPromptModule>,
    tools: Arc<ToolsModule>,
    services: Arc<ServicesModule>,
    runners: Arc<RunnersModule>,
}
impl Graph {
    async fn new() -> Self {
        let fixture = Fixture::new().await;
        let usage = Arc::new(
            UsageModule::new(
                fixture.runtime.clone(),
                fixture.events.clone(),
                fixture.config.clone(),
            )
            .unwrap(),
        );
        usage.load().await.unwrap();
        let history = Arc::new(
            HistoryModule::new(
                fixture.config.clone(),
                fixture.runtime.clone(),
                fixture.events.clone(),
                usage,
            )
            .unwrap(),
        );
        history.load().await.unwrap();
        let secrets = SecretsModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        secrets.load().await.unwrap();
        let services = ServicesModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            fixture.lifecycle.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        services.load().await.unwrap();
        let runners = RunnersModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        runners.load().await.unwrap();
        let tools = Arc::new(
            ToolsModule::new(
                fixture.config.clone(),
                history,
                fixture.lifecycle.clone(),
                fixture.runtime.clone(),
                secrets,
                services.clone(),
                fixture.events.clone(),
                runners.clone(),
                crate::product::docker::DockerModule::new(
                    fixture.config.clone(),
                    fixture.runtime.clone(),
                    fixture.durable.clone(),
                    fixture.lifecycle.clone(),
                    runners.clone(),
                )
                .unwrap(),
            )
            .unwrap(),
        );
        let module = SystemPromptModule::new(
            fixture.config.clone(),
            tools.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
        )
        .unwrap();
        Self {
            fixture,
            #[cfg(unix)]
            compute_directory: tempfile::tempdir_in("/tmp").unwrap(),
            #[cfg(not(unix))]
            compute_directory: tempfile::tempdir().unwrap(),
            module,
            tools,
            services,
            runners,
        }
    }
    async fn close(&self) {
        self.tools.close().await;
        self.runners.close().await;
        self.services.close().await.unwrap();
        self.fixture.close().await;
    }
    fn root(&self) -> PathBuf {
        self.compute_directory.path().join("source")
    }
    fn configuration(&self, cwd: &Path) -> Value {
        json!({"modules":{"compute":{"cwd":cwd}}})
    }
}
fn golden() -> Value {
    serde_json::from_str(include_str!("source_goldens.json")).unwrap()
}
#[test]
fn model_selection_identity_environment_and_instruction_format_match_executed_source() {
    let golden = golden();
    for case in golden["prompts"].as_array().unwrap() {
        assert_eq!(
            template(&case["selection"])
                .replace("{{name}}", "Happy Agent")
                .replacen("{{identity}}", "You are Happy Agent, built by Happy", 1),
            case["prompt"]
        );
    }
    assert_eq!(
        format::models(golden["models"].as_array().unwrap()),
        golden["modelText"]
    );
    for case in golden["environmentCases"].as_array().unwrap() {
        assert_eq!(format::environment(&case["input"]), case["output"]);
    }
    for case in golden["formatCases"].as_array().unwrap() {
        let snapshot = (!case["snapshot"].is_null()).then_some(&case["snapshot"]);
        assert_eq!(format::body(snapshot), case["body"]);
        assert_eq!(format::instructions(snapshot), case["instructions"]);
        assert_eq!(
            format::fingerprint(&format::body(snapshot)),
            case["fingerprint"]
        );
    }
    for case in golden["outputCases"].as_array().unwrap() {
        assert_eq!(
            format::fit_instructions(
                case["input"].as_str().unwrap(),
                case["maximum"].as_i64().unwrap() as isize
            ),
            case["output"]
        );
    }
}
fn remap(value: &mut Value, root: &Path) {
    match value {
        Value::String(text) if text == "/source" || text.starts_with("/source/") => {
            *text = format!("{}{}", root.display(), &text[7..])
        }
        Value::Array(values) => {
            for value in values {
                remap(value, root);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                remap(value, root);
            }
        }
        _ => {}
    }
}
#[tokio::test]
async fn native_compute_instruction_discovery_matches_source_git_hierarchy_bounds_and_link_errors()
{
    for case in golden()["readCases"].as_array().unwrap() {
        let graph = Graph::new().await;
        let root = graph.root();
        for (path, text) in case["input"]["files"].as_object().unwrap() {
            // Source's outside-root sentinel is intentionally absent from this isolated host.
            if !path.starts_with("/source/") {
                continue;
            }
            let path = root.join(&path[8..]);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text.as_str().unwrap()).unwrap();
        }
        let cwd = root.join(
            case["input"]["cwd"]
                .as_str()
                .unwrap()
                .strip_prefix("/source/")
                .unwrap_or(""),
        );
        std::fs::create_dir_all(&cwd).unwrap();
        #[cfg(unix)]
        if let Some(symbolic) = case["input"]["symbolic"].as_array() {
            for path in symbolic {
                let path = root.join(path.as_str().unwrap().strip_prefix("/source/").unwrap());
                let target = root.join("linked-rules");
                std::fs::rename(&path, &target).unwrap();
                std::os::unix::fs::symlink(target, path).unwrap();
            }
        }
        let configuration = graph.configuration(&cwd);
        let settings = json!({"permissionMode":"read_only"});
        let scope = AgentScope {
            id: "source-agent",
            configuration: &configuration,
            settings: &settings,
        };
        let result = graph
            .module
            .read_agents_md(&scope, &CancellationToken::new())
            .await;
        if let Some(error) = case["error"].as_str() {
            #[cfg(unix)]
            assert_eq!(
                result.unwrap_err().to_string(),
                error.replace("/source", &root.display().to_string())
            );
            #[cfg(not(unix))]
            let _ = error;
        } else {
            let mut expected = case["snapshot"].clone();
            remap(&mut expected, &root);
            assert_eq!(result.unwrap().unwrap(), expected);
        }
        graph.close().await;
    }
}
#[tokio::test]
async fn global_instructions_read_fresh_without_compute_and_preserve_source_utf8_omission_semantics()
 {
    let graph = Graph::new().await;
    let configuration = json!({});
    let settings = json!({"permissionMode":"auto"});
    let scope = AgentScope {
        id: "source-agent",
        configuration: &configuration,
        settings: &settings,
    };
    assert!(
        graph
            .module
            .read_agents_md(&scope, &CancellationToken::new())
            .await
            .unwrap()
            .is_none()
    );
    std::fs::write(
        &graph.fixture.config.paths.instructions,
        "\u{feff} First rules \n",
    )
    .unwrap();
    let snapshot = graph
        .module
        .read_agents_md(&scope, &CancellationToken::new())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snapshot["global"]["text"], "First rules");
    assert_eq!(snapshot["documents"], json!([]));
    std::fs::write(
        &graph.fixture.config.paths.instructions,
        format!("{}🚀tail", "a".repeat(256 * 1024 - 1)),
    )
    .unwrap();
    let snapshot = graph
        .module
        .read_agents_md(&scope, &CancellationToken::new())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        snapshot["global"]["text"].as_str().unwrap().len(),
        256 * 1024 - 1
    );
    assert_eq!(snapshot["truncated"], true);
    assert!(!snapshot["global"]["text"].as_str().unwrap().contains('�'));
    std::fs::write(&graph.fixture.config.paths.instructions, "New rules").unwrap();
    let text = graph
        .module
        .read_agents_md_instructions(&scope, &CancellationToken::new())
        .await
        .unwrap()
        .unwrap();
    assert!(text.contains("New rules"));
    assert!(!text.contains("First rules"));
    assert!(graph.module.prompt_for(&json!({"model":""})).is_err());
    assert!(graph.module.prompt_for(&json!({"unknown":true})).is_err());
    for case in golden()["globalReadCases"].as_array().unwrap() {
        let bytes = case["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| byte.as_u64().unwrap() as u8)
            .collect::<Vec<_>>();
        std::fs::write(&graph.fixture.config.paths.instructions, bytes).unwrap();
        assert_eq!(
            graph
                .fixture
                .config
                .read_global_instructions(case["maximum"].as_u64().unwrap() as usize)
                .await
                .unwrap()
                .unwrap(),
            case["output"]
        );
    }
    graph.close().await;
}
#[tokio::test]
async fn instruction_notices_retain_identity_until_matching_transactional_acceptance_and_reviews_do_not_mutate_delivery()
 {
    let graph = Graph::new().await;
    let root = graph.root();
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("AGENTS.md"), "First rules").unwrap();
    let configuration = graph.configuration(&root);
    let settings = json!({"permissionMode":"auto"});
    let scope = AgentScope {
        id: "source-agent",
        configuration: &configuration,
        settings: &settings,
    };
    assert!(
        graph
            .module
            .prepare_turn(&scope, &CancellationToken::new())
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        graph
            .module
            .instructions_snapshot(&scope)
            .await
            .unwrap()
            .contains("First rules")
    );
    std::fs::write(root.join("AGENTS.md"), "Replacement rules").unwrap();
    let notices = graph
        .module
        .prepare_turn(&scope, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(notices.len(), 1);
    let captures = golden();
    let expected = &captures["noticeCases"]["replacementAction"];
    let native_text = notices[0]["message"]["content"][0]["text"]
        .as_str()
        .unwrap();
    assert_eq!(
        native_text.replace(&root.display().to_string(), "/source"),
        expected["message"]["content"][0]["text"]
    );
    assert_eq!(
        notices[0]["metadata"]["hideFromUser"],
        expected["metadata"]["hideFromUser"]
    );
    assert_eq!(
        notices[0]["metadata"]["agentsMd"]["kind"],
        expected["metadata"]["agentsMd"]["kind"]
    );
    let source_body = native_text
        .strip_prefix(&format!("{}\n\n", format::REPLACEMENT))
        .unwrap()
        .replace(&root.display().to_string(), "/source");
    assert_eq!(
        format::fingerprint(&source_body),
        captures["noticeCases"]["acceptedFingerprint"]
    );
    assert_eq!(
        notices,
        graph
            .module
            .prepare_turn(&scope, &CancellationToken::new())
            .await
            .unwrap()
    );
    std::fs::write(root.join("AGENTS.md"), "Reviewed live rules").unwrap();
    assert!(
        graph
            .module
            .read_agents_md_instructions(&scope, &CancellationToken::new())
            .await
            .unwrap()
            .unwrap()
            .contains("Reviewed live rules")
    );
    assert!(
        graph
            .module
            .instructions_snapshot(&scope)
            .await
            .unwrap()
            .contains("Replacement rules")
    );
    let module = graph.module.clone();
    let notice = notices[0].clone();
    let cfg = configuration.clone();
    let mode = settings.clone();
    let rollback = graph
        .fixture
        .runtime
        .transact(move |ctx| -> Result<()> {
            module.accept_notices(
                ctx,
                &AgentScope {
                    id: "source-agent",
                    configuration: &cfg,
                    settings: &mode,
                },
                &[AcceptedInput {
                    input: notice,
                    requested_call: None,
                }],
                true,
            )?;
            anyhow::bail!("Rollback the notice acceptance");
        })
        .await;
    assert!(rollback.is_err());
    let notice = notices[0].clone();
    let module = graph.module.clone();
    let cfg = configuration.clone();
    let mode = settings.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert!(
                ctx.value(
                    "source-agent",
                    &state::key("source-agent", "pending-notice")
                )?
                .is_some()
            );
            let mut forged = notice.clone();
            forged["message"]["content"][0]["text"] = json!("Forged replacement");
            module.accept_notices(
                ctx,
                &AgentScope {
                    id: "source-agent",
                    configuration: &cfg,
                    settings: &mode,
                },
                &[AcceptedInput {
                    input: forged,
                    requested_call: None,
                }],
                true,
            )?;
            assert!(
                ctx.value(
                    "source-agent",
                    &state::key("source-agent", "pending-notice")
                )?
                .is_some()
            );
            module.accept_notices(
                ctx,
                &AgentScope {
                    id: "source-agent",
                    configuration: &cfg,
                    settings: &mode,
                },
                &[AcceptedInput {
                    input: notice.clone(),
                    requested_call: None,
                }],
                false,
            )?;
            assert!(
                ctx.value(
                    "source-agent",
                    &state::key("source-agent", "pending-notice")
                )?
                .is_some()
            );
            module.accept_notices(
                ctx,
                &AgentScope {
                    id: "source-agent",
                    configuration: &cfg,
                    settings: &mode,
                },
                &[AcceptedInput {
                    input: notice.clone(),
                    requested_call: None,
                }],
                true,
            )?;
            assert!(
                ctx.value(
                    "source-agent",
                    &state::key("source-agent", "pending-notice")
                )?
                .is_none()
            );
            assert_eq!(
                ctx.value(
                    "source-agent",
                    &state::key("source-agent", "last-delivered-fingerprint")
                )?
                .unwrap(),
                notice["metadata"]["agentsMd"]["fingerprint"]
            );
            Ok(())
        })
        .await
        .unwrap();
    std::fs::remove_file(root.join("AGENTS.md")).unwrap();
    let removed = graph
        .module
        .prepare_turn(&scope, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(removed[0]["message"]["content"][0]["text"], format::REMOVAL);
    assert_eq!(
        removed[0]["message"],
        golden()["noticeCases"]["removalAction"]["message"]
    );
    assert!(removed[0]["metadata"]["agentsMd"]["fingerprint"].is_null());
    graph.fixture.runtime.transact(|ctx| ctx.put_value("source-agent", &state::key("source-agent", "turn-instructions-snapshot"), &json!({"cwd":"/source","documents":[{"path":"/source/AGENTS.md","text":"😀".repeat(20000)}]}))).await.unwrap();
    assert!(
        graph
            .module
            .instructions_snapshot(&scope)
            .await
            .unwrap_err()
            .to_string()
            .contains("Stored AGENTS.md turn snapshot is invalid")
    );
    graph.close().await;
}
