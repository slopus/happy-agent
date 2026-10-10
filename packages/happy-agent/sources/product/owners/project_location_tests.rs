//! The installed Projects owner follows the actual Source cached Home location.
use super::tests::Graph;
use super::*;
use crate::product::owners::{Fixture, RunnerUnavailableError};

#[tokio::test]
async fn source_home_root_scope_uses_cached_default_runner_and_refuses_unknown_home() {
    let mut fixture = Fixture::new().await;
    std::fs::create_dir_all(&fixture.config.paths.configuration).unwrap();
    std::fs::write(fixture.config.paths.configuration.join("happy.toml"),"[runners.fixture]\nname = \"Fixture runner\"\ntoken = \"0123456789012345678901234567890123456789012\"\n").unwrap();
    fixture.restart().await;
    let graph = Graph::install(fixture).await;
    let source: Value =
        serde_json::from_str(include_str!("project_location_goldens.json")).unwrap();
    let owner = graph.projects.clone();
    let original = source.clone();
    graph.fixture.runtime.transact(move |ctx| {
        persistence::insert(ctx,&owner.schemas,&original["project"])?;
        for case in original["cases"].as_array().unwrap() {
            ctx.database().execute("INSERT INTO happy_agent_runners_snapshot VALUES(1,?1) ON CONFLICT(singleton_id) DO UPDATE SET snapshot_json=excluded.snapshot_json",[case["snapshot"].to_string()])?;
            assert_eq!(owner.compute(ctx,&original["project"])?,case["compute"]);
            let scope=owner.root_workspace(ctx,"home-project");
            if case["unavailable"]==true {
                let error=scope.unwrap_err();
                assert!(error.downcast_ref::<RunnerUnavailableError>().is_some(),"{error:#}");
            } else {
                let scope=scope?.unwrap();
                assert_eq!(scope["root"],case["location"]["path"]);
                assert_eq!(scope["runnerId"],case["location"]["runnerId"]);
                assert_eq!(scope["id"],original["project"]["id"]);
            }
        }
        Ok(())
    }).await.unwrap();
    graph.close().await;
}
