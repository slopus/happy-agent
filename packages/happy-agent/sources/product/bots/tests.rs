use super::*;
use happy_providers::{Block, Message};
use crate::product::{
    auto::AutoModule,
    collaboration::CollaborationModule,
    goal::GoalModule,
    history::HistoryModule,
    owners::{Fixture, GitModule},
    permissions::PermissionsModule,
    presence::PresenceModule,
    scheduling::SchedulingModule,
    secrets::SecretsModule,
    services::ServicesModule,
    skills::SkillsModule,
    system_prompt::SystemPromptModule,
    skill_folders::SkillFoldersModule,
    subtasks::SubtasksModule,
    tasks::TasksModule,
    tools::ToolsModule,
    usage::UsageModule,
    user_input::UserInputModule,
    workflows::WorkflowsModule,
};

struct Graph {
    fixture: Fixture,
    bots: Arc<BotsModule>,
    agents: Arc<AgentRuntimeModule>,
    runners: Arc<RunnersModule>,
    git: Arc<GitModule>,
    services: Arc<ServicesModule>,
    collaboration: Arc<CollaborationModule>,
    subtasks: Arc<SubtasksModule>,
    projects: Arc<ProjectsModule>,
    workspaces: Arc<WorkspacesModule>,
    titles: Arc<TitlesModule>,
    history: Arc<HistoryModule>,
    presence: Arc<PresenceModule>,
    user_input: Arc<UserInputModule>,
    scheduling: Arc<SchedulingModule>,
    tasks: Arc<TasksModule>,
    goal: Arc<GoalModule>,
    workflows: Arc<WorkflowsModule>,
    skills: Arc<SkillsModule>,
    skill_folders: Arc<SkillFoldersModule>,
    system_prompt: Arc<SystemPromptModule>,
}
impl Graph {
    fn task_input(&self, title: &str) -> Value {
        let model = self
            .collaboration
            .available_models()
            .unwrap()
            .into_iter()
            .next()
            .expect("The original default model catalog is enabled.");
        json!({"title":title,"text":"Carry out the assigned task.","provider":model["providerId"],"model":model["id"],"effort":model["defaultEffort"]})
    }
    async fn subtask(
        &self,
        parent: &str,
        input: Value,
        id: &str,
        workspace: Option<&str>,
    ) -> Result<Value> {
        let module = self.subtasks.clone();
        let parent = parent.to_owned();
        let id = id.to_owned();
        let workspace = workspace.map(str::to_owned);
        self.fixture
            .runtime
            .transact(move |ctx| {
                module.create(ctx, &parent, &input, &id, workspace.as_deref(), None)
            })
            .await
    }
    async fn agent_config(&self, id: &str) -> Value {
        let agents = self.agents.clone();
        let id = id.to_owned();
        self.fixture
            .runtime
            .transact(move |ctx| agents.configuration(ctx, &id))
            .await
            .unwrap()
            .unwrap()
    }
    async fn project(&self) -> Value {
        let path = self.fixture.directory.path().join("source-project");
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("project.txt"), "source contents").unwrap();
        let id = cuid2::create_id();
        let record = json!({"id":id,"repositoryRef":path,"kind":"regular","storageKey":"source-project","name":"Source project","nameSource":"user","status":"active","presence":"present","initializationStatus":"ready","initializationAttempt":0,"worktreeSupport":"unsupported","gitAhead":0,"gitBehind":0,"gitDetached":false,"orderKey":"500","version":1,"createdAt":100,"updatedAt":100});
        let projects = self.projects.clone();
        self.fixture
            .runtime
            .transact(move |ctx| projects.register(ctx, &record))
            .await
            .unwrap()
    }
    async fn new() -> Self {
        Self::new_with_provider("http://127.0.0.1:9/v1").await
    }
    async fn new_with_provider(endpoint: &str) -> Self {
        let mut fixture = Fixture::new().await;
        std::fs::create_dir_all(&fixture.config.paths.configuration).unwrap();
        std::fs::write(
            fixture.config.paths.configuration.join("happy.toml"),
            format!(
                r#"
[providers.fixture]
type = "codex"
enabled = true
api_key = "fixture-only-token"
credential_isolation = true
base_url = "{endpoint}"
transport = "sse"
"#
            ),
        )
        .unwrap();
        fixture.restart().await;
        Self::install(fixture).await
    }
    async fn install(fixture: Fixture) -> Self {
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
                usage.clone(),
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
                history.clone(),
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
        let system_prompt = SystemPromptModule::new(fixture.config.clone(), tools.clone(), fixture.runtime.clone(), fixture.durable.clone()).unwrap();
        let auto = AutoModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            tools.clone(),
            fixture.lifecycle.clone(),
            system_prompt.clone(),
        )
        .unwrap();
        auto.load().await.unwrap();
        let permissions = Arc::new(
            PermissionsModule::new(auto.clone(), fixture.runtime.clone(), history.clone()).unwrap(),
        );
        let agents = Arc::new(AgentRuntimeModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            history.clone(),
            tools.clone(),
            usage,
            fixture.lifecycle.clone(),
            auto,
            permissions,
            fixture.events.clone(),
            system_prompt.clone(),
        ));
        let git = GitModule::new(fixture.config.clone(), runners.clone()).unwrap();
        let abort = AbortModule::new(
            fixture.runtime.clone(),
            agents.clone(),
            tools.clone(),
            services.clone(),
        );
        let projects = ProjectsModule::install(
            fixture.config.clone(),
            fixture.runtime.clone(),
            git.clone(),
            abort.clone(),
            fixture.durable.clone(),
            runners.clone(),
            services.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        projects.load().await.unwrap();
        let workspaces = WorkspacesModule::install(
            fixture.config.clone(),
            fixture.runtime.clone(),
            projects.clone(),
            git.clone(),
            abort.clone(),
            fixture.durable.clone(),
            runners.clone(),
            services.clone(),
            fixture.events.clone(),
        )
        .unwrap();
        workspaces.load().await.unwrap();
        let presence = PresenceModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            fixture.lifecycle.clone(),
            agents.clone(),
        )
        .unwrap();
        presence.load().await.unwrap();
        let user_input = UserInputModule::new(
            presence.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            agents.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        user_input.load().await.unwrap();
        let scheduling = SchedulingModule::new(
            fixture.runtime.clone(),
            fixture.durable.clone(),
            agents.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        scheduling.load().await.unwrap();
        let tasks = TasksModule::new(
            fixture.runtime.clone(),
            fixture.durable.clone(),
            agents.clone(),
        )
        .unwrap();
        tasks.load().await.unwrap();
        let goal = GoalModule::new(
            fixture.runtime.clone(),
            fixture.durable.clone(),
            agents.clone(),
        )
        .unwrap();
        goal.load().await.unwrap();
        let titles = TitlesModule::new(
            fixture.config.clone(),
            fixture.durable.clone(),
            fixture.lifecycle.clone(),
            fixture.runtime.clone(),
            agents.clone(),
            history.clone(),
            workspaces.clone(),
        )
        .unwrap();
        let bots = BotsModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            agents.clone(),
            abort.clone(),
            titles.clone(),
            projects.clone(),
            workspaces.clone(),
            runners.clone(),
            fixture.durable.clone(),
            fixture.events.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        bots.load().await.unwrap();
        let skill_folders=SkillFoldersModule::new(fixture.config.clone(),bots.clone(),fixture.runtime.clone(),agents.clone()).unwrap();
        let skills=SkillsModule::new(fixture.config.clone(),tools.clone(),fixture.skills.clone(),fixture.runtime.clone(),agents.clone()).unwrap();
        let collaboration = CollaborationModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            agents.clone(),
            abort.clone(),
            history.clone(),
            fixture.durable.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        collaboration.load().await.unwrap();
        let workflows = WorkflowsModule::new(
            fixture.config.clone(),
            collaboration.clone(),
            tools.clone(),
            fixture.runtime.clone(),
            fixture.durable.clone(),
            agents.clone(),
            fixture.lifecycle.clone(),
        )
        .unwrap();
        workflows.load().await.unwrap();
        let subtasks = SubtasksModule::new(
            fixture.config.clone(),
            fixture.runtime.clone(),
            agents.clone(),
            bots.clone(),
            collaboration.clone(),
            workspaces.clone(),
            fixture.durable.clone(),
            abort,
            tools,
            fixture.lifecycle.clone(),
        )
        .unwrap();
        agents.prepare().unwrap();
        agents.load().await.unwrap();
        Self {
            fixture,
            bots,
            agents,
            runners,
            git,
            services,
            collaboration,
            subtasks,
            projects,
            workspaces,
            titles,
            history,
            presence,
            user_input,
            scheduling,
            tasks,
            goal,
            workflows,
            skills,
            skill_folders,
            system_prompt,
        }
    }
    async fn close(&self) {
        self.fixture.lifecycle.begin_shutdown();
        self.fixture.durable.stop().await;
        self.agents.close().await;
        self.runners.close().await;
        self.git.close().await;
        self.services.close().await.unwrap();
        self.fixture.close().await;
    }
    async fn restart(self) -> Self {
        self.close().await;
        let mut fixture = self.fixture;
        fixture.restart().await;
        Self::install(fixture).await
    }
    async fn list(&self) -> Vec<Value> {
        let owner = self.bots.clone();
        self.fixture
            .runtime
            .transact(move |ctx| owner.list(ctx))
            .await
            .unwrap()
    }
    async fn create(&self, input: Value) -> Value {
        let owner = self.bots.clone();
        self.fixture
            .runtime
            .transact(move |ctx| owner.create_with_result(ctx, &input))
            .await
            .unwrap()
    }
}

async fn naming_provider(
    answers: Vec<&'static str>,
) -> (
    String,
    tokio::sync::mpsc::Receiver<Value>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    let task = tokio::spawn(async move {
        for answer in answers {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 16384);
                if bytes.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let headers = String::from_utf8(bytes.clone()).unwrap();
            assert!(headers.starts_with("POST /v1/responses "));
            let length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(length < 1024 * 1024);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            sender
                .send(serde_json::from_slice(&body).unwrap())
                .await
                .unwrap();
            let response=[json!({"type":"response.content_part.added","part":{"type":"output_text"}}),json!({"type":"response.output_text.delta","delta":answer}),json!({"type":"response.output_text.done"}),json!({"type":"response.completed","response":{"id":"fixture_naming_response","output":[],"usage":{}}})].into_iter().map(|event|format!("data: {event}\r\n\r\n")).collect::<String>();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    (format!("http://{address}/v1"), receiver, task)
}

async fn accept_title_message(graph: &Graph, agent: &str, text: &str) -> Result<()> {
    let titles = graph.titles.clone();
    let history = graph.history.clone();
    let agents = graph.agents.clone();
    let id = agent.to_owned();
    let text = text.to_owned();
    graph.fixture.runtime.transact(move|ctx|{
        history.accept(ctx,&id,&json!({"recordId":cuid2::create_id(),"role":"user","blocks":[{"type":"text","text":text}]}))?;
        let configuration=agents.configuration(ctx,&id)?.unwrap();
        titles.accepted(ctx,&AgentScope{id:&id,configuration:&configuration,settings:&json!({"provider":"fixture"})},&[AcceptedInput{input:json!({"message":{"role":"user","content":[{"type":"text","text":text}]},"metadata":{"provenance":"tool"}}),requested_call:None}],false)
    }).await
}

#[tokio::test]
async fn titles_use_first_and_second_actual_user_messages_once_and_preserve_deliberate_titles() {
    let (endpoint, mut requests, server) = naming_provider(vec![
        "<title>Initial Work</title>",
        "<title>Refined Work</title>",
    ])
    .await;
    let graph = Graph::new_with_provider(&endpoint).await;
    let agent = cuid2::create_id();
    let chosen = cuid2::create_id();
    let agents = graph.agents.clone();
    let id = agent.clone();
    let chosen_id = chosen.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            agents.create(ctx, &id, &json!({"metadata":{}}))?;
            agents.create(
                ctx,
                &chosen_id,
                &json!({"metadata":{"title":"A deliberate title"}}),
            )
        })
        .await
        .unwrap();
    accept_title_message(&graph, &agent, "First naming request")
        .await
        .unwrap();
    accept_title_message(&graph, &agent, "Second naming request")
        .await
        .unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    let second = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first["model"], "gpt-5.6-luna");
    assert!(first["tools"].as_array().is_none_or(Vec::is_empty));
    assert!(first.to_string().contains("First naming request"));
    assert!(!first.to_string().contains("Second naming request"));
    assert!(second.to_string().contains("Second naming request"));
    assert!(second.to_string().contains("Initial Work"));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if graph.agent_config(&agent).await["metadata"]["title"] == "Refined Work" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    accept_title_message(&graph, &agent, "Third user message does not name again")
        .await
        .unwrap();
    accept_title_message(&graph, &chosen, "First chosen-title message")
        .await
        .unwrap();
    accept_title_message(&graph, &chosen, "Second chosen-title message")
        .await
        .unwrap();
    assert_eq!(
        graph.agent_config(&chosen).await["metadata"]["title"],
        "A deliberate title"
    );
    assert!(requests.try_recv().is_err());
    server.await.unwrap();
    graph.close().await;
}

#[tokio::test]
async fn inherited_workspace_names_keep_numeric_prefixes_and_rollback_with_their_transaction() {
    let graph = Graph::new().await;
    let project = graph.project().await;
    let workspace = cuid2::create_id();
    let owner = graph.workspaces.clone();
    let project_id = project["id"].as_str().unwrap().to_owned();
    let workspace_id = workspace.clone();
    let created = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.create_workspace(
                ctx,
                &project_id,
                &json!({"id":workspace_id,"name":"12 New workspace","nameConfigured":false}),
                None,
                None,
            )
        })
        .await
        .unwrap()
        .unwrap();
    let owner = graph.workspaces.clone();
    let id = workspace.clone();
    let named = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let name = owner.name_with_preserved_prefix("12 New workspace", "retry-policy");
            owner.inherit_name(ctx, &id, &name)
        })
        .await
        .unwrap();
    assert_eq!(named["name"], "12 retry-policy");
    assert_eq!(named["branch"], "worktree/12-retry-policy");
    assert_eq!(named["path"], created["path"]);
    assert_eq!(named["storageKey"], created["storageKey"]);
    let owner = graph.workspaces.clone();
    let id = workspace.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.inherit_name(ctx, &id, "Rolled back")?;
            anyhow::bail!("Rollback the naming mutation.");
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        })
        .await
        .unwrap_err();
    let owner = graph.workspaces.clone();
    let id = workspace.clone();
    let stored = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.get(ctx, &id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored, named);
    graph.close().await;
}

