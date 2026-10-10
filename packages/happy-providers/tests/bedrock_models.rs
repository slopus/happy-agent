//! Rig's Anthropic models reach Amazon Bedrock through the regional inference profile AWS
//! documents for each model, and Mantle receives the base model ID.
use happy_providers::*;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

/// A loopback Bedrock endpoint that records each request's path and JSON body, then rejects it.
async fn endpoint() -> (String, Arc<Mutex<Vec<(String, Value)>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests: Arc<Mutex<Vec<(String, Value)>>> = Arc::default();
    let recorded = requests.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut bytes = Vec::new();
            let request = loop {
                let mut buffer = [0; 8192];
                let Ok(count @ 1..) = socket.read(&mut buffer).await else {
                    break None;
                };
                bytes.extend_from_slice(&buffer[..count]);
                let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8_lossy(&bytes[..end]).to_string();
                let length = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")?
                            .parse::<usize>()
                            .ok()
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    let path = head
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_owned();
                    let body = serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                        .unwrap_or(Value::Null);
                    break Some((path, body));
                }
            };
            if let Some(request) = request {
                recorded.lock().unwrap().push(request);
            }
            let body = r#"{"message":"rejected"}"#;
            let head = format!(
                "HTTP/1.1 400 X\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            let _ = socket.write_all(head.as_bytes()).await;
            let _ = socket.write_all(body.as_bytes()).await;
        }
    });
    (url, requests)
}

async fn run(endpoint: &str, model: &str, region: &str, transport: BedrockTransport) -> Vec<Event> {
    let mut config: ProviderConfig = serde_json::from_value(json!({
        "kind": "claude",
        "credential": { "type": "bearer", "token": "test-placeholder" },
        "model": model,
        "endpoint": endpoint,
        "region": region,
        "inferenceMaxRetries": 0,
    }))
    .unwrap();
    config.bedrock = Some(transport);
    let mut session = HttpSession::new("bedrock".into(), config, vec![])
        .await
        .unwrap();
    let (tx, mut rx) = mpsc::channel(128);
    let run = session.run(RunRequest::default(), CancellationToken::new(), tx);
    let collecting = async {
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        events
    };
    tokio::join!(run, collecting).1
}

#[tokio::test]
async fn anthropic_models_use_the_regional_inference_profile_aws_documents() {
    let (url, requests) = endpoint().await;
    let cases = [
        ("fable-5-1", "us-east-1", "us"),
        ("fable-5-1", "eu-west-1", "global"),
        ("fable-5-1", "ap-northeast-1", "global"),
        ("sonnet-5-5", "us-east-1", "global"),
        ("sonnet-5-5", "eu-west-1", "global"),
        ("opus-5-5", "ap-northeast-1", "jp"),
        ("opus-5", "ap-northeast-3", "jp"),
        ("opus-4-8", "ap-southeast-2", "au"),
        ("opus-5-5", "eu-central-1", "eu"),
        ("opus-5", "us-west-2", "us"),
        ("opus-4-8", "sa-east-1", "global"),
        ("fable-5", "eu-west-3", "eu"),
        ("fable-5", "us-east-2", "us"),
        ("fable-5", "ap-southeast-2", "global"),
        ("sonnet-5", "ap-southeast-2", "au"),
        ("sonnet-5", "ap-southeast-4", "au"),
        ("sonnet-5", "eu-north-1", "eu"),
        ("sonnet-5", "us-east-1", "us"),
        ("sonnet-5", "ap-south-1", "global"),
        ("opus-5-5", "ap-southeast-4", "global"),
    ];
    for (name, region, geo) in cases {
        run(
            &url,
            &format!("anthropic/{name}"),
            region,
            BedrockTransport::Runtime,
        )
        .await;
        let (path, _) = requests.lock().unwrap().pop().unwrap();
        assert_eq!(
            path,
            format!("/model/{geo}.anthropic.claude-{name}/invoke-with-response-stream"),
            "{name} in {region}"
        );
    }

    // A Bedrock model or inference-profile ID passes through untouched.
    run(
        &url,
        "apac.anthropic.claude-opus-5",
        "ap-south-1",
        BedrockTransport::Runtime,
    )
    .await;
    let (path, _) = requests.lock().unwrap().pop().unwrap();
    assert_eq!(
        path,
        "/model/apac.anthropic.claude-opus-5/invoke-with-response-stream"
    );

    // Mantle addresses the base model, wherever it runs.
    run(
        &url,
        "anthropic/opus-5",
        "eu-west-1",
        BedrockTransport::Mantle,
    )
    .await;
    let (path, body) = requests.lock().unwrap().pop().unwrap();
    assert_eq!(path, "/messages");
    assert_eq!(body["model"], "anthropic.claude-opus-5");

    // A model outside the catalog fails before anything is sent instead of guessing a profile.
    let events = run(
        &url,
        "anthropic/haiku-9",
        "us-east-1",
        BedrockTransport::Runtime,
    )
    .await;
    let Some(Event::Done {
        outcome: Outcome::Error { error },
    }) = events.last()
    else {
        panic!("an unlisted model must fail the turn: {events:?}");
    };
    assert_eq!(
        error.message,
        "Anthropic model \"anthropic/haiku-9\" is not available through Rig's Bedrock catalog. Pass a Bedrock model or inference-profile ID directly to use an unlisted model."
    );
    assert!(requests.lock().unwrap().is_empty());
}
