//! Source captures exercise clone acceptance independently from asynchronous execution.
use super::{tests::Graph, *};
use std::collections::BTreeMap;

fn comparable(value: &Value, root: &str, managed: &str) -> Value {
    match value {
        Value::Object(value) => Value::Object(
            value
                .iter()
                .filter(|(key, _)| {
                    !["eventId", "at", "createdAt", "updatedAt", "archivedAt"]
                        .contains(&key.as_str())
                })
                .map(|(key, value)| (key.clone(), comparable(value, root, managed)))
                .collect(),
        ),
        Value::Array(value) => Value::Array(
            value
                .iter()
                .map(|value| comparable(value, root, managed))
                .collect(),
        ),
        Value::String(value) => json!(
            value
                .replace(managed, "%ROOT%/projects")
                .replace(root, "%ROOT%")
        ),
        _ => value.clone(),
    }
}
fn no_credentials(graph: &Graph) {
    graph
        .fixture
        .config
        .set_github_test_environment(BTreeMap::new());
}

#[tokio::test]
#[cfg(unix)]
async fn source_remote_name_limit_counts_unicode_characters() {
    let graph = Graph::new().await;
    no_credentials(&graph);
    let source: Value = serde_json::from_str(include_str!("project_remote_goldens.json")).unwrap();
    for case in source["nameCases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let result = graph.projects.prepare_remote(&json!({"name":name,"source":{"kind":"git","url":"https://example.com/repository"}}), &CancellationToken::new()).await;
        if let Some(expected) = case.get("error") {
            let error = result
                .err()
                .expect("The Source name guard rejected this name.");
            match error.downcast_ref::<ProjectError>().unwrap() {
                ProjectError::Invalid { message, .. } => {
                    assert_eq!(message, expected.as_str().unwrap())
                }
                _ => panic!("{error:#}"),
            }
        } else {
            assert_eq!(case["result"], case["name"]);
            assert_eq!(name.chars().count(), 70);
            assert_eq!(name.encode_utf16().count(), 140);
            let prepared = result.unwrap();
            let owner = graph.projects.clone();
            let project = graph
                .fixture
                .runtime
                .transact(move |ctx| owner.register_remote(ctx, &prepared))
                .await
                .unwrap();
            assert_eq!(project["name"], case["result"]);
        }
    }
    graph.close().await;
}

async fn wait_initialization(graph: &Graph, id: &str, status: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let owner = graph.projects.clone();
            let id = id.to_owned();
            let row = graph
                .fixture
                .runtime
                .transact(move |ctx| owner.get(ctx, &id))
                .await
                .unwrap()
                .unwrap();
            if row["initializationStatus"] == status {
                return row;
            }
            if row["initializationStatus"] == "failed" {
                panic!("Managed clone setup failed: {row}");
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn managed_clone_recovery_accepts_only_the_expected_landed_repository_after_restart() {
    let graph = Graph::new().await;
    no_credentials(&graph);
    let input = json!({"name":"landed-folder","projectId":"projectremotelanded","source":{"kind":"git","url":"https://example.com/owner/repository.git"}});
    let prepared = graph
        .projects
        .prepare_remote(&input, &CancellationToken::new())
        .await
        .unwrap();
    let owner = graph.projects.clone();
    let project = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.register_remote(ctx, &prepared))
        .await
        .unwrap();
    let path = Path::new(project["repositoryRef"].as_str().unwrap());
    std::fs::create_dir(path).unwrap();
    for args in [
        vec!["init", "--initial-branch=main"],
        vec![
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "--allow-empty",
            "-m",
            "Fixture repository",
        ],
        vec![
            "remote",
            "add",
            "origin",
            "https://example.com/owner/repository.git",
        ],
    ] {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let graph = graph.restart().await;
    no_credentials(&graph);
    graph.fixture.durable.start().await.unwrap();
    let ready = wait_initialization(&graph, "projectremotelanded", "ready").await;
    assert_eq!(ready["presence"], "present");
    assert_eq!(ready["worktreeSupport"], "supported");
    assert_eq!(ready["defaultBranch"], "main");
    assert_eq!(ready["name"], "repository");
    assert_eq!(ready["initializationAttempt"], 1);
    graph
        .fixture
        .wait_pending_count("projects.provision", 0)
        .await;
    graph.close().await;
}

#[tokio::test]
async fn managed_github_recovery_uses_environment_credentials_without_rediscovering_the_cli_login()
{
    let graph = Graph::new().await;
    graph
        .fixture
        .config
        .set_github_test_environment(BTreeMap::from([(
            "GITHUB_TOKEN".to_owned(),
            "fixture-private-token".to_owned(),
        )]));
    let prepared = graph.projects.prepare_remote(&json!({"name":"private-folder","projectId":"projectremoterecovery","source":{"kind":"github","repository":"fixture/private"},"secret":{"kind":"github"}}), &CancellationToken::new()).await.unwrap();
    let owner = graph.projects.clone();
    let accepted = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.register_remote(ctx, &prepared))
        .await
        .unwrap();
    let graph = graph.restart().await;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = graph.fixture.directory.path().join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let gh = bin.join("gh");
        std::fs::write(&gh, "#!/bin/sh\nprintf called > \"$HOME/cli-invoked\"\nprintf 'unexpected-private-token\\n'\n").unwrap();
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        graph
            .fixture
            .config
            .set_github_test_environment(BTreeMap::from([
                (
                    "HOME".to_owned(),
                    graph.fixture.directory.path().to_str().unwrap().to_owned(),
                ),
                ("PATH".to_owned(), bin.to_str().unwrap().to_owned()),
            ]));
    }
    graph.fixture.durable.start().await.unwrap();
    let failed = wait_initialization(&graph, "projectremoterecovery", "failed").await;
    assert_eq!(
        failed["initializationError"],
        "GitHub credentials are unavailable. Try this project again once GitHub is connected."
    );
    assert_eq!(failed["initializationAttempt"], 1);
    assert!(!Path::new(accepted["repositoryRef"].as_str().unwrap()).exists());
    assert!(!graph.fixture.directory.path().join("cli-invoked").exists());
    assert!(!failed.to_string().contains("fixture-private-token"));
    graph.close().await;
}