#[tokio::test]
async fn collaborator_birth_opening_receipt_and_settlement_keep_real_identity_and_provenance() {
    let (endpoint, mut requests, server) = naming_provider(vec![
        "Parent ready",
        "Verbatim collaborator answer",
        "Parent received the report",
    ])
    .await;
    let graph = Graph::new_with_provider(&endpoint).await;
    let parent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let selection = graph.task_input("Research collaborator");
    let agents = graph.agents.clone();
    let id = parent.clone();
    let settings = selection.clone();
    graph.fixture.runtime.transact(move|ctx|agents.enqueue(ctx,&id,&json!({"id":cuid2::create_id(),"message":{"role":"agent","author":{"id":id,"description":"Fixture caller"},"content":[{"type":"text","text":"Prepare the parent's context."}]},"options":{"provider":settings["provider"],"model":settings["model"],"effort":settings["effort"],"permissionMode":"auto"}}),false)).await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    graph
        .agents
        .wait_for_idle(&parent, &CancellationToken::new())
        .await
        .unwrap();
    let child = cuid2::create_id();
    let owner = graph.collaboration.clone();
    let history = graph.history.clone();
    let agents = graph.agents.clone();
    let id = child.clone();
    let creator = parent.clone();
    graph.fixture.runtime.transact(move|ctx|{
        let original=agents.configuration(ctx,&creator)?.unwrap();
        history.append(ctx,&creator,&json!({"recordId":cuid2::create_id(),"role":"assistant","blocks":[{"type":"tool_call","callId":id,"name":"create_agent","arguments":selection}]}))?;
        owner.create_tool_agent(ctx,&creator,&selection,&id,None)?;
        owner.create_tool_agent(ctx,&creator,&selection,&id,None)?;
        let created=agents.configuration(ctx,&id)?.unwrap();
        assert_eq!(created["environment"],original["environment"]);assert_eq!(created["modules"],original["modules"]);assert_eq!(created["provenance"]["createdBy"],creator);assert!(created["provenance"]["createdAt"].is_number());
        assert_eq!(agents.parent(ctx,&id)?.as_deref(),Some(creator.as_str()));
        assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_values WHERE owner_id=?1 AND key GLOB 'send.*'",[&id],|row|row.get(0))?,1);
        Ok(())
    }).await.unwrap();
    let child_request = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        child_request
            .to_string()
            .contains("Carry out the assigned task.")
    );
    let report_request = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        report_request
            .to_string()
            .contains("Verbatim collaborator answer")
    );
    assert!(
        report_request
            .to_string()
            .contains(&format!("Collaborator {child} finished working"))
    );
    graph
        .agents
        .wait_for_idle(&child, &CancellationToken::new())
        .await
        .unwrap();
    graph
        .agents
        .wait_for_idle(&parent, &CancellationToken::new())
        .await
        .unwrap();
    let history = graph
        .history
        .messages(child.clone(), None, None, 50, false)
        .await
        .unwrap();
    let opening = &history["runs"][0]["messages"][0];
    assert_eq!(opening["id"], child);
    assert_eq!(opening["role"], "agent");
    assert_eq!(opening["metadata"]["senderAgentId"], parent);
    assert!(opening["metadata"]["userId"].is_null());
    let child_settings = graph.agents.clone();
    let id = child.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                ctx.value(&id, "settings")?.unwrap()["permissionMode"],
                "auto"
            );
            assert!(child_settings.owed(ctx, &id)?.is_none());
            Ok(())
        })
        .await
        .unwrap();
    assert!(requests.try_recv().is_err());
    server.await.unwrap();
    graph.close().await;
}

#[tokio::test]
async fn presence_catalog_and_notifications_follow_the_original_transaction_and_reference_rules() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let graph = Graph::new().await;
    let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events = observed.clone();
    let _subscription = graph
        .presence
        .on_event(Arc::new(move |event| {
            events.lock().unwrap().push(event.clone())
        }))
        .unwrap();
    let reject = Arc::new(AtomicBool::new(true));
    let refusing = reject.clone();
    let _transactional = graph
        .presence
        .on_event_transactional(Arc::new(move |_, _| {
            anyhow::ensure!(
                !refusing.load(Ordering::SeqCst),
                "Reject the presence transition."
            );
            Ok(())
        }))
        .unwrap();
    let mut changes = graph.presence.subscribe_user_input();
    let owner = graph.presence.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert!(owner.read(ctx)?.is_none());
            let catalog = owner.list_presences(ctx)?;
            assert_eq!(catalog.len(), 4);
            assert!(
                catalog
                    .iter()
                    .find(|definition| definition["id"] == "online")
                    .unwrap()["answerWaitMs"]
                    .is_null()
            );
            owner.set_presence(ctx, &json!({"status":"away"}))
        })
        .await
        .unwrap_err();
    assert!(observed.lock().unwrap().is_empty());
    assert!(!changes.has_changed().unwrap());
    reject.store(false, Ordering::SeqCst);
    let owner = graph.presence.clone();
    graph.fixture.runtime.transact(move|ctx|owner.set_definition(ctx,&json!({"id":"focus","status":"custom","title":"Focus","emoji":"🟣","prompt":"Continue carefully.","answerWaitMs":3000}))).await.unwrap();
    let owner = graph.presence.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.set_presence(ctx, &json!({"presenceId":"focus"})))
        .await
        .unwrap();
    changes.changed().await.unwrap();
    assert_eq!(
        changes.borrow_and_update().as_ref().unwrap()["answerWaitMs"],
        3000
    );
    let owner = graph.presence.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.clear_definition(ctx, "focus"))
        .await
        .unwrap_err();
    let owner = graph.presence.clone();
    let schedule=graph.fixture.runtime.transact(move|ctx|owner.set_schedule(ctx,&json!({"days":[6,1],"startTime":"09:00","endTime":"17:00","timeZone":"America/New_York","presence":{"status":"away"}}))).await.unwrap();
    assert_eq!(schedule["days"], json!([1, 6]));
    let count = observed.lock().unwrap().len();
    let owner = graph.presence.clone();
    let duplicate=graph.fixture.runtime.transact(move|ctx|owner.set_schedule(ctx,&json!({"days":[1,6],"startTime":"09:00","endTime":"17:00","timeZone":"America/New_York","presence":{"presenceId":"away"}}))).await.unwrap();
    assert_eq!(duplicate, schedule);
    assert_eq!(observed.lock().unwrap().len(), count);
    graph.close().await;
}

#[tokio::test]
async fn temporary_presence_reads_its_original_fallback_without_an_unshipped_timer_event() {
    let graph = Graph::new().await;
    let owner = graph.presence.clone();
    let expiry = now() + 1000;
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.set_presence(
                ctx,
                &json!({"status":"away","until":expiry,"fallbackPresenceId":"online"}),
            )
        })
        .await
        .unwrap();
    let changes = graph.presence.subscribe_user_input();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let owner = graph.presence.clone();
            let state = graph
                .fixture
                .runtime
                .transact(move |ctx| owner.read(ctx))
                .await
                .unwrap()
                .unwrap();
            if state["status"] == "online" {
                assert_eq!(state["effectiveFrom"], expiry);
                assert!(state.get("expiresAt").is_none());
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!changes.has_changed().unwrap());
    graph.close().await;
}

#[tokio::test]
async fn user_input_transactions_rejoin_the_original_call_and_validate_every_batch_answer() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let graph = Graph::new().await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let input = json!({"context":"Choose how to ship.","questions":[{"header":"Release scope","question":"Which product?","options":[{"label":"Agent","description":"Ship Agent"},{"label":"Terminal","description":"Ship Terminal"}]},{"id":"channel","question":"Which channel?"}],"autoResolutionMs":60000});
    let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events = observed.clone();
    let _observer = graph
        .user_input
        .on_event(Arc::new(move |event| {
            events.lock().unwrap().push(event.clone())
        }))
        .unwrap();
    let reject = Arc::new(AtomicBool::new(true));
    let rejecting = reject.clone();
    let _listener = graph
        .user_input
        .on_event_transactional(Arc::new(move |_, _| {
            anyhow::ensure!(
                !rejecting.load(Ordering::SeqCst),
                "Reject the question transaction."
            );
            Ok(())
        }))
        .unwrap();
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    let request = input.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.ask(ctx, &acting, &request, Some("original-call")))
        .await
        .unwrap_err();
    assert!(observed.lock().unwrap().is_empty());
    reject.store(false, Ordering::SeqCst);
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    let request = input.clone();
    let pending = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let first = owner.ask(ctx, &acting, &request, Some("original-call"))?;
            assert_eq!(
                owner.ask(ctx, &acting, &request, Some("original-call"))?,
                first
            );
            assert_eq!(
                owner.latest_question_at(ctx, &acting)?,
                first["createdAt"].as_u64()
            );
            assert_eq!(
                ctx.database().query_row::<u64, _, _>(
                    "SELECT count(*) FROM happy_user_input_requests",
                    [],
                    |row| row.get(0)
                )?,
                1
            );
            Ok(first)
        })
        .await
        .unwrap();
    assert_eq!(pending["questions"][0]["id"], "question_1");
    assert_eq!(pending["options"]["multiSelect"], false);
    assert_eq!(observed.lock().unwrap().len(), 1);
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.answer(
                ctx,
                &acting,
                &json!({"requestId":"original-call","answer":"Agent"}),
            )
        })
        .await
        .unwrap_err();
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    graph.fixture.runtime.transact(move|ctx|owner.answer(ctx,&acting,&json!({"requestId":"original-call","answers":{"question_1":{"selectedOptions":["Undeclared"]},"channel":"Preview"}}))).await.unwrap_err();
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    let answered=graph.fixture.runtime.transact(move|ctx|owner.answer(ctx,&acting,&json!({"requestId":"original-call","answers":{"question_1":{"selectedOptions":["Agent"],"text":"Agent please"},"channel":"Preview"}}))).await.unwrap();
    assert_eq!(answered["status"], "answered");
    assert_eq!(observed.lock().unwrap().len(), 2);
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    let idempotent = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                owner.ask(ctx, &acting, &input, Some("original-call"))?,
                answered
            );
            owner.cancel(
                ctx,
                &acting,
                &json!({"requestId":"original-call","reason":"Too late"}),
            )
        })
        .await
        .unwrap();
    assert_eq!(idempotent["status"], "answered");
    assert_eq!(observed.lock().unwrap().len(), 2);
    graph.close().await;
}

#[tokio::test]
async fn user_input_ancestor_access_detail_cursors_and_restart_keep_the_original_durable_rows() {
    let graph = Graph::new().await;
    let parent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let child = cuid2::create_id();
    let unrelated = cuid2::create_id();
    let agents = graph.agents.clone();
    let id = child.clone();
    let creator = parent.clone();
    let outsider = unrelated.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            agents.create_from(ctx, &id, &json!({"metadata":{}}), Some(&creator))?;
            agents.set_parent(ctx, &id, &creator)?;
            agents.create(ctx, &outsider, &json!({"metadata":{}}))
        })
        .await
        .unwrap();
    let input =
        json!({"question":"Read the long context","context":format!("{}😀","c".repeat(7000))});
    let owner = graph.user_input.clone();
    let acting = child.clone();
    let ask = input.clone();
    let pending = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.ask(ctx, &acting, &ask, Some("durable-request")))
        .await
        .unwrap();
    let owner = graph.user_input.clone();
    let acting = unrelated;
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.get(ctx, &acting, "durable-request"))
        .await
        .unwrap_err();
    let owner = graph.user_input.clone();
    let acting = child.clone();
    let ancestor = parent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert!(
                owner
                    .list(ctx, &ancestor, &json!({"askingAgentId":acting}))?
                    .len()
                    == 1
            );
            owner.get(ctx, &acting, "unknown-request")
        })
        .await
        .unwrap();
    let owner = graph.user_input.clone();
    let acting = parent.clone();
    let (page, second) = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let page = owner.get_page(
                ctx,
                &acting,
                "durable-request",
                &json!({"detailLimit":2000}),
            )?;
            let second = owner.get_page(
                ctx,
                &acting,
                "durable-request",
                &json!({"cursor":page["nextCursor"],"limit":4000}),
            )?;
            assert!(
                owner
                    .format_detail_page_for_model(&second)?
                    .encode_utf16()
                    .count()
                    <= 8000
            );
            Ok((page, second))
        })
        .await
        .unwrap();
    assert_eq!(page["cursor"], 0);
    assert_eq!(second["cursor"], 2000);
    let graph = graph.restart().await;
    let owner = graph.user_input.clone();
    let acting = parent.clone();
    let child_id = child.clone();
    let answered = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let restored = owner.get(ctx, &acting, "durable-request")?.unwrap();
            assert_eq!(restored, pending);
            assert_eq!(
                owner.latest_question_at(ctx, &child_id)?,
                restored["createdAt"].as_u64()
            );
            owner.answer(
                ctx,
                &acting,
                &json!({"requestId":"durable-request","answer":"Received while not waiting"}),
            )
        })
        .await
        .unwrap();
    assert_eq!(
        graph
            .user_input
            .wait(&child, "durable-request", &CancellationToken::new())
            .await
            .unwrap(),
        answered
    );
    graph.close().await;
}

