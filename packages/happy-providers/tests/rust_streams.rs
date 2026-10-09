use happy_providers::*;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::mpsc,
};
use tokio_util::sync::CancellationToken;

fn config(kind: ProviderKind, endpoint: String) -> ProviderConfig {
    serde_json::from_value(json!({"kind":kind,"credential":{"type":"bearer","token":"test-placeholder"},"model":"test-model","endpoint":endpoint,"transport":"sse","inferenceMaxRetries":1,"streamIdleTimeoutMs":1000})).unwrap()
}
fn sse(values: &[Value]) -> Vec<u8> {
    values
        .iter()
        .map(|v| format!("data: {v}\r\n\r\n"))
        .collect::<String>()
        .into_bytes()
}
fn text_response(text: &str) -> Vec<Value> {
    vec![
        json!({"type":"response.content_part.added","part":{"type":"output_text"}}),
        json!({"type":"response.output_text.delta","delta":text}),
        json!({"type":"response.output_text.done"}),
        json!({"type":"response.completed","response":{"id":"response-1","output":[],"usage":{"input_tokens":17,"output_tokens":3,"input_tokens_details":{"cached_tokens":9}}}}),
    ]
}

async fn server(
    responses: Vec<(u16, Value, Vec<u8>)>,
) -> (String, mpsc::Receiver<Value>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel(16);
    let task = tokio::spawn(async move {
        for (status, headers, body) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = Vec::new();
            let mut header_end = None;
            let mut content_length = 0;
            loop {
                let mut buffer = [0; 8192];
                let count = socket.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if header_end.is_none()
                    && let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n")
                {
                    header_end = Some(end + 4);
                    let head = String::from_utf8_lossy(&bytes[..end]);
                    content_length = head
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|s| s.parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                }
                if header_end.is_some_and(|end| bytes.len() >= end + content_length) {
                    break;
                }
            }
            let end = header_end.unwrap();
            tx.send(serde_json::from_slice(&bytes[end..end + content_length]).unwrap())
                .await
                .unwrap();
            let mut head = format!(
                "HTTP/1.1 {status} OK\r\nConnection: close\r\nContent-Length: {}\r\n",
                body.len()
            );
            for (name, value) in headers.as_object().unwrap() {
                head.push_str(&format!("{name}: {}\r\n", value.as_str().unwrap()));
            }
            head.push_str("\r\n");
            socket.write_all(head.as_bytes()).await.unwrap();
            // Deliberately split every UTF-8 character and CRLF across transport chunks.
            for chunk in body.chunks(3) {
                if socket.write_all(chunk).await.is_err() {
                    break;
                }
                tokio::task::yield_now().await;
            }
        }
    });
    (format!("http://{address}"), rx, task)
}
async fn collect(
    session: &mut HttpSession,
    request: RunRequest,
    cancel: CancellationToken,
) -> Vec<Event> {
    let (tx, mut rx) = mpsc::channel(128);
    let run = session.run(request, cancel, tx);
    tokio::pin!(run);
    let mut done = false;
    let mut events = Vec::new();
    loop {
        tokio::select! { _=&mut run,if !done=>done=true,event=rx.recv()=>{ let Some(event)=event else { break; }; events.push(event); } }
    }
    events
}

#[tokio::test]
async fn pre_cancelled_invalid_input_emits_one_terminal_cancellation() {
    let mut session = HttpSession::new(
        "cancelled".into(),
        config(ProviderKind::Responses, "http://127.0.0.1:1".into()),
        vec![],
    )
    .await
    .unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let events = collect(
        &mut session,
        RunRequest {
            context: SessionContext {
                instructions: String::new(),
                messages: vec![Message::Assistant {
                    content: vec![Block::ToolCallRequest {
                        name: "unexecuted".into(),
                        arguments: serde_json::Map::new(),
                    }],
                }],
            },
            ..Default::default()
        },
        cancel,
    )
    .await;
    assert_eq!(events.len(), 1);
    assert!(matches!(
        events[0],
        Event::Done {
            outcome: Outcome::Cancelled
        }
    ));
}

