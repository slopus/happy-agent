//! The built daemon's authenticated human answer is durable authorization evidence.
use super::*;
struct Cleanup<'a>(&'a Installation);
impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        use std::io::{Read,Write};
        let directory=self.0.home.join("agent");
        if let (Ok(token),Ok(mut socket))=(std::fs::read_to_string(directory.join("token")),std::os::unix::net::UnixStream::connect(directory.join("server.sock"))) {
            let _=socket.set_read_timeout(Some(Duration::from_secs(1)));let _=socket.set_write_timeout(Some(Duration::from_secs(1)));
            let _=socket.write_all(format!("POST /v0/shutdown HTTP/1.1\r\nHost: happy\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",token.trim()).as_bytes());
            let mut response=[0;4096];let _=socket.read(&mut response);
        }
        let deadline=std::time::Instant::now()+Duration::from_secs(10);
        while directory.join("daemon.pid").exists()&&std::time::Instant::now()<deadline {std::thread::sleep(Duration::from_millis(20));}
    }
}
#[tokio::test(flavor="multi_thread",worker_threads=2)]
async fn authenticated_question_answer_survives_restart_and_is_first_write_wins() {
    let (endpoint,mut requests,provider)=scripted_provider(2).await;
    let installation=Installation::new();installation.seed(&endpoint);installation.command("start");let _cleanup=Cleanup(&installation);
    let (client,token)=installation.client();
    let first=exchange(&mut requests).await;
    first.respond.send(command_response("provider-question-id","request_user_input",json!({"context":"Choose how to continue.","questions":[{"id":"database","header":"Database","question":"Which database?","options":[{"label":"SQLite","description":"Local storage."},{"label":"PostgreSQL","description":"Shared storage."}]}]}))).unwrap();
    let pending=tokio::time::timeout(Duration::from_secs(10),async {loop {
        let response=client.get(format!("http://happy/v0/agents/{AGENT}/question")).bearer_auth(&token).send().await.unwrap();
        assert_eq!(response.status(),200,"The original public question route must exist.");
        let body:Value=response.json().await.unwrap();if body["question"].is_object(){break body["question"].clone();}tokio::task::yield_now().await;
    }}).await.unwrap();
    assert_eq!(pending["questions"][0]["id"],"database");assert_eq!(pending["runId"],RUN);assert_eq!(pending["answers"],Value::Null);
    let id=pending["id"].as_str().unwrap().to_owned();assert_ne!(id,"provider-question-id");
    let focused:Value=client.get(format!("http://happy/v0/agents/{AGENT}")).bearer_auth(&token).send().await.unwrap().json().await.unwrap();assert_eq!(focused["agent"]["pendingQuestionId"],id);
    installation.command("stop");installation.command("start");let (client,token)=installation.client();
    let restored:Value=client.get(format!("http://happy/v0/agents/{AGENT}/question")).bearer_auth(&token).send().await.unwrap().json().await.unwrap();assert_eq!(restored["question"],pending);
    let answer_url=format!("http://happy/v0/agents/{AGENT}/question/{id}/answer");
    let invalid=client.post(&answer_url).bearer_auth(&token).json(&json!({"answers":{"wrong":["SQLite"]}})).send().await.unwrap();assert_eq!(invalid.status(),400);
    let answered=client.post(&answer_url).bearer_auth(&token).json(&json!({"answers":{"database":["SQLite"]},"mutationId":"question-human-answer"})).send().await.unwrap();assert_eq!(answered.status(),200);
    let answered:Value=answered.json().await.unwrap();assert_eq!(answered["question"]["status"],"answered");assert_eq!(answered["question"]["answers"],json!({"database":["SQLite"]}));assert!(answered["question"]["version"].as_str().unwrap()>pending["version"].as_str().unwrap());
    let duplicate=client.post(&answer_url).bearer_auth(&token).json(&json!({"answers":{"database":["PostgreSQL"]}})).send().await.unwrap();assert_eq!(duplicate.status(),409);let duplicate:Value=duplicate.json().await.unwrap();assert_eq!(duplicate["question"],answered["question"]);
    let next=exchange(&mut requests).await;assert!(command_output(&next.request,"provider-question-id").contains("SQLite"));next.respond.send(text_response("The chosen database is SQLite.")).unwrap();
    completed(&installation).await;
    let empty:Value=client.get(format!("http://happy/v0/agents/{AGENT}/question")).bearer_auth(&token).send().await.unwrap().json().await.unwrap();assert_eq!(empty,json!({"question":null}));
    let events:Value=client.get("http://happy/v0/events").bearer_auth(&token).send().await.unwrap().json().await.unwrap();let events=events["events"].as_array().unwrap();
    assert!(events.iter().any(|event|event["type"]=="question.updated"&&event["payload"]["questionId"]==id));
    installation.command("stop");provider.await.unwrap();
    let database=Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    let entries=database.prepare("SELECT entry_json,trusted_user_evidence FROM happy_agent_auto_evidence WHERE agent_id=?1 ORDER BY position").unwrap().query_map([AGENT],|row|Ok((row.get::<_,String>(0)?,row.get::<_,i64>(1)?))).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    let answers=entries.iter().filter(|(_,trusted)|*trusted==1).filter_map(|(entry,_)|serde_json::from_str::<Value>(entry).ok()).flat_map(|entry|entry["blocks"].as_array().cloned().unwrap_or_default()).filter_map(|block|block.get("trustedUserEvidence").cloned()).collect::<Vec<_>>();
    assert!(answers.iter().any(|answer|answer.to_string().contains("SQLite")),"Only the authenticated API answer becomes trusted human evidence: {entries:?}");
    assert!(!answers.iter().any(|answer|answer.to_string().contains("PostgreSQL")),"A rejected later answer cannot replace authorization.");
}