#[tokio::test]
async fn user_input_away_timeout_and_manual_presence_wake_match_the_shipped_terminal_policy() {
    let graph = Graph::new().await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = graph.presence.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.set_presence(ctx, &json!({"status":"away"})))
        .await
        .unwrap();
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.ask(
                ctx,
                &acting,
                &json!({"question":"Away question?","context":"Continue independently"}),
                Some("away-question"),
            )
        })
        .await
        .unwrap();
    let away = graph
        .user_input
        .wait(&agent, "away-question", &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(away["status"], "away");
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                owner.answer(
                    ctx,
                    &acting,
                    &json!({"requestId":"away-question","answer":"An answer later"})
                )?,
                away
            );
            Ok(())
        })
        .await
        .unwrap();
    let owner = graph.presence.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.set_presence(ctx, &json!({"status":"online"})))
        .await
        .unwrap();
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    let deadline = now() + 200;
    let pending=graph.fixture.runtime.transact(move|ctx|owner.ask(ctx,&acting,&json!({"question":"Deadline question?","context":"A real absolute deadline","deadlineAt":deadline}),Some("deadline-question"))).await.unwrap();
    let timed = tokio::time::timeout(
        Duration::from_secs(5),
        graph
            .user_input
            .wait(&agent, "deadline-question", &CancellationToken::new()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(timed["status"], "timed_out");
    assert_eq!(timed["deadlineAt"], pending["deadlineAt"]);
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.ask(
                ctx,
                &acting,
                &json!({"question":"Wait until presence changes?","context":"No request deadline"}),
                Some("presence-question"),
            )
        })
        .await
        .unwrap();
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    let waiting = tokio::spawn(async move {
        owner
            .wait(&acting, "presence-question", &CancellationToken::new())
            .await
    });
    let owner = graph.presence.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.set_presence(ctx, &json!({"status":"away"})))
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), waiting)
            .await
            .unwrap()
            .unwrap()
            .unwrap()["status"],
        "away"
    );
    graph.close().await;
}

#[tokio::test]
async fn user_input_cancelled_wait_leaves_the_pending_request_and_aborted_turn_cancels_it_atomically()
 {
    let graph = Graph::new().await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.ask(
                ctx,
                &acting,
                &json!({"question":"Pending during drain?","context":"Preserve the original call"}),
                Some("drain-question"),
            )
        })
        .await
        .unwrap();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    graph
        .user_input
        .wait(&agent, "drain-question", &cancelled)
        .await
        .unwrap_err();
    let owner = graph.user_input.clone();
    let agents = graph.agents.clone();
    let acting = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                owner.get(ctx, &acting, "drain-question")?.unwrap()["status"],
                "pending"
            );
            let config = agents.configuration(ctx, &acting)?.unwrap();
            let scope = AgentScope {
                id: &acting,
                configuration: &config,
                settings: &json!({}),
            };
            owner.settled_detail(ctx, &scope, "aborted", "aborted", None)?;
            assert_eq!(
                owner.get(ctx, &acting, "drain-question")?.unwrap()["reason"],
                "The agent run was aborted."
            );
            Ok(())
        })
        .await
        .unwrap();
    graph.close().await;
}

async fn question_provider() -> (
    String,
    tokio::sync::mpsc::Receiver<Value>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    let server = tokio::spawn(async move {
        for round in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 16384);
                if bytes.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let headers = String::from_utf8(bytes).unwrap();
            assert!(headers.starts_with("POST /v1/responses "));
            let length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(length < 1024 * 1024);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            sender
                .send(serde_json::from_slice(&body).unwrap())
                .await
                .unwrap();
            let events = if round == 0 {
                let arguments=json!({"context":"The user may answer after a restart.","questions":[{"header":"Release scope","question":"Which product should ship?"}]}).to_string();
                vec![
                    json!({"type":"response.output_item.added","item":{"type":"function_call","id":"provider-item","call_id":"provider-call","name":"request_user_input"}}),
                    json!({"type":"response.function_call_arguments.delta","item_id":"provider-item","delta":arguments}),
                    json!({"type":"response.function_call_arguments.done","arguments":arguments}),
                ]
            } else {
                vec![
                    json!({"type":"response.content_part.added","part":{"type":"output_text"}}),
                    json!({"type":"response.output_text.delta","delta":"The restored answer is received."}),
                    json!({"type":"response.output_text.done"}),
                ]
            };
            let response=events.into_iter().chain(std::iter::once(json!({"type":"response.completed","response":{"id":format!("question-response-{round}"),"output":[],"usage":{}}}))).map(|event|format!("data: {event}\r\n\r\n")).collect::<String>();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    (format!("http://{address}/v1"), receiver, server)
}

#[tokio::test]
async fn a_real_reloadable_question_call_survives_graceful_shutdown_and_rejoins_the_same_request() {
    let (endpoint, mut requests, server) = question_provider().await;
    let graph = Graph::new_with_provider(&endpoint).await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let selection = graph.task_input("Question test");
    let (question_sender, mut questions) = tokio::sync::mpsc::channel(2);
    let observer = graph
        .user_input
        .on_event(Arc::new(move |event| {
            if event["type"] == "user_input_requested" {
                question_sender.try_send(event["request"].clone()).unwrap();
            }
        }))
        .unwrap();
    let agents = graph.agents.clone();
    let acting = agent.clone();
    graph.fixture.runtime.transact(move|ctx|agents.enqueue(ctx,&acting,&json!({"id":cuid2::create_id(),"message":{"role":"agent","author":{"id":acting,"description":"Fixture caller"},"content":[{"type":"text","text":"Ask the person a durable question."}]},"options":{"provider":selection["provider"],"model":selection["model"],"effort":selection["effort"],"permissionMode":"auto"}}),false)).await.unwrap();
    let first = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(
        first["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "request_user_input")
    );
    let pending = tokio::time::timeout(Duration::from_secs(5), questions.recv())
        .await
        .unwrap()
        .unwrap();
    let id = pending["id"].as_str().unwrap().to_owned();
    assert_ne!(id, "provider-call");
    assert_eq!(id.len(), 24);
    assert!(!questions.is_closed());
    drop(observer);
    let graph = tokio::time::timeout(Duration::from_secs(5), graph.restart())
        .await
        .unwrap();
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    let request_id = id.clone();
    let answered = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(owner.get(ctx, &acting, &request_id)?.unwrap(), pending);
            assert_eq!(
                ctx.database().query_row::<u64, _, _>(
                    "SELECT count(*) FROM happy_user_input_requests",
                    [],
                    |row| row.get(0)
                )?,
                1
            );
            owner.answer(
                ctx,
                &acting,
                &json!({"requestId":request_id,"answer":"Release Agent preview."}),
            )
        })
        .await
        .unwrap();
    assert_eq!(answered["status"], "answered");
    let resumed = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(resumed.to_string().contains("Release Agent preview."));
    graph
        .agents
        .wait_for_idle(&agent, &CancellationToken::new())
        .await
        .unwrap();
    let owner = graph.user_input.clone();
    let acting = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(owner.list(ctx, &acting, &json!({}))?.len(), 1);
            Ok(())
        })
        .await
        .unwrap();
    server.await.unwrap();
    graph.close().await;
}

