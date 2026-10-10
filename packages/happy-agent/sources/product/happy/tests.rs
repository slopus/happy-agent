use super::socket::{Event, Socket};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{net::TcpListener, sync::mpsc};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use tokio_util::sync::CancellationToken;

struct Relay {
    server: String,
    requests: mpsc::Receiver<(String, Value)>,
    stop: CancellationToken,
    task: tokio::task::JoinHandle<()>,
    mode: Arc<AtomicU8>,
    controls: tokio::sync::broadcast::Sender<(usize, String)>,
    delayed: mpsc::Receiver<(usize, String, Value)>,
    dedicated: Arc<AtomicUsize>,
}
impl Relay {
    async fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        let (send, requests) = mpsc::channel(4096);
        let stop = CancellationToken::new();
        let cancel = stop.clone();
        let mode = Arc::new(AtomicU8::new(0));
        let modes = mode.clone();
        let (controls, _) = tokio::sync::broadcast::channel::<(usize, String)>(256);
        let controller = controls.clone();
        let (delay_send, delayed) = mpsc::channel(128);
        let dedicated = Arc::new(AtomicUsize::new(0));
        let count = dedicated.clone();
        let task = tokio::spawn(async move {
            let mut peers = tokio::task::JoinSet::new();
            let mut id = 0;
            loop {
                tokio::select! {_=cancel.cancelled()=>break,accepted=listener.accept()=>{let(stream,_)=accepted.unwrap();let send=send.clone();let modes=modes.clone();let mut control=controller.subscribe();let delays=delay_send.clone();let count=count.clone();id+=1;let connection=id;peers.spawn(async move{
                    let mut wire=match accept_async(stream).await {Ok(wire)=>wire,Err(tokio_tungstenite::tungstenite::Error::Protocol(tokio_tungstenite::tungstenite::error::ProtocolError::HandshakeIncomplete))=>return,Err(error)=>panic!("{error}")};wire.send(Message::Text(r#"0{"sid":"fixture","upgrades":[],"pingInterval":25000,"pingTimeout":20000}"#.into())).await.unwrap();
                    let auth=wire.next().await.unwrap().unwrap().into_text().unwrap();let auth:Value=serde_json::from_str(auth.strip_prefix("40").unwrap()).unwrap();let dedicated=auth["clientType"]=="session-scoped";if dedicated{assert!(count.fetch_add(1,Ordering::SeqCst)<64,"The relay received more than 64 dedicated sockets.");}send.send(("auth".into(),auth)).await.unwrap();wire.send(Message::Text(r#"40{"sid":"fixture"}"#.into())).await.unwrap();
                    loop {let frame=tokio::select!{frame=wire.next()=>frame,command=control.recv()=>{if let Ok((target,text))=command{if target==connection{if text=="close"{break;}if wire.send(Message::Text(text.into())).await.is_err(){break;}}}continue;}};let Some(Ok(frame))=frame else{break;};if frame.is_close(){break;}if !frame.is_text(){continue;}let text=frame.into_text().unwrap();let Some(packet)=text.strip_prefix("42") else {continue;};let index=packet.find('[').unwrap();let id=&packet[..index];let args:Value=serde_json::from_str(&packet[index..]).unwrap();let name=args[0].as_str().unwrap();let value=args[1].clone();send.send((name.into(),value.clone())).await.unwrap();
                        if name=="session-subscribe"{let sids=value["sids"].as_array().unwrap();assert!(sids.len()<=500);match modes.load(Ordering::SeqCst){1=>{wire.send(Message::Text(format!("43{id}{}",json!([{"result":"error","reason":"unsupported-client"}])).into())).await.unwrap();},2=>(),4=>{delays.send((connection,id.into(),value)).await.unwrap();},_=>{wire.send(Message::Text(format!("43{id}{}",json!([{"result":"success","subscribed":sids,"missing":[]}])).into())).await.unwrap();}}}
                        else if name=="update-metadata"{wire.send(Message::Text(format!("43{id}{}",json!([{"result":"success","version":1}])).into())).await.unwrap();}
                        else if name=="drop" {break;}
                        else if name=="route" {wire.send(Message::Text(format!("42{}",json!(["update",{"body":{"t":"update-session","id":value["sid"],"metadata":"opaque"}}])).into())).await.unwrap();}
                        else if name=="rpc" {wire.send(Message::Text(format!("42123{}",json!(["rpc-request",{"method":format!("{}:readFile",value["sid"].as_str().unwrap()),"params":"opaque"}])).into())).await.unwrap();}
                    }
                    if dedicated{count.fetch_sub(1,Ordering::SeqCst);}
                });},joined=peers.join_next(),if !peers.is_empty()=>{joined.unwrap().unwrap();}}
            }
            peers.abort_all();
            while let Some(joined) = peers.join_next().await {
                if let Err(error) = joined {
                    assert!(error.is_cancelled(), "{error}");
                }
            }
        });
        Self {
            server,
            requests,
            stop,
            task,
            mode,
            controls,
            delayed,
            dedicated,
        }
    }
    async fn next(&mut self) -> (String, Value) {
        tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .unwrap()
            .unwrap()
    }
    async fn close(self) {
        self.stop.cancel();
        self.task.await.unwrap();
    }
    async fn delayed(&mut self) -> (usize, String, Value) {
        tokio::time::timeout(Duration::from_secs(3), self.delayed.recv())
            .await
            .unwrap()
            .unwrap()
    }
    fn answer(&self, (connection, id, value): (usize, String, Value)) {
        self.controls
            .send((
                connection,
                format!(
                    "43{id}{}",
                    json!([{"result":"success","subscribed":value["sids"],"missing":[]}])
                ),
            ))
            .unwrap();
    }
}

#[tokio::test]
async fn relay_drop_settles_an_unanswered_request_before_the_timeout() {
    let mut relay = Relay::start().await;
    let socket = Socket::connect(
        &relay.server,
        json!({"clientType":"machine-scoped","machineId":"machine","token":"fixture"}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(relay.next().await.0, "auth");
    let mut events = socket.subscribe();
    let owed = socket.clone();
    let request = tokio::spawn(async move { owed.request("unanswered", json!({})).await });
    assert_eq!(relay.next().await.0, "unanswered");
    socket.emit("drop", json!({})).await.unwrap();
    assert_eq!(relay.next().await.0, "drop");
    assert!(
        tokio::time::timeout(Duration::from_millis(500), request)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("disconnected")
    );
    assert!(matches!(
        tokio::time::timeout(Duration::from_millis(500), events.recv())
            .await
            .unwrap()
            .unwrap(),
        Event::Disconnected
    ));
    socket.close().await;
    relay.close().await;
}

impl Relay {
    async fn subscriptions(&mut self, count: usize) {
        let mut observed = 0;
        while observed < count {
            let (name, value) = self.next().await;
            assert_eq!(name, "session-subscribe");
            observed += value["sids"].as_array().unwrap().len();
        }
        assert_eq!(observed, count);
    }
}

#[tokio::test]
async fn one_machine_connection_carries_seventy_sessions_and_routes_only_the_named_room() {
    use super::sessions::{Descriptor, Event as SessionEvent, SessionSockets, Transport};
    let mut relay = Relay::start().await;
    let cancel = CancellationToken::new();
    let sessions = SessionSockets::new(
        relay.server.clone(),
        "fixture".into(),
        "test".into(),
        cancel.clone(),
    )
    .unwrap();
    let socket = Socket::connect(
        &relay.server,
        json!({"clientType":"machine-scoped","machineId":"machine","token":"fixture"}),
        cancel,
    )
    .await
    .unwrap();
    assert_eq!(relay.next().await.0, "auth");
    sessions.machine_connected(socket.clone()).await.unwrap();
    assert_eq!(
        sessions.first_transport().await,
        Some(Transport::Multiplexed)
    );
    assert_eq!(
        relay.next().await,
        ("session-subscribe".into(), json!({"sids":[]}))
    );
    let mut links = Vec::new();
    for index in 0..70 {
        let link = sessions
            .open(
                Descriptor {
                    remote: format!("remote-{index}"),
                    agent: format!("agent-{index}"),
                    bot: true,
                    updated: index,
                },
                false,
            )
            .await
            .unwrap()
            .unwrap();
        links.push(link);
    }
    for (_, events) in &mut links {
        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(3), events.recv())
                .await
                .unwrap()
                .unwrap(),
            SessionEvent::Connected
        ));
    }
    relay.subscriptions(70).await;
    socket
        .emit("route", json!({"sid":"remote-4"}))
        .await
        .unwrap();
    assert_eq!(relay.next().await.0, "route");
    assert!(
        matches!(tokio::time::timeout(Duration::from_secs(2),links[4].1.recv()).await.unwrap().unwrap(),SessionEvent::Update(value) if value["body"]["id"]=="remote-4")
    );
    assert!(links[5].1.try_recv().is_err());
    assert_eq!(
        links[4]
            .0
            .request(
                "update-metadata",
                json!({"sid":"remote-4","expectedVersion":0,"metadata":"opaque"})
            )
            .await
            .unwrap(),
        json!({"result":"success","version":1})
    );
    assert_eq!(relay.next().await.0, "update-metadata");
    sessions.close().await;
    socket.close().await;
    relay.close().await;
}

async fn machine(relay: &mut Relay, sessions: &super::sessions::SessionSockets) -> Arc<Socket> {
    let socket = Socket::connect(
        &relay.server,
        json!({"clientType":"machine-scoped","machineId":"machine","token":"fixture"}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(relay.next().await.0, "auth");
    sessions.machine_connected(socket.clone()).await.unwrap();
    socket
}
fn descriptor(index: u64, bot: bool) -> super::sessions::Descriptor {
    super::sessions::Descriptor {
        remote: format!("remote-{index}"),
        agent: format!("agent-{index:04}"),
        bot,
        updated: index,
    }
}
async fn connected(events: &mut mpsc::Receiver<super::sessions::Event>) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(
                events.recv().await.unwrap(),
                super::sessions::Event::Connected
            ) {
                break;
            }
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn leaving_a_room_cancels_its_answer_without_closing_the_machine() {
    use super::sessions::SessionSockets;
    let mut relay = Relay::start().await;
    let sessions = SessionSockets::new(
        relay.server.clone(),
        "fixture".into(),
        "test".into(),
        CancellationToken::new(),
    )
    .unwrap();
    let socket = machine(&mut relay, &sessions).await;
    sessions.first_transport().await;
    relay.next().await;
    let (link, mut events) = sessions
        .open(descriptor(0, true), false)
        .await
        .unwrap()
        .unwrap();
    let link = Arc::new(link);
    connected(&mut events).await;
    relay.next().await;
    let owed = link.clone();
    let request =
        tokio::spawn(async move { owed.request("unanswered", json!({"sid":"remote-0"})).await });
    assert_eq!(relay.next().await.0, "unanswered");
    link.unsubscribe().await;
    assert!(
        tokio::time::timeout(Duration::from_millis(500), request)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(!socket.stopped());
    assert_eq!(relay.next().await.0, "session-unsubscribe");
    assert!(socket.request("update-metadata", json!({})).await.is_ok());
    relay.next().await;
    sessions.close().await;
    socket.close().await;
    relay.close().await;
}

#[tokio::test]
async fn a_delayed_subscription_answer_cannot_connect_a_reopened_session() {
    use super::sessions::SessionSockets;
    let mut relay = Relay::start().await;
    let sessions = SessionSockets::new(
        relay.server.clone(),
        "fixture".into(),
        "test".into(),
        CancellationToken::new(),
    )
    .unwrap();
    let socket = machine(&mut relay, &sessions).await;
    sessions.first_transport().await;
    relay.next().await;
    relay.mode.store(4, Ordering::SeqCst);
    let (old, mut old_events) = sessions
        .open(descriptor(0, true), false)
        .await
        .unwrap()
        .unwrap();
    let old_answer = relay.delayed().await;
    assert!(!old.connected());
    old.unsubscribe().await;
    let (new, mut new_events) = sessions
        .open(descriptor(0, true), false)
        .await
        .unwrap()
        .unwrap();
    let new_answer = relay.delayed().await;
    relay.answer(old_answer);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), new_events.recv())
            .await
            .is_err()
    );
    assert!(!new.connected());
    assert!(new_events.try_recv().is_err());
    assert!(!matches!(
        old_events.try_recv(),
        Ok(super::sessions::Event::Connected)
    ));
    relay.answer(new_answer);
    connected(&mut new_events).await;
    assert!(new.connected());
    sessions.close().await;
    socket.close().await;
    relay.close().await;
}

#[tokio::test]
async fn reconnect_subscriptions_are_batched_at_the_relays_five_hundred_room_limit() {
    use super::sessions::SessionSockets;
    let mut relay = Relay::start().await;
    let sessions = SessionSockets::new(
        relay.server.clone(),
        "fixture".into(),
        "test".into(),
        CancellationToken::new(),
    )
    .unwrap();
    let first = machine(&mut relay, &sessions).await;
    sessions.first_transport().await;
    relay.next().await;
    let mut links = Vec::new();
    for index in 0..1305 {
        links.push(
            sessions
                .open(descriptor(index, true), false)
                .await
                .unwrap()
                .unwrap(),
        );
    }
    for (_, events) in &mut links {
        connected(events).await;
    }
    relay.subscriptions(1305).await;
    first.close().await;
    let second = machine(&mut relay, &sessions).await;
    let mut subscribed = Vec::new();
    for _ in 0..3 {
        let (name, value) = relay.next().await;
        assert_eq!(name, "session-subscribe");
        let sids = value["sids"].as_array().unwrap();
        assert!(sids.len() <= 500);
        subscribed.extend(sids.iter().cloned());
    }
    assert_eq!(subscribed.len(), 1305);
    let identities = subscribed
        .iter()
        .map(|sid| sid.as_str().unwrap())
        .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(identities.len(), 1305);
    for (_, events) in &mut links {
        connected(events).await;
    }
    sessions.close().await;
    second.close().await;
    relay.close().await;
}

#[tokio::test]
async fn a_relay_without_the_subscription_handler_falls_back_after_five_seconds() {
    use super::sessions::{SessionSockets, Transport};
    let mut relay = Relay::start().await;
    relay.mode.store(2, Ordering::SeqCst);
    let sessions = SessionSockets::new(
        relay.server.clone(),
        "fixture".into(),
        "test".into(),
        CancellationToken::new(),
    )
    .unwrap();
    let start = tokio::time::Instant::now();
    let socket = machine(&mut relay, &sessions).await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(6), sessions.first_transport())
            .await
            .unwrap(),
        Some(Transport::Dedicated)
    );
    assert!(start.elapsed() >= Duration::from_secs(5));
    assert_eq!(relay.next().await.0, "session-subscribe");
    let (link, mut events) = sessions
        .open(descriptor(0, true), false)
        .await
        .unwrap()
        .unwrap();
    connected(&mut events).await;
    assert!(link.connected());
    assert_eq!(relay.next().await.0, "auth");
    sessions.close().await;
    socket.close().await;
    relay.close().await;
}

