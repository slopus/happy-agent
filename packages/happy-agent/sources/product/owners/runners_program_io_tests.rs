//! Cancellation may interrupt wire delivery after EOF was logically accepted.
use super::*;
use crate::product::owners::runners::server::tests::Graph;
use std::collections::HashMap;
use tokio::sync::mpsc;

#[tokio::test]
async fn an_eof_cancelled_while_waiting_for_a_channel_slot_is_delivered_on_retry() {
    let graph = Graph::new().await;
    let (sender, mut receiver) = mpsc::channel(1);
    let session = Arc::new(Session {
        sender,
        cancel: CancellationToken::new(),
        requests: Mutex::new(HashMap::new()),
        streams: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        next_stream: Arc::new(AtomicU64::new(1)),
        identity: graph.fixture.config.runner_identity().unwrap(),
        product: AsyncMutex::new(true),
        tunnel: AsyncMutex::new(None),
    });
    let program = Arc::new(RunnerProgram {
        owner: Arc::downgrade(&graph.runners),
        runner: "fixture".into(),
        id: 1,
        stream: 1,
        state: Mutex::new(State {
            phase: Phase::Running,
            connection: Connection::Connected(session.clone()),
            sent: 0,
            acknowledged: 0,
            retained: VecDeque::new(),
            input_ended: false,
            output: [Output::new(), Output::new()],
        }),
        writer: AsyncMutex::new(()),
        writes: CancellationToken::new(),
        startup: CancellationToken::new(),
        progress: watch::channel(0).0,
        sequence: AtomicU64::new(0),
    });
    session
        .sender
        .try_send(
            graph
                .runners
                .frame(json!({"type":"ping","nonce":1}), &[])
                .unwrap(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let mut ending = Box::pin(program.end_input(&cancel));
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            assert!(futures_util::poll!(&mut ending).is_pending());
            if program.state.lock().unwrap().input_ended {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    cancel.cancel();
    assert!(ending.await.is_err());
    let (queued, _) = graph.runners.receive(&mut receiver).await.unwrap();
    assert_eq!(queued["type"], "ping");
    program.end_input(&CancellationToken::new()).await.unwrap();
    let (eof, body) =
        tokio::time::timeout(Duration::from_secs(1), graph.runners.receive(&mut receiver))
            .await
            .expect("Retry must deliver the accepted EOF once a channel slot is available.")
            .unwrap();
    assert_eq!(
        eof,
        json!({"type":"eof","stream":1,"channel":"in","offset":0})
    );
    assert!(body.is_empty());
    program.lost("The framing test finished.");
    graph.close().await;
}