#[tokio::test]
async fn scheduling_intents_and_observers_roll_back_together_and_cancel_only_the_original_sender() {
    use std::sync::atomic::{AtomicBool, Ordering};
    let graph = Graph::new().await;
    let sender = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let observed = Arc::new(Mutex::new(Vec::<Value>::new()));
    let events = observed.clone();
    let _observer = graph
        .scheduling
        .on_event(Arc::new(move |event| {
            events.lock().unwrap().push(event.clone())
        }))
        .unwrap();
    let reject = Arc::new(AtomicBool::new(true));
    let rejecting = reject.clone();
    let _listener = graph
        .scheduling
        .on_event_transactional(Arc::new(move |_, _| {
            anyhow::ensure!(
                !rejecting.load(Ordering::SeqCst),
                "Reject the scheduling transaction."
            );
            Ok(())
        }))
        .unwrap();
    let owner = graph.scheduling.clone();
    let acting = sender.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.schedule(
                ctx,
                &acting,
                &json!({"id":"originalschedule","message":"An original reminder","in":"1 hour"}),
            )
        })
        .await
        .unwrap_err();
    assert!(observed.lock().unwrap().is_empty());
    reject.store(false, Ordering::SeqCst);
    let owner = graph.scheduling.clone();
    let acting = sender.clone();
    let schedule=graph.fixture.runtime.transact(move|ctx|{assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_scheduling_schedules",[],|row|row.get(0))?,0);let first=owner.schedule(ctx,&acting,&json!({"id":"originalschedule","message":"An original reminder","in":"1 hour"}))?;assert_eq!(owner.schedule(ctx,&acting,&json!({"id":"originalschedule","message":"An original reminder","in":"2 hours"}))?,first);assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM durable_function_calls WHERE operation_id='scheduling.deliver.originalschedule'",[],|row|row.get(0))?,1);Ok(first)}).await.unwrap();
    assert_eq!(schedule["status"], "pending");
    assert_eq!(observed.lock().unwrap().len(), 1);
    let owner = graph.scheduling.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.cancel_schedule(
                ctx,
                "unrelatedagent",
                &json!({"scheduleId":"originalschedule"}),
            )
        })
        .await
        .unwrap_err();
    let owner = graph.scheduling.clone();
    let acting = sender.clone();
    graph.fixture.runtime.transact(move|ctx|{let cancelled=owner.cancel_schedule(ctx,&acting,&json!({"scheduleId":"originalschedule"}))?;assert_eq!(cancelled["status"],"cancelled");assert_eq!(owner.cancel_schedule(ctx,&acting,&json!({"scheduleId":"originalschedule"}))?,cancelled);assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM durable_function_calls WHERE operation_id='scheduling.deliver.originalschedule'",[],|row|row.get(0))?,0);Ok(())}).await.unwrap();
    assert_eq!(observed.lock().unwrap().len(), 2);
    graph.close().await;
}

#[tokio::test]
async fn scheduling_waits_return_actual_elapsed_time_and_incoming_messages_interrupt_them() {
    let graph = Graph::new().await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let immediate = graph
        .scheduling
        .wait(
            &agent,
            &json!({"id":"immediatewait","duration":"0 seconds"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(immediate["outcome"], "elapsed");
    assert_eq!(
        immediate["elapsedMs"].as_u64().unwrap(),
        immediate["endedAt"].as_u64().unwrap() - immediate["startedAt"].as_u64().unwrap()
    );
    let id = agent.clone();
    let owner = graph.scheduling.clone();
    let waiting = tokio::spawn(async move {
        owner
            .wait(
                &id,
                &json!({"id":"interruptedwait","duration":"1 hour"}),
                &CancellationToken::new(),
            )
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if graph.scheduling.suspension_count() > 0 {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    graph.scheduling.interrupt_waits(&agent).unwrap();
    let finished = tokio::time::timeout(Duration::from_secs(5), waiting)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(finished["outcome"], "interrupted");
    assert!(finished["endedAt"].as_u64().unwrap() < finished["dueAt"].as_u64().unwrap());
    assert_eq!(
        graph
            .scheduling
            .wait(
                &agent,
                &json!({"id":"interruptedwait","duration":"3 hours"}),
                &CancellationToken::new()
            )
            .await
            .unwrap(),
        finished
    );
    let agents = graph.agents.clone();
    let child = cuid2::create_id();
    let descendant = child.clone();
    let parent = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            agents.create_from(ctx, &descendant, &json!({"metadata":{}}), Some(&parent))?;
            agents.set_parent(ctx, &descendant, &parent)
        })
        .await
        .unwrap();
    let configuration = graph.agent_config(&child).await;
    let tools = graph
        .scheduling
        .available_tools(&AgentScope {
            id: &child,
            configuration: &configuration,
            settings: &json!({}),
        })
        .await
        .unwrap();
    assert_eq!(
        tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["wait", "wait_until"]
    );
    graph.close().await;
}

#[tokio::test]
async fn scheduling_records_an_actual_missing_recipient_as_undelivered_without_retrying_it() {
    let graph = Graph::new().await;
    let sender = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = graph.scheduling.clone();
    let acting = sender.clone();
    graph.fixture.runtime.transact(move|ctx|owner.schedule(ctx,&acting,&json!({"id":"missingrecipient","targetAgentId":"notcreatedagent","message":"A delayed message","in":"0 seconds"}))).await.unwrap();
    graph.fixture.durable.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let owner = graph.scheduling.clone();
            let acting = sender.clone();
            let schedule = graph
                .fixture
                .runtime
                .transact(move |ctx| owner.get_schedule(ctx, &acting, "missingrecipient"))
                .await
                .unwrap()
                .unwrap();
            if schedule["status"] != "pending" {
                assert_eq!(schedule["status"], "undelivered");
                assert!(
                    schedule["failure"]
                        .as_str()
                        .unwrap()
                        .contains("does not exist")
                );
                assert!(schedule.get("deliveredAt").is_none());
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    graph.close().await;
}

#[tokio::test]
async fn scheduled_delivery_recovers_after_restart_with_original_identity_and_untrusted_agent_provenance()
 {
    let (endpoint, mut requests, server) =
        naming_provider(vec!["The scheduled message arrived."]).await;
    let graph = Graph::new_with_provider(&endpoint).await;
    let sender = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = graph.scheduling.clone();
    let acting = sender.clone();
    let scheduled=graph.fixture.runtime.transact(move|ctx|owner.schedule(ctx,&acting,&json!({"id":"restoredschedule","message":"Send exactly this reminder","in":"1 second"}))).await.unwrap();
    let graph = graph.restart().await;
    graph.fixture.durable.start().await.unwrap();
    let request = tokio::time::timeout(Duration::from_secs(5), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(provider_input_texts(&request).iter().any(|text| {
        text.contains("A message you scheduled for now:\n\nSend exactly this reminder")
    }));
    graph
        .agents
        .wait_for_idle(&sender, &CancellationToken::new())
        .await
        .unwrap();
    let messages = graph
        .history
        .messages(sender.clone(), None, None, 50, false)
        .await
        .unwrap();
    let delivered = &messages["runs"][0]["messages"][0];
    assert_eq!(delivered["id"], scheduled["id"]);
    assert_eq!(delivered["role"], "agent");
    assert_eq!(delivered["metadata"]["senderAgentId"], sender);
    assert!(delivered["metadata"]["userId"].is_null());
    let owner = graph.scheduling.clone();
    let acting = sender.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let delivered = owner
                .get_schedule(ctx, &acting, "restoredschedule")?
                .unwrap();
            assert_eq!(delivered["status"], "delivered");
            assert!(
                delivered["deliveredAt"].as_u64().unwrap() >= delivered["dueAt"].as_u64().unwrap()
            );
            assert_eq!(
                owner.cancel_schedule(ctx, &acting, &json!({"scheduleId":"restoredschedule"}))?,
                delivered
            );
            Ok(())
        })
        .await
        .unwrap();
    assert!(requests.try_recv().is_err());
    server.await.unwrap();
    graph.close().await;
}

#[tokio::test]
async fn subtasks_use_real_ancestry_and_refuse_a_third_level_or_hidden_intermediary() {
    let graph = Graph::new().await;
    let chief = graph.list().await.remove(0)["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = cuid2::create_id();
    let second = cuid2::create_id();
    let third = cuid2::create_id();
    graph
        .subtask(&chief, graph.task_input("First task"), &first, None)
        .await
        .unwrap();
    graph
        .subtask(&first, graph.task_input("Second task"), &second, None)
        .await
        .unwrap();
    let rejected = graph
        .subtask(&second, graph.task_input("Third task"), &third, None)
        .await;
    assert!(rejected.unwrap_err().to_string().contains("two levels"));
    let children = graph.agents.clone();
    let parent = chief.clone();
    let first_again = first.clone();
    assert_eq!(
        graph
            .fixture
            .runtime
            .transact(move |ctx| children.parent(ctx, &first_again))
            .await
            .unwrap(),
        Some(parent)
    );
    let retry = graph
        .subtask(
            &chief,
            graph.task_input("Changed retry title"),
            &first,
            None,
        )
        .await
        .unwrap();
    assert_eq!(retry, json!({"agentId":first}));
    assert_eq!(
        graph.agent_config(&first).await["metadata"]["title"],
        "First task"
    );
    let hidden = cuid2::create_id();
    let agents = graph.agents.clone();
    let child = hidden.clone();
    let parent = chief.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            agents.create_from(ctx, &child, &json!({"metadata":{}}), Some(&parent))?;
            agents.set_parent(ctx, &child, &parent)
        })
        .await
        .unwrap();
    assert!(
        graph
            .subtask(&hidden, graph.task_input("Hidden extension"), &third, None)
            .await
            .unwrap_err()
            .to_string()
            .contains("Only a bot")
    );
    graph.close().await;
}

#[tokio::test]
async fn workspace_subtask_archival_is_atomic_bidirectional_and_final() {
    let graph = Graph::new().await;
    let chief = graph.list().await.remove(0)["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let project = graph.project().await;
    let task = cuid2::create_id();
    let workspace = cuid2::create_id();
    let mut input = graph.task_input("Bound task");
    input["workspace"] = json!({"projectId":project["id"],"name":"Résumé editor"});
    graph
        .subtask(&chief, input, &task, Some(&workspace))
        .await
        .unwrap();
    let config = graph.agent_config(&task).await;
    assert_eq!(config["metadata"]["subtaskWorkspaceId"], workspace);
    assert_eq!(config["provenance"]["createdBy"], chief);
    let module = graph.workspaces.clone();
    let id = workspace.clone();
    let stored = graph
        .fixture
        .runtime
        .transact(move |ctx| module.get(ctx, &id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored["storageKey"], "resume-editor");
    assert_eq!(stored["subtaskAgentId"], task);
    assert_eq!(stored["status"], "initializing");
    assert_eq!(config["modules"]["compute"]["cwd"], stored["path"]);
    assert!(!Path::new(stored["path"].as_str().unwrap()).exists());
    let module = graph.workspaces.clone();
    let id = workspace.clone();
    let rollback = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            module.begin_archive(ctx, &id)?;
            anyhow::bail!("Roll back the whole archival decision.");
            #[allow(unreachable_code)]
            Ok(())
        })
        .await;
    assert!(rollback.is_err());
    assert!(
        graph.agent_config(&task).await["metadata"]
            .get("archivedAt")
            .is_none()
    );
    let module = graph.workspaces.clone();
    let id = workspace.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| module.begin_archive(ctx, &id))
        .await
        .unwrap();
    let config = graph.agent_config(&task).await;
    assert!(config["metadata"]["archivedAt"].is_number());
    let before = config.clone();
    let agents = graph.agents.clone();
    let id = task.clone();
    let restore = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            agents.update_metadata(
                ctx,
                &id,
                &json!({"archivedAt":null,"title":"Invalid restoration"}),
            )
        })
        .await;
    assert!(
        restore
            .unwrap_err()
            .to_string()
            .contains("cannot be restored")
    );
    assert_eq!(graph.agent_config(&task).await, before);
    let pending = graph.fixture.pending().await.unwrap();
    assert!(
        !pending
            .iter()
            .any(|call| call["operationId"] == format!("subtask-start:{task}"))
    );
    assert!(
        pending
            .iter()
            .any(|call| call["function"] == "subtasks.archive"
                && call["arguments"]["agentId"] == task)
    );
    assert!(pending.iter().any(
        |call| call["function"] == "workspaces.archive" && call["arguments"]["id"] == workspace
    ));
    graph.close().await;
}

#[tokio::test]
async fn shared_folder_subtask_archive_preserves_workspace_and_marks_only_target() {
    let graph = Graph::new().await;
    let chief = graph.list().await.remove(0)["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let first = cuid2::create_id();
    let second = cuid2::create_id();
    graph
        .subtask(&chief, graph.task_input("Shared task"), &first, None)
        .await
        .unwrap();
    graph
        .subtask(&first, graph.task_input("Shared descendant"), &second, None)
        .await
        .unwrap();
    let owner = graph.subtasks.clone();
    let actor = chief.clone();
    let id = first.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.archive(ctx, &actor, &id))
        .await
        .unwrap();
    assert!(graph.agent_config(&first).await["metadata"]["archivedAt"].is_number());
    assert!(
        graph.agent_config(&second).await["metadata"]
            .get("archivedAt")
            .is_none()
    );
    let pending = graph.fixture.pending().await.unwrap();
    assert!(
        !pending
            .iter()
            .any(|call| call["function"] == "workspaces.archive")
    );
    assert!(Path::new(graph.list().await.remove(0)["path"].as_str().unwrap()).is_dir());
    graph.close().await;
}

#[tokio::test]
async fn subtask_reorder_repairs_ties_and_persists_parent_order_in_same_transaction() {
    let graph = Graph::new().await;
    let chief = graph.list().await.remove(0)["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let ids = (0..3).map(|_| cuid2::create_id()).collect::<Vec<_>>();
    for id in &ids {
        graph
            .subtask(&chief, graph.task_input("Ordered task"), id, None)
            .await
            .unwrap();
        let agents = graph.agents.clone();
        let id = id.clone();
        graph
            .fixture
            .runtime
            .transact(move |ctx| {
                agents.update_metadata(ctx, &id, &json!({"subtaskOrderKey":"500"}))
            })
            .await
            .unwrap();
    }
    let mut before = ids.clone();
    before.sort();
    let target = before[0].clone();
    let after = before[2].clone();
    let owner = graph.subtasks.clone();
    let id = target.clone();
    let after_id = after.clone();
    assert!(
        graph
            .fixture
            .runtime
            .transact(move |ctx| owner.reorder(ctx, &id, Some(&after_id)))
            .await
            .unwrap()
    );
    let mut configs = Vec::new();
    for id in &ids {
        configs.push((id.clone(), graph.agent_config(id).await));
    }
    let sorted = graph
        .subtasks
        .sort_siblings(configs)
        .unwrap()
        .into_iter()
        .map(|(id, _)| id)
        .collect::<Vec<_>>();
    assert_eq!(sorted, vec![before[1].clone(), after, target]);
    assert!(graph.agent_config(&chief).await["metadata"]["subtasksOrderedAt"].is_number());
    graph.close().await;
}

#[tokio::test]
async fn before_loop_waits_for_actual_workspace_readiness_and_releases_on_abort() {
    let graph = Graph::new().await;
    let chief = graph.list().await.remove(0)["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let project = graph.project().await;
    let task = cuid2::create_id();
    let workspace = cuid2::create_id();
    let mut input = graph.task_input("Wait for folder");
    input["workspace"] = json!({"projectId":project["id"],"name":"Still preparing"});
    graph
        .subtask(&chief, input, &task, Some(&workspace))
        .await
        .unwrap();
    let config = graph.agent_config(&task).await;
    let cancellation = CancellationToken::new();
    let waiting = graph.subtasks.clone();
    let task_id = task.clone();
    let signal = cancellation.clone();
    let (started, active) = tokio::sync::oneshot::channel();
    let worker = tokio::spawn(async move {
        let _ = started.send(());
        waiting
            .before_loop(
                &AgentScope {
                    id: &task_id,
                    configuration: &config,
                    settings: &json!({}),
                },
                signal,
            )
            .await
    });
    active.await.unwrap();
    tokio::task::yield_now().await;
    assert!(!worker.is_finished());
    cancellation.cancel();
    assert!(worker.await.unwrap().is_err());
    assert!(
        graph.agent_config(&task).await["metadata"]
            .get("archivedAt")
            .is_none()
    );
    graph.close().await;
}

#[tokio::test]
async fn bot_folder_failure_rolls_back_agent_catalog_and_all_publication() {
    let graph = Graph::new().await;
    let before = graph.list().await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let capture = events.clone();
    let _subscription = graph
        .bots
        .on_event(Arc::new(move |event| capture.lock().unwrap().push(event)))
        .unwrap();
    let id = cuid2::create_id();
    let workspace = cuid2::create_id();
    let agent = cuid2::create_id();
    let path = graph.fixture.config.bot_path("blocked").unwrap();
    std::fs::write(&path, b"ordinary file").unwrap();
    let cursor = graph.fixture.events.cursor();
    let owner = graph.bots.clone();
    let bot_id = id.clone();
    let workspace_id = workspace.clone();
    let agent_id = agent.clone();
    let failed=graph.fixture.runtime.transact(move|ctx|owner.create(ctx,&json!({"id":bot_id,"workspaceId":workspace_id,"agentId":agent_id,"username":"blocked"}))).await;
    assert!(failed.is_err());
    assert_eq!(graph.list().await, before);
    assert_eq!(graph.fixture.events.cursor(), cursor);
    assert!(events.lock().unwrap().is_empty());
    let agents = graph.agents.clone();
    let check = agent.clone();
    assert!(
        graph
            .fixture
            .runtime
            .transact(move |ctx| agents.configuration(ctx, &check))
            .await
            .unwrap()
            .is_none()
    );
    std::fs::remove_file(path).unwrap();
    let created = graph
        .create(json!({"id":id,"workspaceId":workspace,"agentId":agent,"username":"blocked"}))
        .await;
    assert_eq!(created["created"], true);
    assert_eq!(events.lock().unwrap().len(), 1);
    assert_eq!(created["bot"]["id"], id);
    assert_eq!(created["bot"]["workspaceId"], workspace);
    assert_eq!(created["bot"]["agentId"], agent);
    assert!(Path::new(created["bot"]["path"].as_str().unwrap()).is_dir());
    assert_eq!(created["bot"]["name"], "New Bot");
    assert_eq!(created["bot"]["nameConfigured"], false);
    let agents = graph.agents.clone();
    let check = agent.clone();
    assert!(
        graph
            .fixture
            .runtime
            .transact(move |ctx| agents.parent(ctx, &check))
            .await
            .unwrap()
            .is_none()
    );
    let retry = graph
        .create(json!({"id":id,"name":"Ignored retry name"}))
        .await;
    assert_eq!(retry["created"], false);
    assert_eq!(retry["bot"], created["bot"]);
    assert_eq!(events.lock().unwrap().len(), 1);
    graph.close().await;
}

#[tokio::test]
async fn chief_seed_identity_avatar_and_archival_survive_restart_and_deleted_catalog_row() {
    let graph = Graph::new().await;
    let bots = graph.list().await;
    assert_eq!(bots.len(), 1);
    let chief = bots[0].clone();
    assert_eq!(chief["systemKey"], "chief_of_staff");
    assert_eq!(chief["isAdmin"], true);
    assert_eq!(chief["nameConfigured"], true);
    assert_eq!(chief["avatar"]["source"], "generated");
    let owner = graph.bots.clone();
    let id = chief["id"].as_str().unwrap().to_owned();
    let saved = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.avatar(ctx, &id))
        .await
        .unwrap()
        .unwrap();
    assert!(saved.0.starts_with(b"RIFF"));
    let owner = graph.bots.clone();
    let id = chief["id"].as_str().unwrap().to_owned();
    let archived = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.archive(ctx, &id, 1))
        .await
        .unwrap();
    assert_eq!(archived["status"], "archived");
    assert_eq!(archived["workspaceVersion"], 2);
    assert!(Path::new(archived["path"].as_str().unwrap()).is_dir());
    let graph = graph.restart().await;
    assert_eq!(graph.list().await, vec![archived.clone()]);
    let owner = graph.bots.clone();
    let id = chief["id"].as_str().unwrap().to_owned();
    assert_eq!(
        graph
            .fixture
            .runtime
            .transact(move |ctx| owner.avatar(ctx, &id))
            .await
            .unwrap()
            .unwrap(),
        saved
    );
    let id = chief["id"].as_str().unwrap().to_owned();
    graph
        .fixture
        .runtime
        .transact(move |ctx| persistence::delete_test_bot(ctx, &id))
        .await
        .unwrap();
    let graph = graph.restart().await;
    assert!(graph.list().await.is_empty());
    graph.close().await;
}

#[tokio::test]
async fn explicit_bot_rename_and_agent_metadata_commit_or_roll_back_together() {
    let graph = Graph::new().await;
    let bot = graph.create(json!({"username":"rename_me"})).await["bot"].clone();
    let owner = graph.bots.clone();
    let id = bot["id"].as_str().unwrap().to_owned();
    let failure: Result<()> = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.rename(ctx, &id, "New Bot", 1)?;
            anyhow::bail!("Deliberate rename rollback.")
        })
        .await;
    assert!(failure.is_err());
    let owner = graph.bots.clone();
    let id = bot["id"].as_str().unwrap().to_owned();
    assert_eq!(
        graph
            .fixture
            .runtime
            .transact(move |ctx| owner.get(ctx, &id))
            .await
            .unwrap()
            .unwrap(),
        bot
    );
    let owner = graph.bots.clone();
    let id = bot["id"].as_str().unwrap().to_owned();
    let renamed = graph
        .fixture
        .runtime
        .transact(move |ctx| owner.rename(ctx, &id, "New Bot", 1))
        .await
        .unwrap();
    assert_eq!(renamed["nameConfigured"], true);
    assert_eq!(renamed["workspaceVersion"], bot["workspaceVersion"]);
    assert_eq!(renamed["path"], bot["path"]);
    assert_eq!(renamed["username"], bot["username"]);
    let agents = graph.agents.clone();
    let id = bot["agentId"].as_str().unwrap().to_owned();
    let configuration = graph
        .fixture
        .runtime
        .transact(move |ctx| agents.configuration(ctx, &id))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(configuration["metadata"]["title"], "New Bot");
    assert_eq!(configuration["metadata"]["version"], 2);
    graph.close().await;
}

