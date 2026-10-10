//! The published client reads the project and workspace catalog and the desktop bootstrap.
use super::*;

const ARCHIVED_AGENT: &str = "agentarchivedfixture";
const CHILD: &str = "workspacechildone";
const GRANDCHILD: &str = "workspacegrandchild";
const ARCHIVED_CHILD: &str = "workspacearchivedone";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn published_client_reads_the_catalog_and_one_composed_desktop_snapshot() {
    let (endpoint, mut requests, provider) = scripted_provider(1).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    // A second root agent of the same project, archived: it leaves the series for archivedAgents.
    let database = Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    let folder = installation._directory.path().join("workspace");
    let configuration = json!({"provenance":{"createdAt":1700000000000u64},"environment":{"osVersion":"fixture","platform":"linux","workingDirectory":folder,"shell":"/bin/bash"},"modules":{"compute":{"cwd":folder}},"metadata":{"title":"Archived fixture","version":2,"updatedAt":1700000005000u64,"archivedAt":1700000005000u64}});
    for (owner, key) in [("", format!("agentSystem.config.{ARCHIVED_AGENT}")), (ARCHIVED_AGENT, "agentConfig".to_owned())] {
        database.execute("INSERT INTO happy_agent_values VALUES(?1,?2,?3)", params![owner, key, configuration.to_string()]).unwrap();
    }
    database.execute("INSERT INTO happy_agent_module_project_root_agents(project_id,agent_id,order_key) VALUES(?1,?2,'7')", params![WORKSPACE, ARCHIVED_AGENT]).unwrap();
    // A child workspace, one nested under it, and an archived child, each with its own folder.
    for (id, name, parent, kind, status, order, archived) in [
        (CHILD, "fix-login", WORKSPACE, "git_worktree", "ready", "5", None),
        (GRANDCHILD, "fix-login-deeper", CHILD, "directory", "ready", "5", None),
        (ARCHIVED_CHILD, "old-work", WORKSPACE, "git_worktree", "archived", "7", Some(1700000009000i64)),
    ] {
        let path = installation._directory.path().join(name);
        std::fs::create_dir(&path).unwrap();
        let (base_ref, base_commit) = if kind == "git_worktree" { (Some("main"), Some("4f2a1c9")) } else { (None, None) };
        database.execute(
            "INSERT INTO happy_agent_module_workspaces(id,project_ref,name,name_key,name_configured,branch,storage_key,kind,path,base_ref,base_commit,presence,status,order_key,version,git_ahead,git_behind,git_detached,git_head,initialization_attempt,created_at,updated_at,archived_at,parent_id) VALUES(?1,?2,?3,?3,1,?3,?3,?4,?5,?6,?7,'present',?8,?9,3,3,0,0,'8b3d2e1',1,1700000001000,1700000009000,?10,?11)",
            params![id, WORKSPACE, name, kind, path.to_string_lossy(), base_ref, base_commit, status, order, archived, parent],
        ).unwrap();
    }
    drop(database);
    installation.command("start");
    exchange(&mut requests).await.respond.send(text_response("catalog-ready")).unwrap();
    completed(&installation).await;
    let output = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/client_catalog_bootstrap.mjs"))
        .args([installation.home.as_os_str(), WORKSPACE.as_ref(), AGENT.as_ref(), ARCHIVED_AGENT.as_ref(), CHILD.as_ref(), GRANDCHILD.as_ref(), ARCHIVED_CHILD.as_ref()])
        .output()
        .expect("published JavaScript client");
    assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stderr), std::fs::read_to_string(installation.home.join("agent/daemon.log")).unwrap_or_default());
    assert!(String::from_utf8_lossy(&output.stdout).contains("Published client read the catalog and desktop bootstrap"));
    installation.command("stop");
    provider.await.unwrap();
}
