//! Full resources expose actual owner ancestry and retain each child's own version.
use super::*;

async fn focused(graph: &Graph, agent: &str) -> Value {
    let (status, value) = graph
        .request("GET", &format!("/v0/agents/{agent}"), None, None)
        .await;
    assert_eq!(status, 200, "{value}");
    value
}

#[tokio::test]
async fn focused_agents_include_active_subtask_trees_shared_workspaces_and_durable_running_children()
 {
    let mut fixture = Fixture::new().await;
    std::fs::create_dir_all(&fixture.config.paths.configuration).unwrap();
    std::fs::write(fixture.config.paths.configuration.join("happy.toml"),"[providers.fixture]\ntype = 'codex'\nenabled = true\napi_key = 'projection-fixture-only'\ncredential_isolation = true\ninclude_models = ['openai/gpt-5.6-sol']\n").unwrap();
    fixture.restart().await;
    let mut graph = Graph::install(fixture).await;
    let bots = graph.api.bots.clone();
    let bot = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            bots.create(
                ctx,
                &json!({"name":"Projection fixture", "username":"projection_fixture"}),
            )
        })
        .await
        .unwrap();
    let parent = bot["agentId"].as_str().unwrap().to_owned();
    let workspace = bot["workspaceId"].clone();
    let main = cuid2::create_id();
    let nested = cuid2::create_id();
    let sibling = cuid2::create_id();
    let hidden = cuid2::create_id();
    let model = graph
        .collaboration
        .available_models()
        .unwrap()
        .into_iter()
        .next()
        .unwrap();
    let input = json!({"title":"Visible task", "text":"Work on this task.", "provider":model["providerId"], "model":model["id"], "effort":model["defaultEffort"]});
    for (actor, id) in [(&parent, &main), (&main, &nested), (&parent, &sibling)] {
        let owner = graph.subtasks.clone();
        let actor = actor.clone();
        let id = id.clone();
        let input = input.clone();
        graph
            .fixture
            .runtime
            .transact(move |ctx| owner.create(ctx, &actor, &input, &id, None, None))
            .await
            .unwrap();
    }
    let agents = graph.agents.clone();
    let actor = main.clone();
    let hidden_id = hidden.clone();
    let history = graph.history.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let mut configuration = agents.configuration(ctx, &actor)?.unwrap();
            configuration["metadata"] = json!({"title":"Hidden child"});
            agents.create_from(ctx, &hidden_id, &configuration, Some(&actor))?;
            agents.set_parent(ctx, &hidden_id, &actor)?;
            history.begin_run(ctx, &hidden_id, "projection-running-child", 100)?;
            Ok(())
        })
        .await
        .unwrap();
    let root = focused(&graph, &parent).await;
    assert_eq!(
        root["agent"]["subtasks"].as_array().unwrap().len(),
        2,
        "The parent's resource must expose both active direct subtasks."
    );
    assert_eq!(root["agent"]["workspaceId"], workspace);
    assert_eq!(
        root["agent"]["userVisible"], true,
        "A bot is visible without an owner-series order key."
    );
    let task = root["agent"]["subtasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| task["id"] == main)
        .unwrap();
    assert_eq!(task["parentAgentId"], parent);
    assert_eq!(
        task["workspaceId"], workspace,
        "Shared tasks inherit the coordinator's workspace."
    );
    assert_eq!(task["managedByAnotherAgent"], true);
    assert_eq!(task["userVisible"], true);
    assert_eq!(task["canSendMessages"], true);
    assert_eq!(task["subtask"], true);
    assert!(task["orderKey"].is_null());
    assert!(task["subtaskOrderKey"].is_string());
    assert_eq!(task["subagents"], json!({"total":2,"running":1}));
    assert_eq!(
        task["subtasks"].as_array().unwrap().len(),
        1,
        "The hidden child stays outside the user-visible tree."
    );
    assert_eq!(task["subtasks"][0]["id"], nested);
    assert_eq!(task["subtasks"][0]["subtasks"], json!([]));
    let direct = focused(&graph, &main).await;
    assert_eq!(
        task["version"], direct["agent"]["version"],
        "Nested copies retain the child's independent resource version."
    );
    let private = focused(&graph, &hidden).await;
    assert_eq!(private["agent"]["workspaceId"], workspace);
    assert_eq!(
        private["agent"]["status"], "working",
        "Durable running history counts even without an active inference row."
    );
    assert_eq!(private["agent"]["userVisible"], false);
    assert_eq!(private["agent"]["canSendMessages"], false);
    let agents = graph.agents.clone();
    let task_id = main.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            agents.update_metadata(ctx, &task_id, &json!({"title":"Updated task title"}))?;
            agents.update_metadata(ctx, &task_id, &json!({"title":"Settled task title"}))
        })
        .await
        .unwrap();
    let output = tokio::process::Command::new("node")
        .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/client_agent_tree.mjs"))
        .args([
            graph.url.as_str(),
            parent.as_str(),
            main.as_str(),
            nested.as_str(),
            sibling.as_str(),
            hidden.as_str(),
            workspace.as_str().unwrap(),
        ])
        .env("HAPPY_TEST_API_TOKEN", &graph.token)
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout)
            .contains("Published client validated independently versioned subtask trees")
    );
    let agents = graph.agents.clone();
    let task_id = main.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| agents.update_metadata(ctx, &task_id, &json!({"archivedAt":200})))
        .await
        .unwrap();
    let archived = focused(&graph, &main).await;
    assert_eq!(archived["agent"]["canSendMessages"], false);
    let after = focused(&graph, &parent).await;
    assert_eq!(
        after["agent"]["subtasks"].as_array().unwrap().len(),
        1,
        "Archiving one task prunes its branch without flattening its child."
    );
    assert_eq!(after["agent"]["subtasks"][0]["id"], sibling);
    graph.close().await;
}

#[tokio::test]
async fn focused_agent_catalog_includes_module_owned_skills_and_source_profiles() {
    let fixture = Fixture::new().await;
    let path = fixture.config.global_skills_root().join("review-fixture");
    std::fs::create_dir_all(&path).unwrap();
    std::fs::write(path.join("SKILL.md"),"---\nname: review-fixture\ndescription: Review this fixture carefully.\ndisable-model-invocation: true\n---\nInspect the fixture.\n").unwrap();
    let mut graph = Graph::install(fixture).await;
    let bots = graph.api.bots.clone();
    let bot = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            bots.create(
                ctx,
                &json!({"name":"Catalog fixture","username":"catalog_fixture"}),
            )
        })
        .await
        .unwrap();
    let response = focused(&graph, bot["agentId"].as_str().unwrap()).await;
    let source: Value =
        serde_json::from_str(include_str!("../agents/source_goldens.json")).unwrap();
    assert_eq!(response["profiles"], source["profiles"]);
    assert_eq!(
        response["slashCommands"][0],
        source["compactionCommands"][0]
    );
    assert!(response["slashCommands"].as_array().unwrap().contains(&json!({"description":"Review this fixture carefully.","hasArguments":true,"kind":"skill","name":"review-fixture"})),"A user-invokable skill stays in the focused catalog even when the model cannot invoke it.");
    graph.close().await;
}