#[tokio::test]
async fn original_first_message_attempt_key_is_preserved_and_is_transactional() {
    let graph = Graph::new().await;
    let bot = graph.create(json!({"username":"original_attempt"})).await["bot"].clone();
    let owner = graph.bots.clone();
    let id = bot["agentId"].as_str().unwrap().to_owned();
    let key = format!("kv.{id}.module.bots.bot-name-attempted");
    let saved = json!({"at":123});
    let expected = saved.clone();
    let marker = key.clone();
    let bot_id = id.clone();
    graph.fixture.runtime.transact(move|ctx|{ctx.put_value(&bot_id,&marker,&saved)?;let configuration=owner.agents.configuration(ctx,&bot_id)?.unwrap();owner.accepted(ctx,&AgentScope{id:&bot_id,configuration:&configuration,settings:&json!({})},&[AcceptedInput{input:json!({"message":{"role":"user","content":[{"type":"text","text":"Please coordinate releases"}]}}),requested_call:None}],false)?;assert_eq!(ctx.value(&bot_id,&marker)?.unwrap(),expected);Ok(())}).await.unwrap();
    assert!(graph.bots.naming.lock().unwrap().is_empty());
    graph.close().await;
}

#[tokio::test]
async fn task_dependencies_and_events_commit_together_and_survive_restart() {
    let graph = Graph::new().await;
    let events = Arc::new(Mutex::new(Vec::new()));
    let captured = events.clone();
    let _subscription = graph
        .tasks
        .on_event(Arc::new(move |event| {
            captured.lock().unwrap().push(event.clone())
        }))
        .unwrap();
    let owner = graph.tasks.clone();
    graph.fixture.runtime.transact(move |ctx| {
        owner.create(ctx, "task-owner", &json!({"id":"first","title":"  Build  ","metadata":{"nested":{"before":1,"after":2},"clear":true}}))?;
        owner.create(ctx, "task-owner", &json!({"id":"second","title":"Publish","dependsOn":["first"]}))?;
        assert_eq!(owner.get(ctx,"task-owner","first")?.unwrap()["blocks"],json!(["second"]));
        Ok(())
    }).await.unwrap();
    assert_eq!(events.lock().unwrap().len(), 2);
    let owner = graph.tasks.clone();
    let failed: Result<()> = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.update(
                ctx,
                "task-owner",
                "first",
                &json!({"metadata":{"clear":null}}),
            )?;
            owner.remove(ctx, "task-owner", "second")?;
            anyhow::bail!("Deliberate task rollback.")
        })
        .await;
    assert!(failed.is_err());
    assert_eq!(events.lock().unwrap().len(), 2);
    let guard = graph
        .tasks
        .on_event_transactional(Arc::new(|_, _| anyhow::bail!("Reject the task change.")))
        .unwrap();
    let owner = graph.tasks.clone();
    assert!(
        graph
            .fixture
            .runtime
            .transact(move |ctx| owner.complete(ctx, "task-owner", "first"))
            .await
            .is_err()
    );
    assert_eq!(events.lock().unwrap().len(), 2);
    drop(guard);
    let owner = graph.tasks.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert!(
                owner
                    .update(ctx, "task-owner", "first", &json!({"dependsOn":["second"]}))
                    .is_err()
            );
            assert_eq!(owner.list(ctx, "task-owner")?[0]["dependsOn"], json!([]));
            let patch: Value = serde_json::from_str(
                r#"{"metadata":{"nested":{"after":2,"before":1},"clear":null}}"#,
            )?;
            owner.update(ctx, "task-owner", "first", &patch)?;
            let task = owner.get(ctx, "task-owner", "first")?.unwrap();
            assert!(task["metadata"].get("clear").is_none());
            assert_eq!(
                task["metadata"]["nested"].to_string(),
                r#"{"after":2,"before":1}"#
            );
            Ok(())
        })
        .await
        .unwrap();
    assert_eq!(events.lock().unwrap().len(), 3);
    let graph = graph.restart().await;
    let owner = graph.tasks.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let tasks = owner.list(ctx, "task-owner")?;
            assert_eq!(tasks.len(), 2);
            assert_eq!(tasks[0]["title"], "Build");
            assert_eq!(tasks[0]["blocks"], json!(["second"]));
            assert_eq!(tasks[1]["dependsOn"], json!(["first"]));
            assert!(owner.list(ctx, "another-owner")?.is_empty());
            let stored: String = ctx.database().query_row(
                "SELECT tasks_json FROM happy_agent_task_state WHERE agent_id='task-owner'",
                [],
                |row| row.get(0),
            )?;
            assert_eq!(serde_json::from_str::<Value>(&stored)?, json!(tasks));
            Ok(())
        })
        .await
        .unwrap();
    graph.close().await;
}

#[tokio::test]
async fn task_reverse_links_reorder_completion_and_paging_follow_the_original_store() {
    let graph = Graph::new().await;
    let owner = graph.tasks.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            for id in ["first", "second", "third"] {
                owner.create(
                    ctx,
                    "tasks",
                    &json!({"id":id,"title":id,"detail":"😀".repeat(900)}),
                )?;
            }
            owner.update(
                ctx,
                "tasks",
                "first",
                &json!({"addBlocks":["third","second"]}),
            )?;
            assert_eq!(
                owner.get(ctx, "tasks", "first")?.unwrap()["blocks"],
                json!(["second", "third"])
            );
            owner.reorder(ctx, "tasks", &json!(["third", "first", "second"]))?;
            assert_eq!(
                owner.get(ctx, "tasks", "first")?.unwrap()["blocks"],
                json!(["third", "second"])
            );
            owner.complete(ctx, "tasks", "first")?;
            let page = owner.list_page(ctx, "tasks", &json!({"limit":1}))?;
            assert_eq!(page["tasks"][0]["id"], "third");
            assert_eq!(page["tasks"][0]["dependsOn"], json!([]));
            assert_eq!(page["nextOffset"], 1);
            assert_eq!(
                owner.get(ctx, "tasks", "third")?.unwrap()["dependsOn"],
                json!(["first"])
            );
            let detail = owner.get_page(
                ctx,
                "tasks",
                "third",
                &json!({"detailOffset":4,"detailLimit":6}),
            )?;
            assert_eq!(detail["detail"], "😀😀😀");
            assert_eq!(detail["detailTotal"], 1800);
            assert_eq!(detail["nextDetailOffset"], 10);
            assert_eq!(detail["dependencies"], json!(["first"]));
            assert_eq!(detail["task"]["detail"].as_str().unwrap().len(), 3600);
            assert!(owner.remove(ctx, "tasks", "first")?);
            let tasks = owner.list(ctx, "tasks")?;
            assert_eq!(
                tasks
                    .iter()
                    .map(|task| task["ordering"].as_u64().unwrap())
                    .collect::<Vec<_>>(),
                vec![0, 1]
            );
            assert!(tasks.iter().all(|task| task["dependsOn"] == json!([])));
            assert!(!owner.remove(ctx, "tasks", "first")?);
            assert_eq!(owner.reset(ctx, "tasks")?, 2);
            assert_eq!(owner.reset(ctx, "tasks")?, 0);
            Ok(())
        })
        .await
        .unwrap();
    graph.close().await;
}

#[tokio::test]
async fn transactional_task_tools_keep_original_call_identity_and_return_domain_errors_as_normal_results()
 {
    let graph = Graph::new().await;
    let owner = graph.tasks.clone();
    graph.fixture.runtime.transact(move |ctx| {
        let scope=AgentScope{id:"tool-owner",configuration:&json!({}),settings:&json!({})};
        let call=json!({"id":"stable-task-call","call":{"name":"create_task","arguments":"{\"title\":\"Build\"}"}});
        let result=owner.execute_transactional_tool(ctx,&scope,&call).unwrap()?;
        assert!(matches!(result,happy_providers::Message::Tool{is_error:false,..}));
        assert_eq!(owner.list(ctx,"tool-owner")?[0]["id"],"stable-task-call");
        let repeat=owner.execute_transactional_tool(ctx,&scope,&call).unwrap()?;
        let happy_providers::Message::Tool{is_error,content,..}=repeat else {panic!("Task mutations must return a tool message.")};
        assert!(!is_error);
        assert!(matches!(&content[0],happy_providers::Block::Text{text,..} if text=="Task stable-task-call could not be created: Task \"stable-task-call\" already exists."));
        let delete=json!({"id":"delete-call","call":{"name":"update_task","arguments":"{\"id\":\"stable-task-call\",\"status\":\"deleted\"}"}});
        let happy_providers::Message::Tool{is_error,content,..}=owner.execute_transactional_tool(ctx,&scope,&delete).unwrap()? else {panic!("Task deletion must return a tool message.")};
        assert!(!is_error);
        assert!(matches!(&content[0],happy_providers::Block::Text{text,..} if text=="Task removed: stable-task-call"));
        assert!(owner.list(ctx,"tool-owner")?.is_empty());
        Ok(())
    }).await.unwrap();
    graph.close().await;
}

#[tokio::test]
async fn goal_lifecycle_retries_rollback_and_inactive_sidecars_match_the_original_state() {
    let graph = Graph::new().await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let capture = seen.clone();
    let _subscription = graph
        .goal
        .on_event(Arc::new(move |event| {
            capture.lock().unwrap().push(event.clone())
        }))
        .unwrap();
    let owner = graph.goal.clone();
    let acting = agent.clone();
    graph.fixture.runtime.transact(move|ctx|{
        let scope=AgentScope{id:&acting,configuration:&json!({}),settings:&json!({})};
        let call=json!({"id":"original-call","call":{"name":"create_goal","arguments":"{\"objective\":\"  Verify the complete release  \"}"}});
        owner.execute_transactional_tool(ctx,&scope,&call).unwrap()?;
        owner.execute_transactional_tool(ctx,&scope,&call).unwrap()?;
        let lifecycle:String=ctx.database().query_row("SELECT value_json FROM happy_agent_goal_state WHERE agent_id=?1 AND state_key='lifecycle'",[&acting],|row|row.get(0))?;
        assert_eq!(serde_json::from_str::<Value>(&lifecycle)?["id"],"original-call");
        assert_eq!(serde_json::from_str::<Value>(&lifecycle)?["activation"],"agent");
        assert_eq!(ctx.value(&acting,&format!("kv.{acting}.run.module.goal.observedLifecycleId"))?,Some(json!("original-call")));
        assert_eq!(owner.goal(ctx,&acting)?.unwrap()["objective"],"Verify the complete release");
        let conflict=json!({"id":"different-call","call":{"name":"create_goal","arguments":"{\"objective\":\"Another objective\"}"}});
        assert!(owner.execute_transactional_tool(ctx,&scope,&conflict).unwrap().is_err());
        Ok(())
    }).await.unwrap();
    assert_eq!(seen.lock().unwrap().len(), 1);
    let owner = graph.goal.clone();
    let acting = agent.clone();
    let rejected: Result<()> = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.change_goal_status(ctx, &acting, "paused")?;
            anyhow::bail!("Deliberate goal rollback.")
        })
        .await;
    assert!(rejected.is_err());
    assert_eq!(seen.lock().unwrap().len(), 1);
    let owner = graph.goal.clone();
    let acting = agent.clone();
    graph.fixture.runtime.transact(move|ctx|{
        assert_eq!(owner.goal(ctx,&acting)?.unwrap()["status"],"active");
        owner.change_goal_status(ctx,&acting,"paused")?;
        assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_goal_state WHERE agent_id=?1 AND state_key IN ('lifecycle','failureCount')",[&acting],|row|row.get(0))?,0);
        owner.change_goal_status(ctx,&acting,"complete")?;
        assert!(owner.change_goal_status(ctx,&acting,"active").is_err());
        Ok(())
    }).await.unwrap();
    let graph = graph.restart().await;
    let owner = graph.goal.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(owner.goal(ctx, &agent)?.unwrap()["status"], "complete");
            assert!(owner.clear_goal(ctx, &agent)?);
            assert!(!owner.clear_goal(ctx, &agent)?);
            assert!(owner.goal(ctx, &agent)?.is_none());
            Ok(())
        })
        .await
        .unwrap();
    graph.close().await;
}