#[tokio::test]
async fn source_remote_projects_preserve_exact_retries_conflicts_failure_events_and_credential_guards()
 {
    let graph = Graph::new().await;
    no_credentials(&graph);
    let root = graph.fixture.directory.path().to_str().unwrap().to_owned();
    let managed = graph
        .fixture
        .config
        .projects_home()
        .to_str()
        .unwrap()
        .to_owned();
    std::fs::create_dir_all(Path::new(&managed).join("existing-folder")).unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = events.clone();
    let _subscription = graph
        .projects
        .on_event_transactional(Arc::new(move |_ctx, event| {
            observed.lock().unwrap().push(event.clone());
            Ok(())
        }))
        .unwrap();
    let source: Value = serde_json::from_str(include_str!("project_remote_goldens.json")).unwrap();
    for case in source["cases"].as_array().unwrap() {
        if case["kind"] == "remote_credential" {
            graph
                .fixture
                .config
                .set_github_test_environment(BTreeMap::from([(
                    "GITHUB_TOKEN".to_owned(),
                    "fixture-private-token".to_owned(),
                )]));
        } else {
            no_credentials(&graph);
        }
        let input = case["input"].clone();
        let count = events.lock().unwrap().len();
        let owner = graph.projects.clone();
        let result = if case["kind"] == "failed" {
            graph
                .fixture
                .runtime
                .transact(move |ctx| {
                    let before = owner
                        .get(ctx, input["projectId"].as_str().unwrap())?
                        .unwrap();
                    let mut after = before.clone();
                    after["initializationStatus"] = json!("failed");
                    after["initializationAttempt"] =
                        json!(before["initializationAttempt"].as_u64().unwrap() + 1);
                    after["initializationError"] = input["error"].clone();
                    owner.write_state(ctx, &before, &mut after, "initialization_failed")?;
                    Ok(after)
                })
                .await
        } else {
            match owner
                .prepare_remote(&input, &CancellationToken::new())
                .await
            {
                Ok(prepared) => {
                    graph
                        .fixture
                        .runtime
                        .transact(move |ctx| owner.register_remote(ctx, &prepared))
                        .await
                }
                Err(error) => Err(error),
            }
        };
        if let Some(expected) = case.get("error") {
            let error = result.unwrap_err();
            match error.downcast_ref::<ProjectError>().unwrap() {
                ProjectError::Invalid { code, message } => {
                    assert_eq!(*code, expected["code"].as_str().unwrap());
                    assert_eq!(message, expected["message"].as_str().unwrap());
                }
                _ => panic!("{error:#}"),
            }
        } else {
            assert_eq!(
                comparable(&result.unwrap(), &root, &managed),
                case["result"],
                "{}",
                case["input"]
            );
            assert_eq!(
                comparable(
                    &json!(events.lock().unwrap()[count..].to_vec()),
                    &root,
                    &managed
                ),
                case["events"]
            );
        }
    }
    assert_eq!(
        graph
            .fixture
            .pending()
            .await
            .unwrap()
            .iter()
            .filter(|call| call["function"] == "projects.provision")
            .count(),
        2
    );
    graph.close().await;
}

