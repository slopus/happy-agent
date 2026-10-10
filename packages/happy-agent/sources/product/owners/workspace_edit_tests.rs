//! Source events, names and sibling order through the actual installed owner.
use super::*;
use crate::product::projects::tests::Graph;

#[tokio::test]
async fn source_workspace_mutation_advances_update_time_even_when_the_clock_is_behind() {
    let graph = Graph::new().await;
    let source: Value =
        serde_json::from_str(include_str!("catalog_invariant_goldens.json")).unwrap();
    let workspaces = graph.workspaces.clone();
    let projects = graph.projects.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            projects.register(ctx, &source["projectBase"])?;
            persistence::insert(ctx, &Schemas::new()?, &source["clock"]["workspaceBefore"])?;
            let result = workspaces.rename(ctx, "clock-workspace", "Future workspace name", 2)?;
            assert_eq!(result, source["clock"]["workspaceAfter"]);
            Ok(())
        })
        .await
        .unwrap();
    graph.close().await;
}

fn comparable(value: &Value) -> Value {
    match value {
        Value::Object(value) => Value::Object(
            value
                .iter()
                .filter(|(key, _)| {
                    !["eventId", "at", "updatedAt", "archivedAt"].contains(&key.as_str())
                })
                .map(|(key, value)| (key.clone(), comparable(value)))
                .collect(),
        ),
        Value::Array(value) => Value::Array(value.iter().map(comparable).collect()),
        _ => value.clone(),
    }
}

#[tokio::test]
async fn source_workspace_edits_preserve_name_settlement_noops_sibling_order_and_events() {
    let graph = Graph::new().await;
    let source: Value = serde_json::from_str(include_str!("workspace_edit_goldens.json")).unwrap();
    let projects = graph.projects.clone();
    let workspaces = graph.workspaces.clone();
    let initial = source.clone();
    let agents = graph.agents.clone();
    let configuration = graph
        .fixture
        .config
        .agent_configuration(
            graph.fixture.directory.path().to_str().unwrap(),
            "workspaceprojectfixture",
            "workspacefixture1",
            None,
        )
        .unwrap();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            projects.register(ctx, &initial["project"])?;
            agents.create(ctx, "workspaceagentfixtureone", &configuration)?;
            agents.create(ctx, "workspaceagentfixturechild", &configuration)?;
            agents.set_parent(
                ctx,
                "workspaceagentfixturechild",
                "workspaceagentfixtureone",
            )?;
            for row in initial["initial"].as_array().unwrap() {
                persistence::insert(ctx, &Schemas::new()?, row)?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = events.clone();
    let lookup = workspaces.clone();
    let _subscription = workspaces
        .on_event_transactional(Arc::new(move |ctx, event| {
            assert_eq!(
                lookup
                    .get(ctx, event["workspace"]["id"].as_str().unwrap())?
                    .as_ref(),
                Some(&event["workspace"])
            );
            observed.lock().unwrap().push(event.clone());
            Ok(())
        }))
        .unwrap();
    for case in source["cases"].as_array().unwrap() {
        let case = case.clone();
        let expected = case.clone();
        let workspaces = workspaces.clone();
        let count = events.lock().unwrap().len();
        let result = graph
            .fixture
            .runtime
            .transact(move |ctx| {
                let input = &case["input"];
                let id = input["workspaceId"].as_str().unwrap();
                let version = input["expectedVersion"].as_u64().unwrap_or(0);
                match case["kind"].as_str().unwrap() {
                    "rename" => {
                        workspaces.rename(ctx, id, input["name"].as_str().unwrap(), version)
                    }
                    "reorder" => workspaces.reorder(ctx, id, input["afterId"].as_str(), version),
                    "archive" => workspaces.archive_with_version(ctx, id, version),
                    "attach" => {
                        workspaces.attach_agent(ctx, id, input["agentId"].as_str().unwrap())
                    }
                    _ => unreachable!(),
                }
            })
            .await
            .unwrap();
        assert_eq!(comparable(&result), expected["result"]);
        assert_eq!(
            comparable(&json!(events.lock().unwrap()[count..].to_vec())),
            expected["events"]
        );
    }
    let owner = workspaces.clone();
    graph.fixture.runtime.transact(move |ctx|{
        assert!(owner.attach_agent(ctx,"workspacefixture2","workspaceagentfixturechild").is_err());
        let stale=owner.rename(ctx,"workspacefixture1","Stale",2).unwrap_err();
        assert!(matches!(stale.downcast_ref::<WorkspaceError>(),Some(WorkspaceError::Conflict(current)) if current["status"]=="archiving"));
        let unrelated=owner.reorder(ctx,"workspacefixture2",Some("workspacefixture5"),2).unwrap_err();
        assert!(matches!(unrelated.downcast_ref::<WorkspaceError>(),Some(WorkspaceError::Invalid(_))));
        Ok(())
    }).await.unwrap();
    graph.close().await;
}

#[tokio::test]
async fn workspace_observer_failure_rolls_back_archive_tree_and_intent_without_mcp_notification() {
    let graph = Graph::new().await;
    let source: Value = serde_json::from_str(include_str!("workspace_edit_goldens.json")).unwrap();
    let projects = graph.projects.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            projects.register(ctx, &source["project"])?;
            for row in source["initial"].as_array().unwrap() {
                persistence::insert(ctx, &Schemas::new()?, row)?;
            }
            Ok(())
        })
        .await
        .unwrap();
    let notifications = Arc::new(Mutex::new(Vec::new()));
    let notified = notifications.clone();
    graph
        .workspaces
        .listen_transitions(Arc::new(move |row| {
            notified.lock().unwrap().push(row.clone())
        }))
        .unwrap();
    let rejection = graph
        .workspaces
        .on_event_transactional(Arc::new(|_ctx, _event| {
            anyhow::bail!("Reject the archive transaction.")
        }))
        .unwrap();
    let before = graph.fixture.pending().await.unwrap();
    let owner = graph.workspaces.clone();
    assert!(
        graph
            .fixture
            .runtime
            .transact(move |ctx| owner.archive_with_version(ctx, "workspacefixture2", 2))
            .await
            .is_err()
    );
    assert_eq!(graph.fixture.pending().await.unwrap(), before);
    assert!(notifications.lock().unwrap().is_empty());
    let owner = graph.workspaces.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                owner.get(ctx, "workspacefixture2")?.unwrap()["status"],
                "ready"
            );
            assert_eq!(
                owner.get(ctx, "workspacefixture5")?.unwrap()["status"],
                "ready"
            );
            Ok(())
        })
        .await
        .unwrap();
    drop(rejection);
    let owner = graph.workspaces.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.archive_with_version(ctx, "workspacefixture2", 2))
        .await
        .unwrap();
    assert_eq!(
        graph.fixture.pending().await.unwrap().len(),
        before.len() + 2
    );
    assert_eq!(notifications.lock().unwrap().len(), 2);
    graph.close().await;
}