async fn goal_provider() -> (
    String,
    tokio::sync::mpsc::Receiver<Value>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = tokio::sync::mpsc::channel(4);
    let server = tokio::spawn(async move {
        for round in 0..4 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                bytes.push(byte[0]);
                assert!(bytes.len() < 16384);
                if bytes.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let headers = String::from_utf8(bytes).unwrap();
            assert!(headers.starts_with("POST /v1/responses "));
            let length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(length < 1024 * 1024);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            sender
                .send(serde_json::from_slice(&body).unwrap())
                .await
                .unwrap();
            let events = if round == 0 || round == 2 {
                let (name, arguments) = if round == 0 {
                    (
                        "create_goal",
                        json!({"objective":"Verify all release artifacts & <requirements>"}),
                    )
                } else {
                    ("update_goal", json!({"status":"complete"}))
                };
                let arguments = arguments.to_string();
                vec![
                    json!({"type":"response.output_item.added","item":{"type":"function_call","id":format!("item-{round}"),"call_id":format!("vendor-{round}"),"name":name}}),
                    json!({"type":"response.function_call_arguments.delta","item_id":format!("item-{round}"),"delta":arguments}),
                    json!({"type":"response.function_call_arguments.done","arguments":arguments}),
                ]
            } else {
                vec![
                    json!({"type":"response.content_part.added","part":{"type":"output_text"}}),
                    json!({"type":"response.output_text.delta","delta":if round==1{"One requirement verified."}else{"The full objective is verified."}}),
                    json!({"type":"response.output_text.done"}),
                ]
            };
            let response=events.into_iter().chain(std::iter::once(json!({"type":"response.completed","response":{"id":format!("goal-response-{round}"),"output":[],"usage":{}}}))).map(|event|format!("data: {event}\r\n\r\n")).collect::<String>();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    (format!("http://{address}/v1"), receiver, server)
}

#[tokio::test]
async fn real_goal_creation_continues_the_same_objective_with_agent_provenance_and_stops_when_complete()
 {
    let (endpoint, mut requests, server) = goal_provider().await;
    let graph = Graph::new_with_provider(&endpoint).await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let selection = graph.task_input("Goal fixture");
    let owner = graph.agents.clone();
    let acting = agent.clone();
    graph.fixture.runtime.transact(move|ctx|owner.enqueue(ctx,&acting,&json!({"id":cuid2::create_id(),"message":{"role":"user","content":[{"type":"text","text":"Pursue a long-running goal and verify every requirement."}]},"options":{"provider":"fixture","model":selection["model"],"effort":selection["effort"],"permissionMode":"auto"},"metadata":{"messageOrigin":"user","userId":"human-fixture"}}),false)).await.unwrap();
    let mut observed = Vec::new();
    for _ in 0..4 {
        observed.push(
            tokio::time::timeout(Duration::from_secs(5), requests.recv())
                .await
                .unwrap()
                .unwrap(),
        );
    }
    assert!(provider_input_texts(&observed[2]).iter().any(|text| {
        text.contains("Continue working toward the active goal.")
            && text.contains("Verify all release artifacts &amp; &lt;requirements&gt;")
    }));
    graph
        .agents
        .wait_for_idle(&agent, &CancellationToken::new())
        .await
        .unwrap();
    assert!(requests.try_recv().is_err());
    let owner = graph.goal.clone();
    let acting = agent.clone();
    graph.fixture.runtime.transact(move|ctx|{assert_eq!(owner.goal(ctx,&acting)?.unwrap()["status"],"complete");assert_eq!(ctx.database().query_row::<i64,_,_>("SELECT count(*) FROM happy_agent_goal_state WHERE agent_id=?1 AND state_key IN ('lifecycle','failureCount')",[&acting],|row|row.get(0))?,0);Ok(())}).await.unwrap();
    let history = graph
        .history
        .messages(agent.clone(), None, None, 50, false)
        .await
        .unwrap();
    let continuations = history["runs"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|run| run["messages"].as_array().unwrap())
        .filter(|message| {
            message["content"].as_array().is_some_and(|blocks| {
                blocks.iter().any(|block| {
                    block["text"].as_str().is_some_and(|text| {
                        text.starts_with("Continue working toward the active goal.")
                    })
                })
            })
        })
        .collect::<Vec<_>>();
    assert_eq!(continuations.len(), 1);
    assert_eq!(continuations[0]["role"], "agent");
    assert_eq!(continuations[0]["metadata"]["senderAgentId"], agent);
    assert!(continuations[0]["metadata"]["userId"].is_null());
    assert!(continuations[0]["id"].as_str().unwrap().starts_with('g'));
    server.await.unwrap();
    graph.close().await;
}

fn provider_input_texts(request: &Value) -> Vec<&str> {
    request["input"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|input| {
            if let Some(text) = input["content"].as_str() {
                vec![text]
            } else {
                input["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|block| block["text"].as_str())
                    .collect()
            }
        })
        .collect()
}

fn workflow_worker() -> std::path::PathBuf {
    let executable = std::env::current_exe().unwrap();
    let worker = executable
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join(if cfg!(windows) {
            "happy-agent.exe"
        } else {
            "happy-agent"
        });
    assert!(
        worker.is_file(),
        "Build the real native Agent executable before exercising Monty subprocess workflows."
    );
    worker
}

async fn restoring_workflow_provider() -> (
    String,
    tokio::sync::mpsc::Receiver<Value>,
    tokio::task::JoinHandle<()>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    let task = tokio::spawn(async move {
        for round in 0..2 {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                headers.push(byte[0]);
                assert!(headers.len() < 16384);
            }
            let headers = String::from_utf8(headers).unwrap();
            let length = headers
                .lines()
                .find_map(|line| {
                    line.split_once(':')
                        .filter(|(key, _)| key.eq_ignore_ascii_case("content-length"))
                        .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(length < 1024 * 1024);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            sender
                .send(serde_json::from_slice(&body).unwrap())
                .await
                .unwrap();
            if round == 0 {
                let mut closed = [0; 1];
                assert_eq!(socket.read(&mut closed).await.unwrap(), 0);
                continue;
            }
            let events = [
                json!({"type":"response.content_part.added","part":{"type":"output_text"}}),
                json!({"type":"response.output_text.delta","delta":"Recovered original call."}),
                json!({"type":"response.output_text.done"}),
                json!({"type":"response.completed","response":{"id":"recovered-workflow-response","output":[],"usage":{}}}),
            ];
            let response = events
                .into_iter()
                .map(|event| format!("data: {event}\r\n\r\n"))
                .collect::<String>();
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",response.len()).as_bytes()).await.unwrap();
            socket.shutdown().await.unwrap();
        }
    });
    (format!("http://{address}/v1"), receiver, task)
}

#[tokio::test]
async fn workflow_restart_restores_its_checkpoint_and_original_pending_collaborator() {
    let (endpoint, mut requests, server) = restoring_workflow_provider().await;
    let graph = workflow_graph(&endpoint).await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let selection = graph.task_input("Restore fixture");
    let options = json!({"model":selection["model"],"provider":"fixture","effort":selection["effort"],"label":"Restore fixture"});
    let script = format!(
        "log('Before collaborator')\nanswer = agent('Preserve this original call', {})\nlog('After collaborator')\nanswer",
        options
    );
    graph.fixture.durable.start().await.unwrap();
    workflow_run(&graph, &agent, "workflow-restore", json!({"script":script})).await;
    tokio::time::timeout(Duration::from_secs(8), requests.recv())
        .await
        .unwrap()
        .unwrap();
    let cancelled_wait = CancellationToken::new();
    cancelled_wait.cancel();
    assert!(
        graph
            .workflows
            .wait(&agent, "workflow-restore", cancelled_wait)
            .await
            .is_err()
    );
    let owner = graph.workflows.clone();
    let acting = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                owner.status(ctx, &acting, "workflow-restore")?.unwrap()["status"],
                "running"
            );
            Ok(())
        })
        .await
        .unwrap();
    let original=graph.fixture.runtime.transact(|ctx|Ok(ctx.database().query_row::<(String,String),_,_>("SELECT collaborator_id,signature FROM happy_agent_module_workflow_agent_calls WHERE run_id='workflow-restore'",[],|row|Ok((row.get(0)?,row.get(1)?)))?)).await.unwrap();
    let graph = graph.restart().await;
    graph.fixture.durable.start().await.unwrap();
    tokio::time::timeout(Duration::from_secs(8), requests.recv())
        .await
        .unwrap()
        .unwrap();
    let run = workflow_finished(&graph, &agent, "workflow-restore").await;
    assert_eq!(run["status"], "completed", "{run}");
    assert_eq!(run["output"], "Recovered original call.");
    assert_eq!(run["agentCount"], 1);
    assert_eq!(
        run["logs"],
        json!(["Before collaborator", "After collaborator"])
    );
    graph.fixture.runtime.transact(move|ctx|{let restored=ctx.database().query_row::<(String,String),_,_>("SELECT collaborator_id,signature FROM happy_agent_module_workflow_agent_calls WHERE run_id='workflow-restore'",[],|row|Ok((row.get(0)?,row.get(1)?)))?;assert_eq!(restored,original);assert_eq!(ctx.database().query_row::<u64,_,_>("SELECT count(*) FROM happy_agent_module_workflow_agent_calls WHERE run_id='workflow-restore'",[],|row|row.get(0))?,1);Ok(())}).await.unwrap();
    server.await.unwrap();
    graph.close().await;
}

#[tokio::test]
async fn workflow_worker_enforces_memory_recursion_and_no_host_filesystem() {
    let graph = workflow_graph("http://127.0.0.1:9/v1").await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    graph.fixture.durable.start().await.unwrap();
    for (id, script, expected) in [
        ("workflow-memory", "'x' * 50_000_000", "MemoryError"),
        (
            "workflow-recursion",
            "def recurse():\n    return recurse()\nrecurse()",
            "RecursionError",
        ),
        (
            "workflow-files",
            "from pathlib import Path\nPath('/etc/passwd').read_text()",
            "unavailable",
        ),
    ] {
        workflow_run(&graph, &agent, id, json!({"script":script})).await;
        let run = workflow_finished(&graph, &agent, id).await;
        assert_eq!(run["status"], "failed", "{run}");
        assert!(run["error"].as_str().unwrap().contains(expected), "{run}");
    }
    graph.close().await;
}
async fn workflow_graph(endpoint: &str) -> Graph {
    Graph::install(Fixture::workflow(workflow_worker(), endpoint).await).await
}
async fn workflow_run(graph: &Graph, agent: &str, id: &str, input: Value) -> Value {
    let owner = graph.workflows.clone();
    let agent = agent.to_owned();
    let id = id.to_owned();
    let script = input["script"].as_str().unwrap().to_owned();
    graph
        .fixture
        .runtime
        .transact(move |ctx| owner.launch_resolved(ctx, &agent, &input, &id, &script))
        .await
        .unwrap()
}
async fn workflow_finished(graph: &Graph, agent: &str, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            let owner = graph.workflows.clone();
            let agent = agent.to_owned();
            let id = id.to_owned();
            let run = graph
                .fixture
                .runtime
                .transact(move |ctx| owner.status(ctx, &agent, &id))
                .await
                .unwrap()
                .unwrap();
            if matches!(
                run["status"].as_str(),
                Some("completed" | "failed" | "cancelled")
            ) {
                return run;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("The real sandboxed workflow reached its terminal state.")
}

#[tokio::test]
async fn workflow_native_worker_checkpoints_progress_and_preserves_original_sql_pages_and_transactions()
 {
    let graph = workflow_graph("http://127.0.0.1:9/v1").await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let owner = graph.workflows.clone();
    let acting = agent.clone();
    let rejected: Result<()> = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            owner.launch_resolved(ctx, &acting, &json!({"script":"1+1"}), "rolled-back", "1+1")?;
            anyhow::bail!("Deliberate caller rollback.")
        })
        .await;
    assert!(rejected.is_err());
    graph.fixture.durable.start().await.unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let observed = events.clone();
    let _subscription = graph
        .workflows
        .on_event(Arc::new(move |event| {
            observed.lock().unwrap().push(event.clone())
        }))
        .unwrap();
    let source = "phase('Review')\nlog('Source note')\nprint('Printed')\n{'ok': args['ok'], 'values': list(range(3))}";
    workflow_run(
        &graph,
        &agent,
        "native-python",
        json!({"script":source,"args":{"ok":true}}),
    )
    .await;
    let finished = workflow_finished(&graph, &agent, "native-python").await;
    assert_eq!(finished["status"], "completed", "{finished}");
    assert_eq!(
        serde_json::from_str::<Value>(finished["output"].as_str().unwrap()).unwrap(),
        json!({"ok":true,"values":[0,1,2]})
    );
    assert_eq!(finished["phase"], "Review");
    assert_eq!(finished["agentCount"], 0);
    assert_eq!(
        finished["logs"],
        json!(["Phase: Review", "Source note", "Printed"])
    );
    let owner = graph.workflows.clone();
    let acting = agent.clone();
    graph.fixture.runtime.transact(move|ctx|{assert!(owner.status(ctx,&acting,"rolled-back")?.is_none());assert!(owner.status(ctx,"another-agent","native-python")?.is_none());assert!(owner.launch_resolved(ctx,&acting,&json!({"script":source}),"native-python",source).is_err());let page=owner.list(ctx,&acting,&json!({"limit":100}))?;assert_eq!(page["totalRuns"],1);let logs=owner.logs(ctx,&acting,&json!({"id":"native-python","limit":1,"from":"end"}))?;assert_eq!(logs["cursor"],2);assert_eq!(logs["lines"][0]["text"],"Printed");assert_eq!(logs["previousCursor"],1);assert_eq!(ctx.database().query_row::<u64,_,_>("SELECT next_call_index FROM happy_agent_module_workflow_checkpoints WHERE run_id='native-python'",[],|row|row.get(0))?,0);assert_eq!(ctx.database().query_row::<u64,_,_>("SELECT count(*) FROM happy_agent_module_workflow_launches WHERE run_id='rolled-back'",[],|row|row.get(0))?,0);Ok(())}).await.unwrap();
    assert_eq!(
        events.lock().unwrap().first().unwrap()["type"],
        "workflow_started"
    );
    assert_eq!(
        events.lock().unwrap().last().unwrap()["type"],
        "workflow_finished"
    );
    let graph = graph.restart().await;
    let owner = graph.workflows.clone();
    let acting = agent.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            assert_eq!(
                owner.status(ctx, &acting, "native-python")?.unwrap()["status"],
                "completed"
            );
            assert_eq!(
                owner.logs(ctx, &acting, &json!({"id":"native-python"}))?["totalLines"],
                3
            );
            Ok(())
        })
        .await
        .unwrap();
    graph.close().await;
}

