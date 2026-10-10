use super::tools::{self, Called};
use super::*;
use sha2::{Digest, Sha256};

fn golden(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

#[test]
fn identity_rows_shrink_to_what_fits_like_the_original() {
    let golden = golden(include_str!("goldens/formatting.json"));
    let rows = |items: &[(&str, Option<&str>)]| -> (Vec<String>, Vec<Option<String>>) {
        (items.iter().map(|(identity, _)| identity.to_string()).collect(), items.iter().map(|(_, suffix)| suffix.map(|suffix| format!(" — {suffix}"))).collect())
    };
    let long = "d".repeat(300);
    let (identities, suffixes) = rows(&[("alpha", Some(&long)), ("beta", Some("short")), ("gamma", None)]);
    assert_eq!(format_identity_rows(&identities, &suffixes, Some("17"), 256, "No MCP tools.").unwrap(), golden["toolsSmall"]);
    let (a, b, c, x) = ("a".repeat(100), "b".repeat(100), "c".repeat(100), "x".repeat(100));
    let (identities, suffixes) = rows(&[(&a, Some(&x)), (&b, Some("y")), (&c, None)]);
    assert_eq!(format_identity_rows(&identities, &suffixes, None, 256, "No MCP tools.").unwrap(), golden["toolsSmallNoCursor"]);
    assert_eq!(format_identity_rows(&[], &[], None, 12_000, "No MCP prompts.").unwrap(), golden["promptsEmpty"]);
    let (identities, suffixes) = rows(&[("review", Some("Review code.")), ("plain", None)]);
    assert_eq!(format_identity_rows(&identities, &suffixes, None, 12_000, "No MCP prompts.").unwrap(), golden["prompts"]);
    assert_eq!(format_identity_rows(&["x".repeat(300)], &[None], None, 256, "").unwrap_err().to_string(), "MCP model output cannot fit a complete identity.");
}

#[test]
fn module_pages_render_like_the_original() {
    let golden = golden(include_str!("goldens/formatting.json"));
    let maximum = DEFAULT_OUTPUT_CHARACTERS;
    let servers = json!({"servers": [
        {"name": "docs", "status": "connected", "toolCount": 3},
        {"name": "broken", "status": "failed", "toolCount": 0, "errorMessage": "spawn nope ENOENT"},
        {"name": "off", "status": "disabled", "toolCount": 0}
    ], "nextCursor": "3"});
    assert_eq!(format_server_page(&servers, maximum).unwrap(), golden["servers"]);
    assert_eq!(format_server_page(&json!({"servers": []}), maximum).unwrap(), golden["serversEmpty"]);
    let resources = json!({"resources": [{"uri": "file:///a", "name": "file:///a"}, {"uri": "file:///b", "name": "Bee"}]});
    assert_eq!(format_resource_page(&resources, maximum).unwrap(), golden["resources"]);
    let templates = json!({"resourceTemplates": [{"uriTemplate": "file:///{x}", "name": "X files"}]});
    assert_eq!(format_resource_template_page(&templates, maximum).unwrap(), golden["templates"]);
    let prompts = json!({"prompts": [{"name": "review", "description": "Review code."}, {"name": "plain"}]});
    assert_eq!(format_prompt_page(&prompts, maximum).unwrap(), golden["prompts"]);
    assert_eq!(format_server_page(&json!({"servers": [{"name": ""}]}), maximum).unwrap_err().to_string(), "Cannot format an invalid MCP server page.");
}

#[test]
fn colliding_tool_names_quarantine_every_server_that_contributed_them() {
    let golden = golden(include_str!("goldens/merge.json"));
    let servers = vec![
        json!({"name": "a.b", "status": "connected", "toolCount": 1}),
        json!({"name": "a_b", "status": "connected", "toolCount": 1}),
        json!({"name": "ok", "status": "connected", "toolCount": 1}),
    ];
    let names = ["mcp__a_b__x", "mcp__a_b__x", "mcp__ok__y"];
    let (merged, accepted) = merge_names(servers, &names);
    let kept: Vec<&str> = names.iter().enumerate().filter(|(index, _)| accepted.contains(index)).map(|(_, name)| *name).collect();
    assert_eq!(json!({"servers": merged, "tools": kept}), golden);
    let (merged, _) = merge_names(vec![json!({"name": "ok", "status": "connected", "toolCount": 1})], &["shared", "shared"]);
    assert_eq!(merged[1], json!({"errorMessage": "Tool name conflict: shared", "name": "MCP tools", "status": "failed", "toolCount": 0}));
}

#[test]
fn pages_follow_decimal_cursors_and_refuse_ones_that_do_not_fit() {
    let values: Vec<Value> = (0..5).map(|index| json!(index)).collect();
    assert_eq!(page_from(values.clone(), None, 2, "items").unwrap(), json!({"items": [0, 1], "nextCursor": "2"}));
    assert_eq!(page_from(values.clone(), Some("4"), 2, "items").unwrap(), json!({"items": [4]}));
    assert_eq!(page_from(values.clone(), Some(" 0x2 "), 1, "items").unwrap(), json!({"items": [2], "nextCursor": "3"}));
    assert_eq!(page_from(values.clone(), Some("5"), 2, "items").unwrap(), json!({"items": []}));
    for invalid in ["6", "-1", "1.5", "x", "Infinity"] {
        assert_eq!(page_from(values.clone(), Some(invalid), 2, "items").unwrap_err().to_string(), "MCP cursor is invalid.", "{invalid}");
    }
    assert!(assert_cursor_progress(Some("2"), Some("2"), 1).is_err());
    assert!(assert_cursor_progress(None, Some("2"), 0).is_err());
    assert!(assert_cursor_progress(None, Some("2"), 1).is_ok());
}

#[test]
fn workspaces_are_keyed_by_resolved_path_and_runner() {
    assert_eq!(workspace_key(None, "/a/b/../c/./d/").unwrap(), "/a/c/d");
    assert_eq!(workspace_key(Some("box"), "/w").unwrap(), "runner:box:/w");
    assert_eq!(parse_workspace_key("runner:box:/w"), ("/w".to_string(), Some("box".to_string())));
    assert_eq!(parse_workspace_key("/plain"), ("/plain".to_string(), None));
    assert_eq!(catalog_runner("workspace:runner:box:/w").as_deref(), Some("box"));
    assert_eq!(catalog_runner(GLOBAL_CATALOG), None);
    assert_eq!(workspace_key(None, "").unwrap_err().to_string(), "Workspace path is invalid.");
}

#[test]
fn failures_read_as_one_bounded_line() {
    assert_eq!(error_text("spawn  nope\n\tENOENT"), "spawn nope ENOENT");
    assert_eq!(error_text(""), "Connection failed.");
    assert_eq!(js_length(&error_text(&"x".repeat(3_000))), 2_000);
    assert!(tool_allowed(&json!({}), "a"));
    assert!(!tool_allowed(&json!({"enabledTools": ["b"]}), "a"));
    assert!(!tool_allowed(&json!({"disabledTools": ["a"]}), "a"));
}

/// The original's schema, written out, or its digest and length when it was too large to keep.
fn assert_schema(schema: &Value, golden: &Value, what: &str) {
    let expanded = schemas::expand(schema);
    match golden.get("sha256") {
        Some(digest) => {
            let text = super::super::text::js_json_stringify(&expanded);
            let actual: String = Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(Some(actual.as_str()), digest.as_str(), "{what}");
            assert_eq!(Some(js_length(&text) as u64), golden["length"].as_u64(), "{what}");
        }
        None => assert_eq!(&expanded, golden, "{what}"),
    }
}

fn samples(name: &str) -> Vec<Value> {
    match name {
        "configure_mcp_server" => vec![json!({"action": "set", "name": "docs"}), json!({"action": "remove", "name": "docs"})],
        "reload_mcp_servers" => vec![json!({}), json!({"global": true}), json!({"global": false})],
        "call_mcp_tool" => vec![
            json!({"server": "docs", "name": "fetch", "arguments": {"url": "https://x\n\u{202e}"}}),
            json!({"server": "linear_app", "name": "search_issues"}),
        ],
        "get_mcp_prompt" => vec![json!({"server": "my_docs", "name": "reviewCode"})],
        _ => vec![json!({"query": "bugs"}), json!({})],
    }
}

fn call(name: &str, arguments: &Value) -> Value {
    json!({"id": "call", "call": {"name": name, "arguments": arguments.to_string()}})
}

/// Names, descriptions, schemas, deferral, reloading and every Auto decision match the tools the
/// original defined. Its return types, search keywords and capability lines have no seam in the
/// native tool definition and are not compared.
#[test]
fn every_tool_is_the_one_the_original_defined() {
    let golden: Vec<Value> = serde_json::from_str(include_str!("goldens/tools.json")).unwrap();
    let mut offered = vec![tools::list_mcp_servers()];
    offered.extend(tools::configuration_tools());
    offered.extend(tools::protocol_tools(&["linear_app".into(), "docs".into()]).unwrap());
    let search = json!({"name": "search issues", "description": "Search the tracker.", "inputSchema": {
        "type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]
    }});
    offered.push(tools::direct_tool("Linear App", &search).unwrap());
    offered.push(tools::direct_tool("docs", &json!({"name": "fetch", "inputSchema": {"type": "object"}})).unwrap());
    let direct = [("Linear App", "search issues"), ("docs", "fetch")];
    assert_eq!(offered.len(), golden.len());
    for (index, (tool, expected)) in offered.iter().zip(&golden).enumerate() {
        let name = tool.name.as_str();
        assert_eq!(expected["name"], name);
        assert_eq!(tool.description, expected["description"].as_str().unwrap(), "{name}");
        assert_schema(&tool.parameters, &expected["parameters"], &format!("{name} parameters"));
        assert_eq!(json!(tool.defer), expected["defer"], "{name}");
        let called = match index.checked_sub(offered.len() - direct.len()) {
            Some(position) => Called::Direct { server: direct[position].0.into(), tool: direct[position].1.into() },
            None => Called::Fixed(match tools::FIXED.iter().find(|fixed| **fixed == name) {
                Some(fixed) => fixed,
                None => panic!("{name} is not a fixed tool"),
            }),
        };
        assert_eq!(json!(tools::is_reloadable(&called)), expected["reloadable"], "{name}");
        let policies: Vec<ToolPermissionPolicy> = samples(name).iter().map(|sample| tools::policy(&called, &call(name, sample)).unwrap()).collect();
        for policy in &policies {
            assert_eq!(json!(policy.requires_auto_or_full_access), expected["requiresAutoOrFullAccess"], "{name}");
            assert_eq!(json!(policy.instructions), expected["autoPermissionInstructions"], "{name}");
            assert_eq!(json!(policy.should_review_in_auto_mode), expected["shouldReview"], "{name}");
            assert_eq!(policy.should_run_in_full_access_in_auto_mode, expected["fullAccess"] == true, "{name}");
        }
        if !expected["describe"].is_null() {
            assert_eq!(json!(policies.iter().map(|policy| policy.action.clone()).collect::<Vec<_>>()), expected["describe"], "{name}");
        }
    }
}

#[test]
fn a_direct_call_is_always_reviewed_and_its_arguments_read_like_the_original() {
    let policy = tools::policy(&Called::Direct { server: "docs".into(), tool: "fetch".into() }, &call("mcp__docs__fetch", &json!({}))).unwrap();
    assert!(policy.should_review_in_auto_mode && policy.requires_auto_or_full_access && !policy.should_run_in_full_access_in_auto_mode);
    let raw = |text: &str| json!({"id": "call", "call": {"name": "x", "arguments": text}});
    assert_eq!(tools::arguments(&raw("{")).unwrap_err().to_string(), "The arguments for \"x\" were not valid JSON.");
    assert_eq!(tools::arguments(&raw("  ")).unwrap(), json!({}));
}

#[tokio::test]
async fn the_server_index_is_replaced_whole_inside_the_callers_transaction() {
    let directory = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
    let runtime = Arc::new(RuntimeModule::new(config));
    runtime.load().await.unwrap();
    runtime.migrate("mcp", persistence::MIGRATIONS).await.unwrap();
    let row = |agent: &str, name: &str, status: &str| {
        let mut entry = json!({"agentId": agent, "name": name, "status": status, "toolCount": 2, "updatedAt": 1_700_000_000_000u64});
        if status == "failed" {
            entry["errorMessage"] = json!("spawn nope ENOENT");
        } else {
            entry["fingerprint"] = json!("a".repeat(64));
        }
        assert!(schemas::check(&schemas::INDEXED_SERVER, &entry));
        entry
    };
    let first = vec![row("agentindexed", "docs", "connected"), row("agentindexed", "broken", "failed")];
    let written = first.clone();
    runtime.transact(move |ctx| persistence::replace_server_index(ctx, "agentindexed", &written)).await.unwrap();

    // A caller that rolls back takes the replacement with it.
    let rolled_back: Result<()> = runtime
        .transact(|ctx| {
            persistence::replace_server_index(ctx, "agentindexed", &[])?;
            bail!("Deliberate caller rollback.")
        })
        .await;
    assert!(rolled_back.is_err());
    let stored = runtime.transact(|ctx| persistence::query_server_index(ctx, "agentindexed")).await.unwrap();
    assert_eq!(stored, vec![first[1].clone(), first[0].clone()]);

    // A committed replacement leaves only the new rows, and other agents' rows alone.
    let other = vec![row("agentother", "docs", "connected")];
    runtime.transact(move |ctx| persistence::replace_server_index(ctx, "agentother", &other)).await.unwrap();
    let second = vec![row("agentindexed", "search", "connected")];
    let written = second.clone();
    runtime.transact(move |ctx| persistence::replace_server_index(ctx, "agentindexed", &written)).await.unwrap();
    let stored = runtime.transact(|ctx| persistence::query_server_index(ctx, "agentindexed")).await.unwrap();
    assert_eq!(stored, second);
    assert_eq!(runtime.transact(|ctx| persistence::query_server_index(ctx, "agentother")).await.unwrap().len(), 1);
    runtime.close().await.unwrap();
}

#[tokio::test]
async fn workspace_changes_are_owed_once_per_workspace_in_commit_order() {
    let directory = tempfile::tempdir().unwrap();
    let config = Arc::new(ConfigModule::isolated(&directory.path().join(".happy")).unwrap());
    let runtime = Arc::new(RuntimeModule::new(config));
    runtime.load().await.unwrap();
    runtime.migrate("mcp", persistence::MIGRATIONS).await.unwrap();
    let next = || runtime.transact(|ctx| persistence::query_next_workspace_intent(ctx));

    runtime.transact(|ctx| persistence::record_workspace_intent(ctx, "/one", "active")).await.unwrap();
    runtime.transact(|ctx| persistence::record_workspace_intent(ctx, "/two", "active")).await.unwrap();
    // A later change to the same workspace replaces the one still owed and moves behind the rest.
    runtime.transact(|ctx| persistence::record_workspace_intent(ctx, "/one", "released")).await.unwrap();
    let rolled_back: Result<()> = runtime
        .transact(|ctx| {
            persistence::record_workspace_intent(ctx, "/three", "active")?;
            bail!("Deliberate caller rollback.")
        })
        .await;
    assert!(rolled_back.is_err());
    assert!(runtime.transact(|ctx| persistence::record_workspace_intent(ctx, "/four", "archived")).await.is_err());

    let first = next().await.unwrap().unwrap();
    assert_eq!((first.workspace.as_str(), first.change.as_str()), ("/two", "active"));
    let settled = first.clone();
    runtime.transact(move |ctx| persistence::settle_workspace_intent(ctx, &settled)).await.unwrap();
    let second = next().await.unwrap().unwrap();
    assert_eq!((second.workspace.as_str(), second.change.as_str()), ("/one", "released"));

    // A change that arrives while one is being applied survives that one's settlement.
    runtime.transact(|ctx| persistence::record_workspace_intent(ctx, "/one", "active")).await.unwrap();
    let stale = second.clone();
    runtime.transact(move |ctx| persistence::settle_workspace_intent(ctx, &stale)).await.unwrap();
    let third = next().await.unwrap().unwrap();
    assert_eq!((third.workspace.as_str(), third.change.as_str()), ("/one", "active"));
    runtime.transact(move |ctx| persistence::settle_workspace_intent(ctx, &third)).await.unwrap();
    assert_eq!(next().await.unwrap(), None);
    runtime.close().await.unwrap();
}

#[test]
fn workspace_events_imply_the_catalog_change_the_original_followed() {
    let workspace = |path: &str, runner: Option<&str>| {
        let mut workspace = json!({"id": "workspaceone", "path": path, "status": "initializing"});
        if let Some(runner) = runner {
            workspace["runnerId"] = json!(runner);
        }
        workspace
    };
    let event = |kind: &str, change: Option<&str>, workspace: Value| {
        let mut event = json!({"type": kind, "workspace": workspace, "eventId": "00000000-0000-4000-8000-000000000000", "at": 1});
        if let Some(change) = change {
            event["change"] = json!(change);
        }
        event
    };
    let path = std::env::temp_dir().join("mcp-workspace").display().to_string();
    let key = workspace_key(None, &path).unwrap();
    assert_eq!(workspace_change(&event("workspace_created", None, workspace(&path, None))), Some((key.clone(), "active")));
    assert_eq!(workspace_change(&event("workspace_updated", Some("begin_archive"), workspace(&path, None))), Some((key.clone(), "released")));
    assert_eq!(workspace_change(&event("workspace_archived", None, workspace(&path, None))), Some((key, "released")));
    assert_eq!(
        workspace_change(&event("workspace_created", None, workspace(&path, Some("studio")))),
        Some((workspace_key(Some("studio"), &path).unwrap(), "active"))
    );
    for change in ["mark_ready", "mark_initialization_failed", "record_initialization", "set_branch", "set_service_cleanup", "rename"] {
        assert_eq!(workspace_change(&event("workspace_updated", Some(change), workspace(&path, None))), None, "{change}");
    }
    assert_eq!(workspace_change(&event("workspace_agent_attached", None, workspace(&path, None))), None);
    assert_eq!(workspace_change(&event("workspace_created", None, workspace("", None))), None);
}

/// Stands in for MCP's drain so the test observes how often Durable Functions run it.
struct CountedDrain(Arc<std::sync::atomic::AtomicUsize>);

impl DurableFunction for CountedDrain {
    fn execute(self: Arc<Self>, _call: Value, _kv: CallKv, _cancel: CancellationToken) -> BoxFuture<'static, Result<Value>> {
        self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Box::pin(async { Ok(Value::Null) })
    }
}

