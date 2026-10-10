//! Real native file effects, public diff presentation and restart persistence.
use super::compute_acceptance::StopDaemon;
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn native_file_patches_commit_public_diffs_and_read_stamps_with_the_final_tool_result() {
    let (endpoint, mut requests, provider) = scripted_provider(2).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let _cleanup = StopDaemon(&installation);
    let first = exchange(&mut requests).await;
    let names = first.request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect::<Vec<_>>();
    for name in [
        "exec_command",
        "write_stdin",
        "kill_session",
        "apply_patch",
        "view_image",
        "read_agent_history",
    ] {
        assert!(names.contains(&name), "{name}");
    }
    first.respond.send(command_response("native-file-patch","apply_patch",json!({"patch":"*** Begin Patch\n*** Update File: fixture.txt\n@@\n-one recovered execution\n+one native file edit\n*** Add File: new.txt\n+written by the native patch\n*** End Patch"}))).unwrap();
    let second = exchange(&mut requests).await;
    let output = command_output(&second.request, "native-file-patch");
    assert!(
        output.contains("Success. Updated the following files:"),
        "{output}"
    );
    second
        .respond
        .send(text_response("The native patch is complete."))
        .unwrap();
    let page = completed(&installation).await;
    provider.await.unwrap();
    let workspace = installation._directory.path().join("workspace");
    assert_eq!(
        std::fs::read_to_string(workspace.join("fixture.txt")).unwrap(),
        "one native file edit\n"
    );
    assert_eq!(
        std::fs::read_to_string(workspace.join("new.txt")).unwrap(),
        "written by the native patch"
    );
    let call = page["runs"][0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().unwrap())
        .find(|block| block["type"] == "tool_call" && block["name"] == "apply_patch")
        .unwrap()
        .clone();
    assert_eq!(call["status"], "completed");
    assert_eq!(call["presentation"]["type"], "file_diff");
    assert_eq!(call["presentation"]["files"].as_array().unwrap().len(), 2);
    assert_eq!(call["presentation"]["files"][0]["added"], 1);
    assert_eq!(call["presentation"]["files"][0]["deleted"], 1);
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    let read_log: String = database
        .query_row(
            "SELECT value_json FROM happy_agent_values WHERE owner_id=?1 AND key=?2",
            params![AGENT, format!("kv.{AGENT}.module.compute.reads")],
            |row| row.get(0),
        )
        .unwrap();
    let reads: Value = serde_json::from_str(&read_log).unwrap();
    assert_eq!(reads.as_array().unwrap().len(), 2);
    let pending:usize=database.query_row("SELECT count(*) FROM happy_agent_values WHERE owner_id=?1 AND key LIKE 'native.history.toolPresentation.%'",[AGENT],|row|row.get(0)).unwrap();
    assert_eq!(pending, 0);
    drop(database);
    installation.command("stop");
    installation.command("start");
    let restarted = completed(&installation).await;
    let kept = restarted["runs"][0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().unwrap())
        .find(|block| block["type"] == "tool_call" && block["name"] == "apply_patch")
        .unwrap();
    assert_eq!(kept["presentation"], call["presentation"]);
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    let after: String = database
        .query_row(
            "SELECT value_json FROM happy_agent_values WHERE owner_id=?1 AND key=?2",
            params![AGENT, format!("kv.{AGENT}.module.compute.reads")],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, read_log);
}