#[tokio::test]
async fn workflow_real_collaborator_answers_are_parsed_durable_and_reused_without_a_second_agent() {
    let (endpoint, mut requests, server) =
        naming_provider(vec!["```json\n{\"ok\":true}\n```"]).await;
    let graph = workflow_graph(&endpoint).await;
    let agent = graph.list().await[0]["agentId"]
        .as_str()
        .unwrap()
        .to_owned();
    let selection = graph.task_input("Workflow fixture");
    let options = json!({"model":selection["model"],"provider":"fixture","effort":selection["effort"],"label":"Review fixture","schema":{"type":"object","required":["ok"],"properties":{"ok":{"type":"boolean"}}}});
    let script = format!("phase('Review')\nagent('Verify the fixture', {})", options);
    graph.fixture.durable.start().await.unwrap();
    workflow_run(&graph, &agent, "workflow-answer", json!({"script":script})).await;
    let request = tokio::time::timeout(Duration::from_secs(8), requests.recv())
        .await
        .unwrap()
        .unwrap();
    assert!(request["input"].as_array().unwrap().iter().any(|input| {
        input["content"].as_array().is_some_and(|blocks| {
            blocks.iter().any(|block| {
                block["text"].as_str().is_some_and(|text| {
                    text.contains(
                        "Verify the fixture\n\nReturn only JSON matching this JSON Schema:",
                    )
                })
            })
        })
    }));
    let original = workflow_finished(&graph, &agent, "workflow-answer").await;
    assert_eq!(original["status"], "completed", "{original}");
    assert_eq!(original["agentCount"], 1);
    assert_eq!(
        serde_json::from_str::<Value>(original["output"].as_str().unwrap()).unwrap(),
        json!({"ok":true})
    );
    workflow_run(
        &graph,
        &agent,
        "workflow-reuse",
        json!({"script":script,"resumeFromRunId":"workflow-answer"}),
    )
    .await;
    let reused = workflow_finished(&graph, &agent, "workflow-reuse").await;
    assert_eq!(reused["status"], "completed", "{reused}");
    assert_eq!(reused["agentCount"], 0);
    assert_eq!(reused["output"], original["output"]);
    assert_eq!(
        reused["logs"],
        json!(["Reused Review fixture from the previous run."])
    );
    assert!(requests.try_recv().is_err());
    let acting = agent.clone();
    graph.fixture.runtime.transact(move|ctx|{let(value,collaborator):(String,String)=ctx.database().query_row("SELECT output_json,collaborator_id FROM happy_agent_module_workflow_agent_calls WHERE agent_id=?1 AND run_id='workflow-answer'",[&acting],|row|Ok((row.get(0)?,row.get(1)?)))?;assert_eq!(serde_json::from_str::<Value>(&value)?,json!({"ok":true}));assert!(!collaborator.starts_with("workflow-answer:"));assert_eq!(ctx.database().query_row::<u64,_,_>("SELECT count(*) FROM happy_agent_module_workflow_agent_calls WHERE collaborator_id=?1",[collaborator],|row|row.get(0))?,1);Ok(())}).await.unwrap();
    let history = graph
        .history
        .messages(agent, None, None, 50, false)
        .await
        .unwrap();
    assert!(
        history["runs"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|run| run["messages"].as_array().unwrap())
            .all(|message| !message["content"]
                .to_string()
                .contains("finished working. Its answer follows"))
    );
    server.await.unwrap();
    graph.close().await;
}

#[tokio::test]
async fn bot_tool_authority_and_original_call_identity_are_checked_transactionally() {
    let graph = Graph::new().await;
    let ordinary = graph.create(json!({"name":"Ordinary"})).await["bot"].clone();
    let actor = ordinary["agentId"].as_str().unwrap().to_owned();
    let call_id = cuid2::create_id();
    let call = json!({"id":call_id,"call":{"name":"create_bot","arguments":"{\"name\":\"Should not exist\"}"}});
    let bots = graph.bots.clone();
    let agent = actor.clone();
    let denied = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let config = bots.agents.configuration(ctx, &agent)?.unwrap();
            bots.execute_transactional_tool(
                ctx,
                &AgentScope {
                    id: &agent,
                    configuration: &config,
                    settings: &json!({}),
                },
                &call,
            )
            .unwrap()
        })
        .await;
    assert!(denied.is_err());
    assert_eq!(graph.list().await.len(), 2);
    let chief = graph
        .list()
        .await
        .into_iter()
        .find(|bot| bot["systemKey"] == "chief_of_staff")
        .unwrap();
    let actor = chief["agentId"].as_str().unwrap().to_owned();
    let existing = graph.create(json!({"name":"Already created"})).await["bot"].clone();
    let bots = graph.bots.clone();
    let expected = existing.clone();
    let call_id = cuid2::create_id();
    let key = format!("kv.{actor}.call.{call_id}.botId");
    let result=graph.fixture.runtime.transact(move|ctx|{ctx.put_value(&actor,&key,&expected["id"])?;let config=bots.agents.configuration(ctx,&actor)?.unwrap();bots.execute_transactional_tool(ctx,&AgentScope{id:&actor,configuration:&config,settings:&json!({})},&json!({"id":call_id,"call":{"name":"create_bot","arguments":"{\"name\":\"Ignored retry\"}"}})).unwrap()}).await.unwrap();
    assert!(matches!(
        result,
        happy_providers::Message::Tool {
            is_error: false,
            ..
        }
    ));
    assert_eq!(graph.list().await.len(), 3);
    assert!(graph.list().await.contains(&existing));
    let policy = graph
        .bots
        .permission_policy(
            &AgentScope {
                id: chief["agentId"].as_str().unwrap(),
                configuration: &json!({}),
                settings: &json!({}),
            },
            &json!({"call":{"name":"list_bots"}}),
        )
        .unwrap()
        .unwrap();
    assert!(!policy.should_review_in_auto_mode);
    assert!(!policy.should_run_in_full_access_in_auto_mode);
    graph.close().await;
}

#[tokio::test]
async fn collaboration_uses_real_ancestry_and_checks_messages_and_interrupts_in_one_transaction() {
    let graph = Graph::new().await;
    let chief = graph.list().await[0].clone();
    let parent = chief["agentId"].as_str().unwrap().to_owned();
    let target = cuid2::create_id();
    let agents = graph.agents.clone();
    let actor = parent.clone();
    let recipient = target.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| {
            let mut config = agents.configuration(ctx, &actor)?.unwrap();
            config["metadata"] = json!({"title":"Independent research"});
            agents.create(ctx, &recipient, &config)
        })
        .await
        .unwrap();
    let actor = parent.clone();
    let recipient = target.clone();
    let collaboration = graph.collaboration.clone();
    let rejected = graph
        .fixture
        .runtime
        .transact(move |ctx| collaboration.interrupt_agent(ctx, &actor, &recipient))
        .await;
    assert!(rejected.is_err());
    let agents = graph.agents.clone();
    let actor = parent.clone();
    let recipient = target.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| agents.set_parent(ctx, &recipient, &actor))
        .await
        .unwrap();
    let collaboration = graph.collaboration.clone();
    let actor = parent.clone();
    let recipient = target.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| collaboration.interrupt_agent(ctx, &actor, &recipient))
        .await
        .unwrap();
    let agents = graph.agents.clone();
    let recipient = target.clone();
    graph
        .fixture
        .runtime
        .transact(move |ctx| agents.update_metadata(ctx, &recipient, &json!({"archivedAt":123})))
        .await
        .unwrap();
    let collaboration = graph.collaboration.clone();
    let actor = parent.clone();
    let recipient = target.clone();
    let message = cuid2::create_id();
    let failed = graph
        .fixture
        .runtime
        .transact(move |ctx| {
            collaboration.send_message(
                ctx,
                &actor,
                &json!({"toAgentId":recipient,"text":"Never deliver to an archived agent"}),
                &message,
            )
        })
        .await;
    assert!(failed.is_err());
    graph.close().await;
}