#[tokio::test]
async fn recorded_grok_hosted_search_stays_opaque_and_never_requests_local_execution() {
    for fixture in [
        include_str!("vendors/fixtures/grok-4-5-web-search.sse.json"),
        include_str!("vendors/fixtures/grok-4-5-x-search.sse.json"),
    ] {
        let fixture: Value = serde_json::from_str(fixture).unwrap();
        let recorded = fixture["response"]["events"].as_array().unwrap();
        let final_response = &recorded.last().unwrap()["response"];
        let expected_text = recorded
            .iter()
            .filter(|event| event["type"] == "response.output_text.delta")
            .map(|event| event["delta"].as_str().unwrap())
            .collect::<String>();
        let (endpoint, _requests, server) = server(vec![(
            200,
            json!({"content-type":"text/event-stream"}),
            sse(recorded),
        )])
        .await;
        let tools: Vec<ToolDefinition> = serde_json::from_value(json!([{ "name":"SearchX", "server":{"type":"x_search"} }, { "name":"SearchWeb", "server":{"type":"web_search"} }])).unwrap();
        let mut session = HttpSession::new(
            "recorded".into(),
            config(ProviderKind::Grok, endpoint),
            tools,
        )
        .await
        .unwrap();
        let events = collect(
            &mut session,
            RunRequest::default(),
            CancellationToken::new(),
        )
        .await;
        assert!(
            !events
                .iter()
                .any(|event| matches!(event, Event::ToolCallStart { server: false, .. })),
            "A hosted search must never enter the local tool batch."
        );
        let mut accumulator = Accumulator::default();
        for event in &events {
            accumulator.add(event);
        }
        let actual_text = accumulator
            .committed
            .iter()
            .filter_map(|block| match block {
                Block::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        assert_eq!(actual_text, expected_text);
        let hosted = final_response["output"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| {
                matches!(
                    item["type"].as_str(),
                    Some("web_search_call" | "custom_tool_call")
                )
            })
            .collect::<Vec<_>>();
        for item in hosted {
            assert!(accumulator.committed.iter().any(|block| matches!(block, Block::ToolCall { server:true, vendor:Some(vendor), .. } | Block::ToolResult { vendor:Some(vendor), .. } if vendor["item"] == *item)));
        }
        assert!(
            matches!(events.last(), Some(Event::Done { outcome: Outcome::Normal { usage } }) if usage.total_tokens == final_response["usage"]["total_tokens"].as_u64().unwrap())
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn codex_lite_websocket_warms_once_and_reuses_the_open_connection() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as Frame;
    let golden: Value = serde_json::from_str(include_str!(
        "vendors/fixtures/codex-gpt-5-6-sol-low.websocket.json"
    ))
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (captured, mut requests) = mpsc::channel(8);
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        for turn in 0..3 {
            let frame = socket.next().await.unwrap().unwrap();
            let request: Value = serde_json::from_str(frame.to_text().unwrap()).unwrap();
            captured.send(request.clone()).await.unwrap();
            let mut events = if request["generate"] == false {
                vec![
                    json!({"type":"response.completed","response":{"id":"warm","output":[],"usage":{}}}),
                ]
            } else {
                text_response(if turn == 1 { "first" } else { "second" })
            };
            if turn == 1 {
                events.last_mut().unwrap()["response"]["output"] = json!([{"type":"message","id":"native-message-id","status":"completed","role":"assistant","content":[{"type":"output_text","text":"first","annotations":[]}]}]);
            }
            for event in events {
                socket
                    .send(Frame::Text(event.to_string().into()))
                    .await
                    .unwrap();
            }
        }
    });
    let mut configuration = config(ProviderKind::Codex, format!("http://{address}"));
    configuration.transport = Transport::Websocket;
    configuration.model = "gpt-5.6-sol".into();
    let tools: Vec<ToolDefinition> = serde_json::from_value(json!([{ "name":"read_file", "description":"Read a file.", "parameters":{"type":"object","properties":{"path":{"type":"string"}}} }])).unwrap();
    let mut session = HttpSession::new("lite".into(), configuration, tools)
        .await
        .unwrap();
    for text in ["first user", "second user"] {
        let events = collect(
            &mut session,
            RunRequest {
                context: SessionContext {
                    instructions: "Exact instructions.".into(),
                    messages: if text == "first user" {
                        vec![Message::user(text)]
                    } else {
                        vec![
                            Message::user("first user"),
                            Message::Assistant {
                                content: vec![Block::text("first")],
                            },
                            Message::user(text),
                        ]
                    },
                },
                effort: Some(Effort::Low),
                ..Default::default()
            },
            CancellationToken::new(),
        )
        .await;
        assert!(matches!(
            events.last(),
            Some(Event::Done {
                outcome: Outcome::Normal { .. }
            })
        ));
    }
    let warm = requests.recv().await.unwrap();
    assert_eq!(warm["generate"], false);
    assert_eq!(
        warm["input"][0]["type"],
        golden["warmup"]["input"][0]["type"]
    );
    assert_eq!(warm["input"][0]["tools"][0]["name"], "read_file");
    assert_eq!(
        warm["input"][1]["content"][0]["text"],
        "Exact instructions."
    );
    assert_eq!(warm["reasoning"]["context"], "all_turns");
    for text in ["first user", "second user"] {
        let request = requests.recv().await.unwrap();
        assert_eq!(request["type"], "response.create");
        assert_eq!(request["input"].as_array().unwrap().len(), 1);
        assert_eq!(request["input"][0]["role"], "user");
        assert_eq!(request["input"][0]["content"], text);
        assert!(request.get("tools").is_none());
        assert!(request.get("instructions").is_none());
        if text == "second user" {
            assert_eq!(request["previous_response_id"], "response-1");
        }
    }
    session.destroy().await;
    server.await.unwrap();
}

#[tokio::test]
async fn bedrock_runtime_frames_preserve_thinking_and_reject_corrupted_checksums() {
    use base64::Engine;
    fn frame(event: Value) -> Vec<u8> {
        let payload =
            json!({"bytes":base64::engine::general_purpose::STANDARD.encode(event.to_string())})
                .to_string()
                .into_bytes();
        let mut frame = Vec::new();
        frame.extend_from_slice(&((payload.len() + 16) as u32).to_be_bytes());
        frame.extend_from_slice(&0u32.to_be_bytes());
        frame.extend_from_slice(&crc32fast::hash(&frame).to_be_bytes());
        frame.extend_from_slice(&payload);
        frame.extend_from_slice(&crc32fast::hash(&frame).to_be_bytes());
        frame
    }
    let body = [json!({"type":"message_start","message":{"usage":{"input_tokens":4}}}), json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}), json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"native"}}), json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}), json!({"type":"content_block_stop","index":0}), json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}), json!({"type":"message_stop"})].into_iter().flat_map(frame).collect::<Vec<_>>();
    for corrupt in [false, true] {
        let mut bytes = body.clone();
        if corrupt {
            bytes[12] ^= 1;
        }
        let (endpoint, _requests, server) = server(vec![(
            200,
            json!({"content-type":"application/vnd.amazon.eventstream"}),
            bytes,
        )])
        .await;
        let mut configuration = config(ProviderKind::Claude, endpoint);
        configuration.bedrock = Some(BedrockTransport::Runtime);
        configuration.inference_max_retries = 0;
        let mut session = HttpSession::new("runtime".into(), configuration, vec![])
            .await
            .unwrap();
        let events = collect(
            &mut session,
            RunRequest::default(),
            CancellationToken::new(),
        )
        .await;
        if corrupt {
            assert!(matches!(
                events.last(),
                Some(Event::Done {
                    outcome: Outcome::Error { .. }
                })
            ));
            assert!(!events.contains(&Event::BlockStop));
        } else {
            let mut accumulator = Accumulator::default();
            for event in &events {
                accumulator.add(event);
            }
            assert!(
                matches!(accumulator.committed.as_slice(), [Block::Reasoning { text:Some(text), reasoning:Some(signature) }] if text=="native" && signature=="signed")
            );
            assert!(
                matches!(events.last(), Some(Event::Done { outcome:Outcome::Normal { usage } }) if usage.input==4 && usage.output==2)
            );
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn fragmented_sse_preserves_unicode_usage_and_caller_history() {
    let (endpoint, mut requests, server) = server(vec![(
        200,
        json!({"content-type":"text/event-stream"}),
        sse(&text_response("café 🦀")),
    )])
    .await;
    let mut session = HttpSession::new(
        "session-1".into(),
        config(ProviderKind::Responses, endpoint),
        vec![],
    )
    .await
    .unwrap();
    let context = SessionContext {
        instructions: "Keep this exact.".into(),
        messages: vec![Message::user("hello")],
    };
    let original = context.clone();
    let events = collect(
        &mut session,
        RunRequest {
            context: context.clone(),
            ..Default::default()
        },
        CancellationToken::new(),
    )
    .await;
    let mut result = Accumulator::default();
    for event in &events {
        result.add(event);
    }
    assert_eq!(context, original);
    assert_eq!(result.committed, vec![Block::text("café 🦀")]);
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, Event::Done { .. }))
            .count(),
        1
    );
    assert!(events.iter().any(
        |e| matches!(e,Event::TokenUsage { usage } if usage.input==17 && usage.cache_read==9)
    ));
    assert_eq!(
        requests.recv().await.unwrap()["instructions"],
        "Keep this exact."
    );
    server.await.unwrap();
}

