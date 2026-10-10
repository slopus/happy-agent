use super::*;
use crate::product::{owners::Fixture, workspaces::WorkspacesModule};

#[tokio::test]
async fn source_project_mutation_refuses_a_backwards_update_time_and_rolls_back() {
    let fixture = Fixture::new().await;
    let owner = Arc::new(ProjectsModule::new(fixture.runtime.clone()).unwrap());
    owner.load().await.unwrap();
    let source: Value =
        serde_json::from_str(include_str!("catalog_invariant_goldens.json")).unwrap();
    let initial = source["clock"]["projectBefore"].clone();
    let module = owner.clone();
    fixture
        .runtime
        .transact(move |ctx| persistence::insert(ctx, &module.schemas, &initial))
        .await
        .unwrap();
    let module = owner.clone();
    let result = fixture
        .runtime
        .transact(move |ctx| module.rename(ctx, "clock-project", "Future project name", 2))
        .await;
    assert!(result.is_err());
    fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                owner.get(ctx, "clock-project")?.unwrap(),
                source["clock"]["projectAfter"]
            );
            Ok(())
        })
        .await
        .unwrap();
    fixture.close().await;
}

#[tokio::test]
async fn source_catalog_get_rejects_schema_valid_records_with_impossible_domain_state() {
    let fixture = Fixture::new().await;
    let projects = Arc::new(ProjectsModule::new(fixture.runtime.clone()).unwrap());
    let workspaces = Arc::new(WorkspacesModule::new(fixture.runtime.clone()));
    projects.load().await.unwrap();
    workspaces.load().await.unwrap();
    let source: Value =
        serde_json::from_str(include_str!("catalog_invariant_goldens.json")).unwrap();
    fixture.runtime.transact(move |ctx| {
        persistence::insert(ctx,&projects.schemas,&source["projectBase"])?;
        for case in source["projects"].as_array().unwrap() {
            let record=&case["record"];
            assert!(projects.schemas.valid("ownerProject",record)?);
            ctx.database().execute("UPDATE happy_agent_module_projects SET status=?1,kind=?2,initialization_status=?3,initialization_error=?4,worktree_support=?5,worktree_unsupported_reason=?6,updated_at=?7,archived_at=?8 WHERE id='invariant-project'",rusqlite::params![record["status"].as_str(),record["kind"].as_str(),record["initializationStatus"].as_str(),record["initializationError"].as_str(),record["worktreeSupport"].as_str(),record["worktreeUnsupportedReason"].as_str(),record["updatedAt"].as_i64(),record["archivedAt"].as_i64()])?;
            assert_eq!(projects.get(ctx,"invariant-project").is_ok(),case["accepted"].as_bool().unwrap(),"project changes {}",case["changes"]);
        }
        let base=&source["workspaceBase"];
        ctx.database().execute("INSERT INTO happy_agent_module_workspaces(id,project_ref,parent_id,name,name_key,name_configured,branch,storage_key,kind,path,presence,status,order_key,version,git_ahead,git_behind,git_detached,initialization_attempt,created_at,updated_at) VALUES(?1,?2,?3,?4,?4,1,?5,?6,'directory',?7,'present','ready','500',2,0,0,0,1,100,200)",rusqlite::params![base["id"].as_str(),base["projectRef"].as_str(),base["parentId"].as_str(),base["name"].as_str(),base["branch"].as_str(),base["storageKey"].as_str(),base["path"].as_str()])?;
        for case in source["workspaces"].as_array().unwrap() {
            let record=&case["record"];
            assert!(projects.schemas.valid("ownerWorkspace",record)?);
            ctx.database().execute("UPDATE happy_agent_module_workspaces SET status=?1,presence=?2,version=?3,updated_at=?4,archived_at=?5 WHERE id='invariant-workspace'",rusqlite::params![record["status"].as_str(),record["presence"].as_str(),record["version"].as_i64(),record["updatedAt"].as_i64(),record["archivedAt"].as_i64()])?;
            assert_eq!(workspaces.get(ctx,"invariant-workspace").is_ok(),case["accepted"].as_bool().unwrap(),"workspace changes {}",case["changes"]);
        }
        Ok(())
    }).await.unwrap();
    fixture.close().await;
}

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