#[tokio::test]
async fn workspace_changes_are_owed_in_their_transaction_and_drained_by_one_call() {
    let fixture = crate::product::owners::Fixture::new().await;
    fixture.runtime.migrate("mcp", persistence::MIGRATIONS).await.unwrap();
    let drains = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    fixture
        .durable
        .register(Registration {
            name: WORKSPACES_FUNCTION.into(),
            arguments_schema: "ownerReconcileArgs",
            result_schema: "ownerNull",
            function: Arc::new(CountedDrain(drains.clone())),
        })
        .unwrap();
    let root = fixture.directory.path().display().to_string();
    let event = move |kind: &str, change: Option<&str>, folder: &str| {
        let mut event = json!({"type": kind, "workspace": {"path": format!("{root}/{folder}")}});
        if let Some(change) = change {
            event["change"] = json!(change);
        }
        event
    };
    let owe = |event: Value| {
        let durable = fixture.durable.clone();
        fixture.runtime.transact(move |ctx| owe_workspace_event(&durable, ctx, &event))
    };

    // A workspace change that rolls back owes nothing.
    let (durable, created) = (fixture.durable.clone(), event("workspace_created", None, "rolled"));
    let rolled_back: Result<()> = fixture
        .runtime
        .transact(move |ctx| {
            owe_workspace_event(&durable, ctx, &created)?;
            bail!("Deliberate workspace rollback.")
        })
        .await;
    assert!(rolled_back.is_err());
    let durable = fixture.durable.clone();
    assert!(!fixture.runtime.transact(move |ctx| durable.has_pending(ctx, WORKSPACES_FUNCTION)).await.unwrap());
    assert_eq!(fixture.runtime.transact(|ctx| persistence::query_next_workspace_intent(ctx)).await.unwrap(), None);

    // Committed changes are owed once per workspace, latest first wins, all joining one drain.
    owe(event("workspace_created", None, "one")).await.unwrap();
    owe(event("workspace_created", None, "two")).await.unwrap();
    owe(event("workspace_updated", Some("begin_archive"), "one")).await.unwrap();
    owe(event("workspace_archived", None, "one")).await.unwrap();
    owe(event("workspace_updated", Some("mark_ready"), "two")).await.unwrap();
    let durable = fixture.durable.clone();
    assert!(fixture.runtime.transact(move |ctx| durable.has_pending(ctx, WORKSPACES_FUNCTION)).await.unwrap());
    let next = fixture.runtime.transact(|ctx| persistence::query_next_workspace_intent(ctx)).await.unwrap().unwrap();
    assert_eq!((next.workspace.ends_with("/two"), next.change.as_str()), (true, "active"));

    // Durable Functions run the one owed drain after startup.
    fixture.durable.start().await.unwrap();
    for _ in 0..100 {
        let durable = fixture.durable.clone();
        if !fixture.runtime.transact(move |ctx| durable.has_pending(ctx, WORKSPACES_FUNCTION)).await.unwrap() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(drains.load(std::sync::atomic::Ordering::SeqCst), 1);
    fixture.close().await;
}