#[tokio::test]
async fn interrupted_attempt_is_reset_before_provider_owned_retry() {
    let broken = sse(&[json!({"type":"response.output_text.delta","delta":"discard me"})]);
    let (endpoint, _requests, server) = server(vec![
        (200, json!({"content-type":"text/event-stream"}), broken),
        (
            200,
            json!({"content-type":"text/event-stream"}),
            sse(&text_response("replacement")),
        ),
    ])
    .await;
    let mut session = HttpSession::new(
        "session".into(),
        config(ProviderKind::Responses, endpoint),
        vec![],
    )
    .await
    .unwrap();
    let events = collect(
        &mut session,
        RunRequest::default(),
        CancellationToken::new(),
    )
    .await;
    let mut result = Accumulator::default();
    for event in &events {
        result.add(event);
    }
    assert_eq!(result.committed, vec![Block::text("replacement")]);
    assert!(events.contains(&Event::BlockReset));
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::Retrying { attempt: 1, .. }))
    );
    server.await.unwrap();
}

#[tokio::test]
async fn interleaved_tool_calls_keep_ids_arguments_and_order() {
    let values = vec![
        json!({"type":"response.output_item.added","item":{"id":"item-a","type":"function_call","call_id":"call-a","name":"first"}}),
        json!({"type":"response.output_item.added","item":{"id":"item-b","type":"function_call","call_id":"call-b","name":"second"}}),
        json!({"type":"response.function_call_arguments.delta","item_id":"item-b","delta":"{\"b\":2}"}),
        json!({"type":"response.function_call_arguments.delta","item_id":"item-a","delta":"{\"a\":1}"}),
        json!({"type":"response.output_item.done","item":{"id":"item-b","type":"function_call","call_id":"call-b","arguments":"{\"b\":2}"}}),
        json!({"type":"response.output_item.done","item":{"id":"item-a","type":"function_call","call_id":"call-a","arguments":"{\"a\":1}"}}),
        json!({"type":"response.completed","response":{"usage":{"input_tokens":20,"output_tokens":5}}}),
    ];
    let (endpoint, _requests, server) = server(vec![(
        200,
        json!({"content-type":"text/event-stream"}),
        sse(&values),
    )])
    .await;
    let mut session = HttpSession::new(
        "session".into(),
        config(ProviderKind::Responses, endpoint),
        vec![],
    )
    .await
    .unwrap();
    let events = collect(
        &mut session,
        RunRequest::default(),
        CancellationToken::new(),
    )
    .await;
    let mut result = Accumulator::default();
    for e in &events {
        result.add(e);
    }
    assert!(
        matches!(&result.committed[0],Block::ToolCall { call_id,arguments,.. } if call_id=="call-a" && arguments=="{\"a\":1}")
    );
    assert!(
        matches!(&result.committed[1],Block::ToolCall { call_id,arguments,.. } if call_id=="call-b" && arguments=="{\"b\":2}")
    );
    assert!(matches!(
        events.last(),
        Some(Event::Done {
            outcome: Outcome::ToolCall { .. }
        })
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn recorded_quota_failure_is_terminal_without_retry() {
    let fixture: Value = serde_json::from_str(include_str!(
        "vendors/fixtures/codex-usage-limit-reached-429.json"
    ))
    .unwrap();
    let (endpoint, _requests, server) = server(vec![(
        fixture["status"].as_u64().unwrap() as u16,
        fixture["headers"].clone(),
        serde_json::to_vec(&fixture["body"]).unwrap(),
    )])
    .await;
    let mut session = HttpSession::new(
        "session".into(),
        config(ProviderKind::Responses, endpoint),
        vec![],
    )
    .await
    .unwrap();
    let events = collect(
        &mut session,
        RunRequest::default(),
        CancellationToken::new(),
    )
    .await;
    assert!(!events.iter().any(|e| matches!(e, Event::Retrying { .. })));
    assert!(
        matches!(events.last(),Some(Event::Done { outcome:Outcome::Error { error } }) if error.kind==ErrorKind::OutOfTokens)
    );
    server.await.unwrap();
}

#[tokio::test]
async fn cancelled_stream_emits_one_terminal_event_and_never_commits() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (connected, connection) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 8192];
        assert!(socket.read(&mut bytes).await.unwrap() > 0);
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
        connected.send(()).unwrap();
        let mut bytes = [0; 1];
        let _ = socket.read(&mut bytes).await;
    });
    let mut session = HttpSession::new(
        "session".into(),
        config(ProviderKind::Responses, format!("http://{address}")),
        vec![],
    )
    .await
    .unwrap();
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let canceller = tokio::spawn(async move {
        connection.await.unwrap();
        token.cancel();
    });
    let events = tokio::time::timeout(
        Duration::from_secs(2),
        collect(&mut session, RunRequest::default(), cancel),
    )
    .await
    .unwrap();
    canceller.await.unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, Event::Done { .. }))
            .count(),
        1
    );
    assert!(matches!(
        events.last(),
        Some(Event::Done {
            outcome: Outcome::Cancelled
        })
    ));
    assert!(!events.contains(&Event::BlockStop));
    task.abort();
}

