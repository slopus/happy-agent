//! A daemon-owned real shell reloads without losing the installation or agent session.
use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn daemon_owned_detached_reload_survives_subreaper_adoption_and_keeps_the_agent() {
    let (endpoint, mut requests, provider) = scripted_provider(4).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let _cleanup = compute_acceptance::StopDaemon(&installation);
    let original = std::fs::read_to_string(installation.home.join("agent/daemon.pid")).unwrap();
    let (client, token) = installation.client();
    let initial = exchange(&mut requests).await;
    let executable = env!("CARGO_BIN_EXE_happy-agent");
    let reload = format!(
        "HAPPY_HOME_DIR='{}' '{executable}' reload",
        installation.home.display()
    );
    initial
        .respond
        .send(command_response(
            "native-foreground-reload",
            "exec_command",
            json!({
                "cmd":reload,"yield_time_ms":10000
            }),
        ))
        .unwrap();
    let refused = exchange(&mut requests).await;
    let foreground = command_output(&refused.request, "native-foreground-reload");
    assert!(
        foreground.contains("Cannot reload Happy Agent from a process owned by that daemon."),
        "{foreground}"
    );
    assert_eq!(
        std::fs::read_to_string(installation.home.join("agent/daemon.pid")).unwrap(),
        original
    );
    refused
        .respond
        .send(command_response(
            "native-detached-reload",
            "exec_command",
            json!({
                "cmd":format!("{reload} --detach"),"yield_time_ms":10000
            }),
        ))
        .unwrap();
    let scheduled = tokio::time::timeout(Duration::from_secs(30), requests.recv())
        .await
        .unwrap_or_else(|error| {
            panic!(
                "reload tool did not continue: {error}; worker: {}; daemon: {}",
                std::fs::read_to_string(installation.home.join("agent/reload.log"))
                    .unwrap_or_default(),
                std::fs::read_to_string(installation.home.join("agent/daemon.log"))
                    .unwrap_or_default()
            )
        })
        .expect("reload tool continuation");
    let detached = command_output(&scheduled.request, "native-detached-reload");
    assert!(
        detached.contains("Happy Agent will reload once this command exits."),
        "{detached}"
    );
    scheduled
        .respond
        .send(text_response("The daemon reload is scheduled."))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let log = std::fs::read_to_string(installation.home.join("agent/reload.log"))
                .unwrap_or_default();
            if log.contains("Daemon is running at") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|error| {
        panic!(
            "replacement did not become ready: {error}; {}",
            std::fs::read_to_string(installation.home.join("agent/reload.log")).unwrap_or_default()
        )
    });
    assert_ne!(
        std::fs::read_to_string(installation.home.join("agent/daemon.pid")).unwrap(),
        original
    );
    assert_eq!(installation.client().1, token);
    let page = completed(&installation).await;
    assert_eq!(page["runs"][0]["id"], RUN);
    let mode = json!({"providerId":"fixture","modelId":"openai/gpt-5.6-sol","effort":"medium","serviceTier":null,"permissionMode":"full_access"});
    assert_eq!(client.post(format!("http://happy/v0/agents/{AGENT}/send")).bearer_auth(&token).json(&json!({"id":"messageafterdetachedreload","text":"Continue on the replacement daemon.","profile":null,"mode":mode})).send().await.unwrap().status(), 202);
    let resumed = exchange(&mut requests).await;
    assert!(
        resumed
            .request
            .to_string()
            .contains("Continue on the replacement daemon.")
    );
    assert!(
        resumed
            .request
            .to_string()
            .contains("The daemon reload is scheduled.")
    );
    resumed
        .respond
        .send(text_response(
            "The same session continues on the replacement daemon.",
        ))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let page: Value = client
                .get(format!("http://happy/v0/agents/{AGENT}/messages"))
                .bearer_auth(&token)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if page["runs"].as_array().unwrap().len() == 2
                && page["runs"][1]["status"] == "completed"
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("continued session settled");
    installation.command("stop");
    provider.await.unwrap();
}