#[tokio::test(flavor="multi_thread",worker_threads=2)]
async fn mixed_options_and_free_text_preserve_exact_answers_and_validate_cardinality() {
    let (endpoint,mut requests,provider)=scripted_provider(2).await;
    let installation=Installation::new();installation.seed(&endpoint);installation.command("start");let _cleanup=Cleanup(&installation);
    let (client,token)=installation.client();let first=exchange(&mut requests).await;
    first.respond.send(command_response("mixed-question-id","request_user_input",json!({"context":"Choose storage and provide details.","questions":[
        {"id":"many","question":"Which databases?","options":{"choices":[{"label":"SQLite","description":"Local."},{"label":"PostgreSQL","description":"Shared."}],"multiSelect":true}},
        {"id":"one","question":"Which region?","options":{"choices":[{"label":"Europe","description":"Europe."},{"label":"America","description":"America."}],"multiSelect":false}},
        {"id":"notes","question":"Any notes?"}
    ]}))).unwrap();
    let pending=tokio::time::timeout(Duration::from_secs(10),async{loop{let response=client.get(format!("http://happy/v0/agents/{AGENT}/question")).bearer_auth(&token).send().await.unwrap();assert_eq!(response.status(),200);let value:Value=response.json().await.unwrap();if value["question"].is_object(){break value["question"].clone();}tokio::task::yield_now().await;}}).await.unwrap();
    let id=pending["id"].as_str().unwrap();let url=format!("http://happy/v0/agents/{AGENT}/question/{id}/answer");
    let answers=json!({"many":["SQLite","PostgreSQL","Keep a local backup."],"one":["Europe","Use Paris."],"notes":["Keep this first line.","Keep this second line."]});
    for invalid in [
        json!({"many":["SQLite","SQLite"],"one":["Europe"],"notes":["Details"]}),
        json!({"many":["SQLite"],"one":["Europe","America"],"notes":["Details"]}),
        json!({"many":["SQLite"],"one":["Europe"]}),
        json!({"many":[],"one":["Europe"],"notes":["Details"]})
    ]{let response=client.post(&url).bearer_auth(&token).json(&json!({"answers":invalid})).send().await.unwrap();assert_eq!(response.status(),400);}
    let response=client.post(&url).bearer_auth(&token).json(&json!({"answers":answers,"mutationId":"mixed-answer"})).send().await.unwrap();assert_eq!(response.status(),200);let accepted:Value=response.json().await.unwrap();assert_eq!(accepted["question"]["answers"],answers);
    let next=exchange(&mut requests).await;let output=command_output(&next.request,"mixed-question-id");for text in ["SQLite","PostgreSQL","Keep a local backup.","Europe","Use Paris.","Keep this first line.","Keep this second line."]{assert!(output.contains(text),"The resumed tool result lost {text}: {output}");}next.respond.send(text_response("The mixed answer was applied.")).unwrap();completed(&installation).await;
    installation.command("stop");installation.command("start");let (client,token)=installation.client();let response=client.post(&url).bearer_auth(&token).json(&json!({"answers":{"many":["SQLite"],"one":["America"],"notes":["Changed"]}})).send().await.unwrap();assert_eq!(response.status(),409);let conflict:Value=response.json().await.unwrap();assert_eq!(conflict["question"]["answers"],answers);
    installation.command("stop");provider.await.unwrap();
    let database=Connection::open(installation.home.join("agent/agent.sqlite")).unwrap();
    let entries=database.prepare("SELECT entry_json FROM happy_agent_auto_evidence WHERE agent_id=?1 AND trusted_user_evidence=1 ORDER BY position").unwrap().query_map([AGENT],|row|row.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
    let trusted=entries.iter().filter_map(|entry|serde_json::from_str::<Value>(entry).ok()).flat_map(|entry|entry["blocks"].as_array().cloned().unwrap_or_default()).filter_map(|block|block.get("trustedUserEvidence").cloned()).collect::<Vec<_>>();
    assert!(trusted.iter().any(|entry|entry.to_string().contains("Keep a local backup.")));assert!(!trusted.iter().any(|entry|entry.to_string().contains("Changed")||entry.to_string().contains("Choose storage and provide details.")));
}