#[tokio::test]
async fn anthropic_signed_thinking_and_cache_tokens_survive() {
    let values = vec![
        json!({"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":6,"cache_creation_input_tokens":2}}}),
        json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}),
        json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed-payload"}}),
        json!({"type":"content_block_stop","index":0}),
        json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
        json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}),
        json!({"type":"content_block_stop","index":1}),
        json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}),
        json!({"type":"message_stop"}),
    ];
    let (endpoint, mut requests, server) = server(vec![(
        200,
        json!({"content-type":"text/event-stream"}),
        sse(&values),
    )])
    .await;
    let mut session = HttpSession::new(
        "session".into(),
        config(ProviderKind::Claude, endpoint),
        vec![],
    )
    .await
    .unwrap();
    let events = collect(
        &mut session,
        RunRequest {
            context: SessionContext {
                instructions: "system".into(),
                messages: vec![Message::user("hello")],
            },
            ..Default::default()
        },
        CancellationToken::new(),
    )
    .await;
    let mut result = Accumulator::default();
    for event in &events {
        result.add(event);
    }
    assert!(
        matches!(&result.committed[0],Block::Reasoning { reasoning:Some(signature),.. } if signature=="signed-payload")
    );
    assert!(events.iter().any(|e|matches!(e,Event::TokenUsage { usage } if usage.input==12 && usage.cache_read==6 && usage.output==7)));
    assert_eq!(
        requests.recv().await.unwrap()["messages"][0]["content"][0]["cache_control"]["type"],
        "ephemeral"
    );
    server.await.unwrap();
}

#[tokio::test]
async fn chat_completions_continues_through_usage_after_finish_reason() {
    let mut body = sse(&[
        json!({"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}),
        json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}),
        json!({"choices":[],"usage":{"prompt_tokens":15,"completion_tokens":2}}),
    ]);
    body.extend_from_slice(b"data: [DONE]\n\n");
    let (endpoint, _requests, server) = server(vec![(
        200,
        json!({"content-type":"text/event-stream"}),
        body,
    )])
    .await;
    let mut config = config(ProviderKind::Kimi, endpoint);
    config.bedrock = Some(BedrockTransport::Runtime);
    let mut session = HttpSession::new("session".into(), config, vec![])
        .await
        .unwrap();
    let events = collect(
        &mut session,
        RunRequest::default(),
        CancellationToken::new(),
    )
    .await;
    assert!(
        matches!(events.last(),Some(Event::Done { outcome:Outcome::Normal { usage } }) if usage.input==15)
    );
    server.await.unwrap();
}
