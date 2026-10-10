//! Registration uses real folders and preserves the Source catalog decision atomically.
use super::tests::Graph;
use super::*;

fn comparable(value: &Value, root: &str) -> Value {
    match value {
        Value::Object(value) => Value::Object(
            value
                .iter()
                .filter(|(key, _)| {
                    !["eventId", "at", "createdAt", "updatedAt", "archivedAt"]
                        .contains(&key.as_str())
                })
                .map(|(key, value)| (key.clone(), comparable(value, root)))
                .collect(),
        ),
        Value::Array(value) => {
            Value::Array(value.iter().map(|value| comparable(value, root)).collect())
        }
        Value::String(value) => json!(value.replace(root, "%ROOT%")),
        _ => value.clone(),
    }
}

#[tokio::test]
async fn source_registration_uses_the_source_name_when_a_folder_name_is_only_spaces() {
    let graph = Graph::new().await;
    let path = graph.fixture.directory.path().join("  ");
    std::fs::create_dir(&path).unwrap();
    let source: Value =
        serde_json::from_str(include_str!("project_registration_goldens.json")).unwrap();
    let expected = source["cases"].as_array().unwrap().last().unwrap()["result"].clone();
    let prepared = graph
        .projects
        .prepare_registration(
            &json!({"path":path,"projectId":expected["id"]}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let owner = graph.projects.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let actual = owner.register_path(ctx, &prepared)?;
            assert_eq!(actual["name"], expected["name"]);
            assert_eq!(actual["storageKey"], expected["storageKey"]);
            Ok(())
        })
        .await
        .unwrap();
    graph.close().await;
}

#[tokio::test]
async fn source_registration_preserves_plain_folders_alias_retries_restore_and_setup() {
    let graph = Graph::new().await;
    let root = graph.fixture.directory.path().to_str().unwrap().to_owned();
    std::fs::create_dir(graph.fixture.directory.path().join("plain-folder")).unwrap();
    std::fs::create_dir(graph.fixture.directory.path().join("other-folder")).unwrap();
    std::fs::create_dir(graph.fixture.directory.path().join("  ")).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        graph.fixture.directory.path().join("plain-folder"),
        graph.fixture.directory.path().join("alias"),
    )
    .unwrap();
    std::fs::write(
        graph.fixture.directory.path().join("file"),
        "a regular file",
    )
    .unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = events.clone();
    let _subscription = graph
        .projects
        .on_event_transactional(Arc::new(move |_ctx, event| {
            observed.lock().unwrap().push(event.clone());
            Ok(())
        }))
        .unwrap();
    let source: Value =
        serde_json::from_str(include_str!("project_registration_goldens.json")).unwrap();
    for case in source["cases"].as_array().unwrap() {
        let kind = case["kind"].as_str().unwrap();
        let input: Value =
            serde_json::from_str(&case["input"].to_string().replace("%ROOT%", &root)).unwrap();
        let count = events.lock().unwrap().len();
        let owner = graph.projects.clone();
        let result = if kind == "register" || kind == "registration_error" {
            match owner
                .prepare_registration(&input, &CancellationToken::new())
                .await
            {
                Ok(prepared) => {
                    graph
                        .fixture
                        .runtime
                        .transact(move |ctx| owner.register_path(ctx, &prepared))
                        .await
                }
                Err(error) => Err(error),
            }
        } else {
            let id = input["projectId"].as_str().unwrap().to_owned();
            let kind = kind.to_owned();
            graph
                .fixture
                .runtime
                .transact(move |ctx| match kind.as_str() {
                    "set_up_again" => owner.set_up_again(ctx, &id),
                    "archive" => owner
                        .archive(ctx, &id)?
                        .context("The archived project is missing."),
                    _ => unreachable!(),
                })
                .await
        };
        if kind == "registration_error" {
            let error = result.unwrap_err();
            let typed = error.downcast_ref::<ProjectError>().unwrap();
            match typed {
                ProjectError::Invalid { code, .. } => {
                    assert_eq!(*code, case["code"].as_str().unwrap())
                }
                _ => panic!("{error:#}"),
            }
        } else {
            assert_eq!(
                comparable(&result.unwrap(), &root),
                case["result"],
                "{kind}"
            );
            let emitted = events.lock().unwrap()[count..].to_vec();
            assert_eq!(
                comparable(&json!(emitted), &root),
                case["events"],
                "{kind} events"
            );
        }
    }
    graph.close().await;
}

#[tokio::test]
async fn registration_observer_failure_rolls_back_catalog_and_durable_setup_and_releases_preparation()
 {
    let graph = Graph::new().await;
    let path = graph.fixture.directory.path().join("plain-folder");
    std::fs::create_dir(&path).unwrap();
    let before = graph.fixture.pending().await.unwrap();
    let rejection = graph
        .projects
        .on_event_transactional(Arc::new(|_ctx, _event| {
            anyhow::bail!("Reject the atomic registration.")
        }))
        .unwrap();
    let prepared = graph
        .projects
        .prepare_registration(
            &json!({"path":path,"projectId":"projectregisterrollback"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let owner = graph.projects.clone();
    let result = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.register_path(ctx, &prepared))
        .await;
    assert!(result.is_err());
    assert_eq!(graph.fixture.pending().await.unwrap(), before);
    let owner = graph.projects.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert!(owner.get(ctx, "projectregisterrollback")?.is_none());
            Ok(())
        })
        .await
        .unwrap();
    drop(rejection);
    let prepared = tokio::time::timeout(
        Duration::from_secs(2),
        graph.projects.prepare_registration(
            &json!({"path":path,"projectId":"projectregisterrollback"}),
            &CancellationToken::new(),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let owner = graph.projects.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.register_path(ctx, &prepared))
        .await
        .unwrap();
    assert_eq!(
        graph.fixture.pending().await.unwrap().len(),
        before.len() + 1
    );
    graph.close().await;
}