fn skill_document(root: &std::path::Path, directory: &str, name: &str, description: &str, extra: &str) -> std::path::PathBuf {
    let directory=root.join(directory);std::fs::create_dir_all(&directory).unwrap();let path=directory.join("SKILL.md");
    std::fs::write(&path,format!("---\nname: {name}\ndescription: {description}\n{extra}---\nComplete instructions for {name}.\n")).unwrap();path
}
async fn skill_agent(graph: &Graph, cwd: &std::path::Path) -> (String,Value) {
    let chief=graph.list().await[0]["agentId"].as_str().unwrap().to_owned();let mut config=graph.agent_config(&chief).await;
    config["modules"]["compute"]["cwd"]=json!(cwd);config["metadata"]=json!({"title":"Skills fixture"});let id=cuid2::create_id();let agents=graph.agents.clone();let acting=id.clone();let saved=config.clone();
    graph.fixture.runtime.transact(move|ctx|agents.create(ctx,&acting,&saved)).await.unwrap();(id,config)
}
#[tokio::test]
async fn skills_live_compute_discovery_preserves_root_precedence_availability_and_admin_folder_updates() {
    let graph=Graph::new().await;let project=graph.fixture.directory.path().join("skill-project");let cwd=project.join("nested");std::fs::create_dir_all(&cwd).unwrap();std::fs::write(project.join(".git"),"fixture git marker").unwrap();
    let standard=project.join(".agents/skills");let local=cwd.join(".agents/skills");let shared=skill_document(&local,"deep","shared","Nearest project","");skill_document(&standard,"outer","shared","Outer project","");
    let user=graph.fixture.install("shared","---\nname: shared\ndescription: User installation\n---\nUser body\n");
    let global=graph.fixture.skills.list(json!({})).await.unwrap();let installed=global["skills"].as_array().unwrap().iter().find(|entry|entry["name"]=="shared").unwrap();graph.fixture.skills.set_enabled_current(installed["id"].as_str().unwrap().to_owned(),false,installed["version"].as_str().unwrap().to_owned(),None).await.unwrap();
    skill_document(&standard,".hidden","hidden","Hidden directory","");skill_document(&standard,"node_modules/ignored","ignored","Dependencies","");std::fs::write(standard.join("SKILL.md"),"---\nname: container\ndescription: Root document is not a skill\n---\nbody").unwrap();
    let extra=project.join("extra");skill_document(&extra,"extra","extra","Project configured folder","");skill_document(&extra,"shadow","shared","Configured shadow","");std::fs::write(project.join("happy.toml"),"[skills]\ndirectories = [\"extra\"]\n").unwrap();
    let (id,config)=skill_agent(&graph,&cwd).await;let settings=json!({"permissionMode":"workspace_write"});let scope=AgentScope{id:&id,configuration:&config,settings:&settings};let cancel=CancellationToken::new();
    let listed=graph.skills.list(&scope,&json!({}),&cancel).await.unwrap();assert_eq!(listed["skills"].as_array().unwrap().iter().map(|skill|skill["name"].as_str().unwrap()).collect::<Vec<_>>(),vec!["extra","shared"]);assert_eq!(listed["skills"][1]["location"],json!(shared));
    let read=graph.skills.read(&scope,&json!({"name":"shared"}),&cancel).await.unwrap();assert!(read["content"].as_str().unwrap().contains("Nearest project"));assert_eq!(read["location"],json!(shared));assert!(user.join("SKILL.md").is_file());
    std::fs::write(&shared,"---\nname: shared\ndescription: Edited on disk\n---\nNew complete instructions\n").unwrap();assert!(graph.skills.instructions(&scope).await.unwrap().contains("Edited on disk"));
    let machine=graph.fixture.directory.path().join("machine-skills");skill_document(&machine,"machine","machine","Added live","");let admin=graph.list().await[0]["agentId"].as_str().unwrap().to_owned();assert_eq!(graph.skill_folders.add(&admin,machine.to_str().unwrap()).await.unwrap()["changed"],true);assert_eq!(graph.skill_folders.add(&admin,machine.to_str().unwrap()).await.unwrap()["changed"],false);
    assert_eq!(graph.skills.list(&scope,&json!({"query":"Added live"}),&cancel).await.unwrap()["skills"][0]["name"],"machine");assert!(graph.skill_folders.add(&id,machine.to_str().unwrap()).await.is_err());
    assert_eq!(graph.skill_folders.remove(&admin,machine.to_str().unwrap()).await.unwrap()["changed"],true);assert!(graph.skills.list(&scope,&json!({"query":"machine"}),&cancel).await.unwrap()["skills"].as_array().unwrap().is_empty());
    std::fs::remove_file(&shared).unwrap();assert_eq!(graph.skills.list(&scope,&json!({"query":"shared"}),&cancel).await.unwrap()["skills"][0]["description"],"Outer project");
    graph.close().await;
}
#[tokio::test]
async fn skills_user_only_reads_require_accepted_user_origin_and_run_state_rolls_back() {
    let graph=Graph::new().await;let project=graph.fixture.directory.path().join("reserved-project");std::fs::create_dir_all(&project).unwrap();
    let path=skill_document(&project.join(".agents/skills"),"deploy","deploy","Explicit deployment","disable-model-invocation: true\npermissionMode: full_access\ninvoke: auto\n");
    let (id,config)=skill_agent(&graph,&project).await;let settings=json!({"permissionMode":"workspace_write"});let scope=AgentScope{id:&id,configuration:&config,settings:&settings};let cancel=CancellationToken::new();
    assert!(graph.skills.list(&scope,&json!({}),&cancel).await.unwrap()["skills"].as_array().unwrap().is_empty());assert!(graph.skills.instructions(&scope).await.unwrap().is_empty());
    let call=json!({"id":"original-skill-call","call":{"name":"read_skill","arguments":"{\"name\":\"deploy\"}"}});
    let failed=graph.skills.execute_tool(&scope,&call,cancel.clone()).await.unwrap();assert!(matches!(failed,Message::Tool{is_error:true,..}));
    let module=graph.skills.clone();let acting=id.clone();let saved=config.clone();graph.fixture.runtime.transact(move|ctx|module.accepted(ctx,&AgentScope{id:&acting,configuration:&saved,settings:&json!({})},&[AcceptedInput{input:json!({"metadata":{"messageOrigin":"agent"},"message":{"role":"user","content":[{"type":"tool_call_request","name":"read_skill","arguments":{"name":"deploy"}}]}}),requested_call:None}],false)).await.unwrap();
    assert!(matches!(graph.skills.execute_tool(&scope,&call,cancel.clone()).await.unwrap(),Message::Tool{is_error:true,..}));
    let input=json!({"metadata":{"messageOrigin":"user"},"message":{"role":"user","content":[{"type":"tool_call_request","name":"read_skill","arguments":{"name":"deploy"}}]}});
    let module=graph.skills.clone();let acting=id.clone();let saved=config.clone();let accepted=input.clone();graph.fixture.runtime.transact(move|ctx|{module.accepted(ctx,&AgentScope{id:&acting,configuration:&saved,settings:&json!({})},&[AcceptedInput{input:accepted,requested_call:None}],false)?;anyhow::bail!("Roll back the accepted request.");#[allow(unreachable_code)]Ok::<(),anyhow::Error>(())}).await.unwrap_err();
    assert!(matches!(graph.skills.execute_tool(&scope,&call,cancel.clone()).await.unwrap(),Message::Tool{is_error:true,..}));
    let module=graph.skills.clone();let acting=id.clone();let saved=config.clone();graph.fixture.runtime.transact(move|ctx|module.accepted(ctx,&AgentScope{id:&acting,configuration:&saved,settings:&json!({})},&[AcceptedInput{input,requested_call:None}],false)).await.unwrap();
    match graph.skills.execute_tool(&scope,&call,cancel.clone()).await.unwrap(){Message::Tool{call_id,content,is_error,..}=>{assert_eq!(call_id,"original-skill-call");assert!(!is_error);assert_eq!(content[0],Block::text(std::fs::read_to_string(&path).unwrap()));},_=>panic!("Expected the original skill tool result.")}
    assert!(graph.skills.read(&scope,&json!({"name":"deploy"}),&cancel).await.is_err());assert!(graph.skills.list(&scope,&json!({}),&cancel).await.unwrap()["skills"].as_array().unwrap().is_empty());
    let agents=graph.agents.clone();let acting=id.clone();graph.fixture.runtime.transact(move|ctx|{ctx.delete_value(&acting,&format!("kv.{acting}.run.module.skills.skill-read-requests"))?;assert!(agents.configuration(ctx,&acting)?.is_some());Ok(())}).await.unwrap();assert!(matches!(graph.skills.execute_tool(&scope,&call,cancel).await.unwrap(),Message::Tool{is_error:true,..}));
    graph.close().await;
}

#[tokio::test]
async fn skills_real_agent_refreshes_instructions_and_expires_user_only_read_authorization_after_settlement() {
    let (endpoint,mut requests,server)=naming_provider(vec!["Read the requested skill.","Refused the agent's request.","Observed the edited catalog."]).await;
    let graph=Graph::new_with_provider(&endpoint).await;let project=graph.fixture.directory.path().join("inference-skills");std::fs::create_dir_all(&project).unwrap();
    let root=project.join(".agents/skills");let visible=skill_document(&root,"guide","guide","First guide description","");let reserved=skill_document(&root,"deploy","deploy","Hidden from inference","disable-model-invocation: true\n");
    let (id,_)=skill_agent(&graph,&project).await;let selection=graph.task_input("Skills inference");
    for (round,origin) in ["user","agent","user"].into_iter().enumerate(){
        if round==2{std::fs::write(&visible,"---\nname: guide\ndescription: Edited guide description\n---\nUpdated instructions\n").unwrap();}
        let content=if round<2{json!([{"type":"text","text":"Read the deployment skill."},{"type":"tool_call_request","name":"read_skill","arguments":{"name":"deploy"}}])}else{json!([{"type":"text","text":"Use the available guide."}])};
        let agents=graph.agents.clone();let acting=id.clone();let model=selection["model"].clone();let effort=selection["effort"].clone();
        graph.fixture.runtime.transact(move|ctx|agents.enqueue(ctx,&acting,&json!({"id":cuid2::create_id(),"message":{"role":"user","content":content},"options":{"provider":"fixture","model":model,"effort":effort,"permissionMode":"workspace_write"},"metadata":{"messageOrigin":origin}}),false)).await.unwrap();
        let request=tokio::time::timeout(Duration::from_secs(8),requests.recv()).await.unwrap().unwrap();let instructions=request["instructions"].as_str().unwrap();
        assert!(instructions.contains(if round==2{"Edited guide description"}else{"First guide description"}));assert!(!instructions.contains("Hidden from inference"));
        let outputs=request["input"].as_array().unwrap().iter().filter(|item|item["type"]=="function_call_output").filter_map(|item|item["output"].as_str()).collect::<Vec<_>>();
        if round==0{assert!(outputs.iter().any(|output|*output==std::fs::read_to_string(&reserved).unwrap()));}else if round==1{assert!(outputs.iter().any(|output|output.contains("can only be invoked by the user")));}
        graph.agents.wait_for_idle(&id,&CancellationToken::new()).await.unwrap();
    }
    assert!(requests.try_recv().is_err());server.await.unwrap();graph.close().await;
}
#[tokio::test]
async fn skills_explicit_command_invocation_is_transactional_and_injects_complete_user_only_instructions() {
    let (endpoint,mut requests,server)=naming_provider(vec!["Followed the explicitly invoked skill."]).await;let graph=Graph::new_with_provider(&endpoint).await;
    let project=graph.fixture.directory.path().join("slash-invocation");std::fs::create_dir_all(&project).unwrap();let path=skill_document(&project.join(".agents/skills"),"deploy","deploy","User controlled command","disable-model-invocation: true\n");
    let (id,config)=skill_agent(&graph,&project).await;let scope=AgentScope{id:&id,configuration:&config,settings:&json!({"permissionMode":"workspace_write"})};let cancel=CancellationToken::new();let selection=graph.task_input("Explicit command");
    let input=json!({"arguments":"inspect authentication","mode":{"providerId":"fixture","modelId":selection["model"],"effort":selection["effort"],"serviceTier":null,"permissionMode":"workspace_write"},"mutationId":"source-command-mutation"});
    assert_eq!(graph.skills.slash_commands(&scope,&cancel).await.unwrap(),vec![json!({"description":"User controlled command","hasArguments":true,"kind":"skill","name":"deploy"})]);
    let prepared=graph.skills.prepare_slash_invocation(&scope,"deploy",&input,&cancel).await.unwrap();assert_eq!(prepared["document"]["content"],std::fs::read_to_string(&path).unwrap());
    let owner=graph.skills.clone();let actor=id.clone();let saved=prepared.clone();graph.fixture.runtime.transact(move|ctx|{owner.invoke_slash_command(ctx,&actor,&saved)?;anyhow::bail!("Roll back the whole command.");#[allow(unreachable_code)]Ok::<(),anyhow::Error>(())}).await.unwrap_err();
    let agents=graph.agents.clone();let actor=id.clone();graph.fixture.runtime.transact(move|ctx|{assert!(agents.owed(ctx,&actor)?.is_none());assert!(agents.configuration(ctx,&actor)?.unwrap()["metadata"]["lastMode"].is_null());Ok(())}).await.unwrap();assert!(requests.try_recv().is_err());
    let owner=graph.skills.clone();let actor=id.clone();let saved=prepared.clone();graph.fixture.runtime.transact(move|ctx|owner.invoke_slash_command(ctx,&actor,&saved)).await.unwrap();let request=tokio::time::timeout(Duration::from_secs(8),requests.recv()).await.unwrap().unwrap();
    assert!(request["instructions"].as_str().unwrap().contains("The user directly invoked the /deploy skill for this run."));assert!(request["instructions"].as_str().unwrap().contains(prepared["document"]["content"].as_str().unwrap()));assert!(provider_input_texts(&request).iter().any(|text|*text=="Use the /deploy skill.\n\ninspect authentication"));
    graph.agents.wait_for_idle(&id,&cancel).await.unwrap();assert_eq!(graph.agent_config(&id).await["metadata"]["lastMode"],input["mode"]);
    let history=graph.history.messages(id.clone(),None,None,20,false).await.unwrap();let messages=history["runs"].as_array().unwrap().iter().flat_map(|run|run["messages"].as_array().unwrap()).filter(|message|message["id"]==prepared["messageId"]).collect::<Vec<_>>();assert_eq!(messages.len(),1);assert_eq!(messages[0]["role"],"user");assert_eq!(messages[0]["mode"],input["mode"]);
    server.await.unwrap();graph.close().await;
}

#[tokio::test]
async fn system_prompt_real_inference_refreshes_current_model_and_live_instruction_documents() {
    system_prompt_inference_fixture(false).await;
}

#[tokio::test]
#[ignore = "Requires the pending Source beforeTurn hook in the native agent core."]
async fn system_prompt_real_inference_refreshes_model_and_documents_and_accepts_hidden_change_notices() {
    system_prompt_inference_fixture(true).await;
}

async fn system_prompt_inference_fixture(require_notices: bool) {
    let (endpoint, mut requests, server) = naming_provider(vec!["Read the first instructions.", "Read the replacement instructions.", "Read the removal notice."]).await;
    let graph = Graph::new_with_provider(&endpoint).await;
    let root = graph.fixture.directory.path().join("prompt-project");
    let cwd = root.join("child");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::write(root.join(".git"), "fixture marker").unwrap();
    std::fs::write(root.join("AGENTS.md"), "Original root instruction sentinel").unwrap();
    std::fs::write(cwd.join("AGENTS.md"), "Child instruction sentinel").unwrap();
    std::fs::write(root.join("AGENTS_SECURITY.md"), "Project security sentinel").unwrap();
    std::fs::write(&graph.fixture.config.paths.instructions, "Global instruction sentinel").unwrap();
    let (id, _) = skill_agent(&graph, &cwd).await;
    let models = graph.fixture.config.naming_models().unwrap();
    let first = models.iter().find(|model| model["providerId"] == "fixture" && model["id"] == "openai/gpt-6.1-sol").unwrap();
    let second = models.iter().find(|model| model["providerId"] == "fixture" && model["id"] == "openai/gpt-6-sol").unwrap();
    for (round, model) in [first, second, first].into_iter().enumerate() {
        if round == 1 { std::fs::write(root.join("AGENTS.md"), "Replacement root instruction sentinel").unwrap(); }
        if round == 2 {
            for path in [root.join("AGENTS.md"), root.join("AGENTS_SECURITY.md"), cwd.join("AGENTS.md"), graph.fixture.config.paths.instructions.clone()] { std::fs::remove_file(path).unwrap(); }
        }
        let agents = graph.agents.clone(); let acting = id.clone(); let model = model.clone();
        graph.fixture.runtime.transact(move |ctx| agents.enqueue(ctx, &acting, &json!({"id":cuid2::create_id(),"message":{"role":"user","content":[{"type":"text","text":"Follow the current instructions."}]},"options":{"provider":"fixture","model":model["id"],"effort":model["defaultEffort"],"permissionMode":"workspace_write"},"metadata":{"messageOrigin":"user"}}), false)).await.unwrap();
        let request = tokio::time::timeout(Duration::from_secs(12), requests.recv()).await.unwrap().unwrap();
        let instructions = request["instructions"].as_str().unwrap();
        let expected = graph.system_prompt.prompt_for(&json!({"model":if round == 1 {"openai/gpt-6-sol"} else {"openai/gpt-6.1-sol"},"providerKind":"codex"})).unwrap();
        assert!(instructions.contains(&expected));
        assert!(instructions.contains("## Available models"));
        if round < 2 {
            assert!(instructions.contains("Global instruction sentinel"));
            assert!(instructions.contains("Child instruction sentinel"));
            assert!(instructions.contains("Project security sentinel"));
            assert!(instructions.contains(if round == 0 {"Original root instruction sentinel"} else {"Replacement root instruction sentinel"}));
        } else {
            assert!(!instructions.contains("Global instruction sentinel"));
            assert!(!instructions.contains("Replacement root instruction sentinel"));
        }
        if require_notices && round > 0 {
            assert!(provider_input_texts(&request).iter().any(|text| text.starts_with(if round == 1 {"These AGENTS.md instructions replace all previously provided AGENTS.md instructions."} else {"The previously provided AGENTS.md instructions no longer apply."})));
        }
        graph.agents.wait_for_idle(&id, &CancellationToken::new()).await.unwrap();
    }
    let history = graph.history.messages(id.clone(), None, None, 50, false).await.unwrap();
    assert!(!history.to_string().contains("These AGENTS.md instructions replace"));
    assert!(!history.to_string().contains("The previously provided AGENTS.md instructions no longer apply"));
    if require_notices {
        let acting = id.clone();
        graph.fixture.runtime.transact(move |ctx| {
        assert!(ctx.value(&acting, &format!("kv.{acting}.module.system-prompt.last-delivered-fingerprint"))?.unwrap().is_null());
        assert!(ctx.value(&acting, &format!("kv.{acting}.module.system-prompt.pending-notice"))?.is_none());
        assert!(ctx.value(&acting, &format!("kv.{acting}.run.module.system-prompt.turn-instructions-snapshot"))?.is_none());
        Ok(())
        }).await.unwrap();
    }
    server.await.unwrap();
    graph.close().await;
}
#[cfg(unix)]
#[tokio::test]
async fn skills_compute_seam_handles_absence_directory_links_cycles_and_unreadable_documents() {
    use std::os::unix::fs::symlink;
    let graph=Graph::new().await;let project=graph.fixture.directory.path().join("linked-skills");let root=project.join(".agents/skills");std::fs::create_dir_all(&root).unwrap();let (id,config)=skill_agent(&graph,&project).await;
    let settings=json!({"permissionMode":"read_only"});let scope=AgentScope{id:&id,configuration:&config,settings:&settings};let absent=json!({});let no_compute=AgentScope{id:&id,configuration:&absent,settings:&settings};let cancel=CancellationToken::new();
    assert!(graph.skills.available_tools(&no_compute).await.unwrap().is_empty());assert!(graph.skills.instructions(&no_compute).await.unwrap().is_empty());assert_eq!(graph.skills.read(&no_compute,&json!({"name":"missing"}),&cancel).await.unwrap_err().to_string(),"This agent has no compute.");
    let target=graph.fixture.directory.path().join("linked-target");let document=skill_document(&target,"linked","linked","Directory link","");symlink(document.parent().unwrap(),root.join("directory-link")).unwrap();symlink(&root,document.parent().unwrap().join("cycle")).unwrap();
    let file_link=root.join("file-link");std::fs::create_dir_all(&file_link).unwrap();symlink(&document,file_link.join("SKILL.md")).unwrap();let dangling=root.join("dangling");symlink(project.join("missing"),dangling).unwrap();
    let private=graph.fixture.config.paths.directory.join("private-skill");skill_document(&private,"secret","secret","Private installation","");symlink(&private,root.join("private-link")).unwrap();
    let oversized=skill_document(&root,"oversized","oversized","Exceeds byte bound","");std::fs::write(&oversized,"x".repeat(262145)).unwrap();
    let listed=tokio::time::timeout(Duration::from_secs(5),graph.skills.list(&scope,&json!({}),&cancel)).await.unwrap().unwrap();assert_eq!(listed["skills"].as_array().unwrap().len(),1);assert_eq!(listed["skills"][0]["name"],"linked");assert_eq!(listed["skills"][0]["location"],json!(document));
    assert_eq!(graph.skills.read(&scope,&json!({"name":"linked"}),&cancel).await.unwrap()["content"],std::fs::read_to_string(&document).unwrap());assert!(graph.skills.read(&scope,&json!({"name":"secret"}),&cancel).await.is_err());
    graph.close().await;
}