#[tokio::test]
async fn reconnecting_to_an_older_relay_contracts_before_dedicated_sockets_open_and_restores_on_upgrade()
 {
    use super::sessions::{SessionSockets, Transport};
    let mut relay = Relay::start().await;
    let sessions = SessionSockets::new(
        relay.server.clone(),
        "fixture".into(),
        "test".into(),
        CancellationToken::new(),
    )
    .unwrap();
    let first = machine(&mut relay, &sessions).await;
    sessions.first_transport().await;
    relay.next().await;
    let mut links = Vec::new();
    for index in 0..70 {
        let link = sessions
            .open(descriptor(index, index < 10), false)
            .await
            .unwrap()
            .unwrap();
        links.push(link);
    }
    for (_, events) in &mut links {
        connected(events).await;
    }
    relay.subscriptions(70).await;
    first.close().await;
    relay.mode.store(1, Ordering::SeqCst);
    let older = machine(&mut relay, &sessions).await;
    assert_eq!(relay.next().await.0, "session-subscribe");
    let mut dedicated = Vec::new();
    for _ in 0..64 {
        let (name, auth) = relay.next().await;
        assert_eq!(name, "auth");
        assert_eq!(auth["clientType"], "session-scoped");
        dedicated.push(auth["sessionId"].as_str().unwrap().to_owned());
    }
    assert_eq!(sessions.latest_transport(), Some(Transport::Dedicated));
    assert_eq!(relay.dedicated.load(Ordering::SeqCst), 64);
    for index in 0..10 {
        assert!(
            dedicated.contains(&format!("remote-{index}")),
            "An old bot keeps priority over a project."
        );
    }
    for index in 10..16 {
        assert!(!dedicated.contains(&format!("remote-{index}")));
    }
    for (index, (_, events)) in links.iter_mut().enumerate() {
        if !(10..16).contains(&index) {
            connected(events).await;
        }
    }
    older.close().await;
    relay.mode.store(0, Ordering::SeqCst);
    let current = machine(&mut relay, &sessions).await;
    assert_eq!(relay.next().await.0, "session-subscribe");
    for (_, events) in &mut links {
        connected(events).await;
    }
    assert_eq!(sessions.latest_transport(), Some(Transport::Multiplexed));
    tokio::time::timeout(Duration::from_secs(3), async {
        while relay.dedicated.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(links.iter().all(|(link, _)| link.connected()));
    sessions.close().await;
    current.close().await;
    relay.close().await;
}

#[tokio::test]
async fn an_older_relay_keeps_sixty_four_bots_and_a_new_project_cannot_replace_them() {
    use super::sessions::{SessionSockets, Transport};
    let mut relay = Relay::start().await;
    relay.mode.store(1, Ordering::SeqCst);
    let sessions = SessionSockets::new(
        relay.server.clone(),
        "fixture".into(),
        "test".into(),
        CancellationToken::new(),
    )
    .unwrap();
    let socket = machine(&mut relay, &sessions).await;
    assert_eq!(sessions.first_transport().await, Some(Transport::Dedicated));
    relay.next().await;
    let mut links = Vec::new();
    for index in 0..64 {
        links.push(
            sessions
                .open(descriptor(index, true), false)
                .await
                .unwrap()
                .unwrap(),
        );
    }
    for (_, events) in &mut links {
        connected(events).await;
    }
    for _ in 0..64 {
        relay.next().await;
    }
    assert!(
        sessions
            .open(descriptor(65, false), true)
            .await
            .unwrap()
            .is_none()
    );
    let (new, mut events) = sessions
        .open(descriptor(66, true), true)
        .await
        .unwrap()
        .unwrap();
    connected(&mut events).await;
    assert!(!links[0].0.connected());
    assert!(new.connected());
    assert_eq!(relay.next().await.0, "auth");
    assert_eq!(relay.dedicated.load(Ordering::SeqCst), 64);
    sessions.close().await;
    socket.close().await;
    relay.close().await;
}
