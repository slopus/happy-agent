use super::*;
use crate::product::{owners::Fixture, workspaces::WorkspacesModule};

#[tokio::test]
async fn source_catalog_pages_and_agent_orders_match_real_sqlite_queries() {
    let fixture = Fixture::new().await;
    let projects = Arc::new(ProjectsModule::new(fixture.runtime.clone()).unwrap());
    let workspaces = Arc::new(WorkspacesModule::new(fixture.runtime.clone()));
    projects.load().await.unwrap();
    workspaces.load().await.unwrap();
    let source: Value = serde_json::from_str(include_str!("catalog_goldens.json")).unwrap();
    let project_owner = projects.clone();
    let workspace_owner = workspaces.clone();
    let records = source.clone();
    fixture.runtime.transact(move |ctx| {
        for project in records["projects"].as_array().unwrap() {
            persistence::insert(ctx, &project_owner.schemas, project)?;
        }
        // Use the workspace owner's representation by mapping captured rows through its public get.
        for workspace in records["workspaces"].as_array().unwrap() {
            let columns = ["id", "project_ref", "parent_id", "name", "name_key", "name_configured", "branch", "storage_key", "kind", "path", "presence", "status", "order_key", "version", "git_ahead", "git_behind", "git_detached", "initialization_attempt", "created_at", "updated_at", "archived_at"];
            let values = ["id", "projectRef", "parentId", "name", "name", "nameConfigured", "branch", "storageKey", "kind", "path", "presence", "status", "orderKey", "version", "gitAhead", "gitBehind", "gitDetached", "initializationAttempt", "createdAt", "updatedAt", "archivedAt"].map(|field| match workspace.get(field) {
                Some(Value::String(value)) => rusqlite::types::Value::Text(value.clone()),
                Some(Value::Bool(value)) => rusqlite::types::Value::Integer(i64::from(*value)),
                Some(Value::Number(value)) => rusqlite::types::Value::Integer(value.as_i64().unwrap()),
                _ => rusqlite::types::Value::Null,
            });
            ctx.database().execute(&format!("INSERT INTO happy_agent_module_workspaces({}) VALUES({})", columns.join(","), (1..=columns.len()).map(|index|format!("?{index}")).collect::<Vec<_>>().join(",")), rusqlite::params_from_iter(values))?;
            assert_eq!(workspace_owner.get(ctx, workspace["id"].as_str().unwrap())?.as_ref(), Some(workspace));
        }
        for agent in records["projectAgents"].as_array().unwrap() {
            persistence::attach(ctx,"project-02",agent["agentId"].as_str().unwrap(),agent["orderKey"].as_str().unwrap())?;
        }
        for agent in records["workspaceAgents"].as_array().unwrap() {
            ctx.database().execute("INSERT INTO happy_agent_module_workspace_agents(workspace_id,agent_id,order_key) VALUES('workspace-03',?1,?2)",rusqlite::params![agent["agentId"].as_str(),agent["orderKey"].as_str()])?;
        }
        Ok(())
    }).await.unwrap();
    let original = source.clone();
    fixture
        .runtime
        .transact(move |ctx| {
            for case in original["projectPages"].as_array().unwrap() {
                assert_eq!(
                    projects.list_catalog_page(ctx, &case["query"])?,
                    case["result"]
                );
            }
            for case in original["workspacePages"].as_array().unwrap() {
                assert_eq!(
                    workspaces.list_catalog_page(ctx, &case["query"])?,
                    case["result"]
                );
            }
            for query in original["invalidProjectQueries"].as_array().unwrap() {
                assert!(
                    projects.list_catalog_page(ctx, query).is_err(),
                    "query {query}"
                );
            }
            for query in original["invalidWorkspaceQueries"].as_array().unwrap() {
                assert!(
                    workspaces.list_catalog_page(ctx, query).is_err(),
                    "query {query}"
                );
            }
            assert_eq!(
                json!(projects.list_agents(ctx, "project-02")?),
                original["sourceProjectAgents"]
            );
            assert_eq!(
                json!(workspaces.list_agents(ctx, "workspace-03")?),
                original["sourceWorkspaceAgents"]
            );
            assert_eq!(
                projects.find_by_path(ctx, "/tmp/native-catalog/project-07", Some("fixture"))?,
                Some(original["projects"][7].clone())
            );
            assert_eq!(
                projects.find_by_path(ctx, "/tmp/native-catalog/project-07", None)?,
                None
            );
            Ok(())
        })
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn catalog_filters_skip_corrupt_unrelated_rows_and_read_uncommitted_changes_atomically() {
    let fixture = Fixture::new().await;
    let projects = Arc::new(ProjectsModule::new(fixture.runtime.clone()).unwrap());
    let workspaces = Arc::new(WorkspacesModule::new(fixture.runtime.clone()));
    projects.load().await.unwrap();
    workspaces.load().await.unwrap();
    let original: Value = serde_json::from_str(include_str!("catalog_goldens.json")).unwrap();
    let project_owner = projects.clone();
    fixture
        .runtime
        .transact(move |ctx| {
            persistence::insert(ctx, &project_owner.schemas, &original["projects"][0])?;
            ctx.database().execute(
                "UPDATE happy_agent_module_projects SET git_detached=2 WHERE id='project-00'",
                [],
            )?;
            assert_eq!(
                project_owner.list_catalog_page(ctx, &json!({}))?,
                json!({"projects":[]})
            );
            assert!(
                project_owner
                    .list_catalog_page(ctx, &json!({"includeArchived":true}))
                    .is_err()
            );
            Ok(())
        })
        .await
        .unwrap();
    let project_owner = projects.clone();
    let transaction: Result<()> = fixture.runtime.transact(move |ctx| {
        ctx.database().execute("UPDATE happy_agent_module_projects SET git_detached=0,status='active',archived_at=NULL WHERE id='project-00'",[])?;
        assert_eq!(project_owner.list_catalog_page(ctx,&json!({}))?["projects"].as_array().unwrap().len(),1);
        anyhow::bail!("Roll back the catalog mutation.")
    }).await;
    assert!(transaction.is_err());
    fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                projects.list_catalog_page(ctx, &json!({}))?,
                json!({"projects":[]})
            );
            assert_eq!(
                workspaces.list_catalog_page(ctx, &json!({}))?,
                json!({"workspaces":[],"cursor":0})
            );
            Ok(())
        })
        .await
        .unwrap();
    fixture.close().await;
}
