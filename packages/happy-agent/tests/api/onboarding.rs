//! The existing standalone marker is advisory and survives a real daemon restart.
use super::*;
struct Stop<'a>(&'a Installation);
impl Drop for Stop<'_> {
    fn drop(&mut self) {
        let _ = Command::new(env!("CARGO_BIN_EXE_happy-agent"))
            .arg("stop")
            .env("HAPPY_HOME_DIR", &self.0.home)
            .output();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn standalone_onboarding_observes_readiness_and_keeps_explicit_completion_after_restart() {
    let (endpoint, mut inference, provider) = scripted_provider(1).await;
    let installation = Installation::new();
    installation.seed(&endpoint);
    installation.command("start");
    let _stop = Stop(&installation);
    exchange(&mut inference)
        .await
        .respond
        .send(text_response("onboarding-ready"))
        .unwrap();
    let (client, token) = installation.client();
    let initial = client
        .get("http://happy/v0/onboarding")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(
        initial.status(),
        200,
        "The existing onboarding resource must be available."
    );
    let initial = initial.json::<Value>().await.unwrap();
    assert_eq!(initial["completed"], false);
    assert_eq!(initial["steps"]["profile"]["done"], false);
    assert_eq!(initial["steps"]["project"]["done"], true);
    assert_eq!(
        initial["steps"]["providers"],
        json!({"done":true,"signedIn":["fixture"]})
    );
    let events = client
        .get("http://happy/v0/events?limit=1000")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    let previous_config = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "config.updated")
        .map(|event| event["id"].clone())
        .collect::<Vec<_>>();
    for _ in 0..2 {
        let completed = client
            .post("http://happy/v0/onboarding/complete")
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        assert_eq!(completed.status(), 200);
        assert_eq!(
            completed.json::<Value>().await.unwrap(),
            json!({"completed":true})
        );
    }
    let marker = installation.home.join("agent/onboarding-v0");
    assert_eq!(std::fs::read(&marker).unwrap(), b"complete\n");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&marker).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let events = client
        .get("http://happy/v0/events?limit=1000")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        events["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|event| event["type"] == "config.updated")
            .map(|event| event["id"].clone())
            .collect::<Vec<_>>(),
        previous_config,
        "Explicit completion emits no configuration nudge."
    );
    installation.command("stop");
    installation.command("start");
    let (client, token) = installation.client();
    let restored = client
        .get("http://happy/v0/onboarding")
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(restored["completed"], true);
    assert_eq!(
        restored["steps"]["profile"]["done"], false,
        "Standalone completion remains advisory when the name is absent."
    );
    assert!(
        inference.try_recv().is_err(),
        "Reading readiness performs no provider inference."
    );
    installation.command("stop");
    provider.await.unwrap();
}