#[tokio::test]
async fn remote_creation_rolls_back_credentials_catalog_and_clone_intent_before_a_successful_retry()
{
    let graph = Graph::new().await;
    graph
        .fixture
        .config
        .set_github_test_environment(BTreeMap::from([(
            "GITHUB_TOKEN".to_owned(),
            "fixture-private-token".to_owned(),
        )]));
    let input = json!({"name":"credential-folder","projectId":"projectremotecredential","source":{"kind":"github","repository":"fixture/repository"},"secret":{"kind":"github"}});
    let before = graph.fixture.pending().await.unwrap();
    let owner = graph.projects.clone();
    let inspection = owner.clone();
    let rejection = owner.on_event_transactional(Arc::new(move |ctx, _event| {
        let creator = json!({"instanceId":inspection.runtime.installation_epoch(ctx)?,"profileId":"local"});
        anyhow::ensure!(!inspection.owners()?.git.has_github_credential("projectremotecredential", &creator)?);
        anyhow::bail!("Reject the managed project atomically.")
    })).unwrap();
    let prepared = owner
        .prepare_remote(&input, &CancellationToken::new())
        .await
        .unwrap();
    assert!(
        graph
            .fixture
            .runtime
            .transact(move |ctx| owner.register_remote(ctx, &prepared))
            .await
            .is_err()
    );
    assert_eq!(graph.fixture.pending().await.unwrap(), before);
    let owner = graph.projects.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let creator =
                json!({"instanceId":owner.runtime.installation_epoch(ctx)?,"profileId":"local"});
            assert!(owner.get(ctx, "projectremotecredential")?.is_none());
            assert!(
                !owner
                    .owners()?
                    .git
                    .has_github_credential("projectremotecredential", &creator)?
            );
            Ok(())
        })
        .await
        .unwrap();
    drop(rejection);
    let prepared = graph
        .projects
        .prepare_remote(&input, &CancellationToken::new())
        .await
        .unwrap();
    let owner = graph.projects.clone();
    let project = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.register_remote(ctx, &prepared))
        .await
        .unwrap();
    assert!(!project.to_string().contains("fixture-private-token"));
    assert_eq!(
        graph.fixture.pending().await.unwrap().len(),
        before.len() + 1
    );
    let owner = graph.projects.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let creator =
                json!({"instanceId":owner.runtime.installation_epoch(ctx)?,"profileId":"local"});
            assert!(
                owner
                    .owners()?
                    .git
                    .has_github_credential("projectremotecredential", &creator)?
            );
            Ok(())
        })
        .await
        .unwrap();
    graph.close().await;
}

#[tokio::test]
async fn remote_preparation_rejects_unsafe_sources_reserved_names_and_unknown_runners() {
    let graph = Graph::new().await;
    no_credentials(&graph);
    let before = graph.fixture.pending().await.unwrap();
    for url in [
        "file:///tmp/repository",
        "git@example.com:owner/repository",
        "http://example.com/repository",
        "https://person:token@example.com/repository",
        "https://example.com:bad/repository",
    ] {
        assert!(
            graph
                .projects
                .prepare_remote(
                    &json!({"name":"safe-folder","source":{"kind":"git","url":url}}),
                    &CancellationToken::new()
                )
                .await
                .is_err(),
            "{url}"
        );
    }
    for name in [
        ".",
        "..",
        ".rig",
        "../escape",
        "folder/subfolder",
        "folder\\subfolder",
        "hidden\u{200b}name",
        " ",
    ] {
        assert!(graph.projects.prepare_remote(&json!({"name":name,"source":{"kind":"git","url":"https://example.com/repository"}}), &CancellationToken::new()).await.is_err(), "{name}");
    }
    let error = graph.projects.prepare_remote(&json!({"name":"safe-folder","source":{"kind":"git","url":"https://example.com/repository"},"runnerId":"missing-runner"}), &CancellationToken::new()).await.err().unwrap();
    assert!(matches!(
        error.downcast_ref::<ProjectError>(),
        Some(ProjectError::Invalid {
            code: "invalid_request",
            ..
        })
    ));
    assert_eq!(graph.fixture.pending().await.unwrap(), before);
    graph.close().await;
}

#[tokio::test]
async fn remote_preparation_canonicalizes_managed_parent_aliases_and_cancelled_conflicting_requests()
 {
    let graph = Graph::new().await;
    no_credentials(&graph);
    let managed = graph.fixture.config.projects_home();
    let actual = graph.fixture.directory.path().join("actual-managed-root");
    std::fs::create_dir_all(managed.parent().unwrap()).unwrap();
    std::fs::create_dir(&actual).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&actual, &managed).unwrap();
    let input = json!({"name":"safe-folder","projectId":"projectremotecanonical","source":{"kind":"git","url":"https://example.com/repository"}});
    let prepared = graph
        .projects
        .prepare_remote(&input, &CancellationToken::new())
        .await
        .unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(
        graph
            .projects
            .prepare_remote(&input, &cancel)
            .await
            .is_err()
    );
    let owner = graph.projects.clone();
    let project = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.register_remote(ctx, &prepared))
        .await
        .unwrap();
    assert_eq!(project["repositoryRef"], json!(actual.join("safe-folder")));
    assert!(!actual.join("safe-folder").exists());
    graph.close().await;
}
