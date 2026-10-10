use super::*;
use super::super::ConfigModule;
use serde_json::json;
use std::{sync::atomic::{AtomicUsize,Ordering},time::Duration};
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};

struct Server {url:String,count:Arc<AtomicUsize>,task:tokio::task::JoinHandle<()>}
impl Drop for Server {fn drop(&mut self){self.task.abort();}}
async fn server(status:u16,body:String)->Server {
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}",listener.local_addr().unwrap());
    let count=Arc::new(AtomicUsize::new(0));let requests=count.clone();
    let task=tokio::spawn(async move {loop {
        let (mut socket,_)=listener.accept().await.unwrap();let mut received=Vec::new();let mut buffer=[0u8;4096];
        let header_end=loop {let bytes=socket.read(&mut buffer).await.unwrap();if bytes==0{return;}received.extend_from_slice(&buffer[..bytes]);assert!(received.len()<=1024*1024);if let Some(end)=received.windows(4).position(|bytes|bytes==b"\r\n\r\n"){break end+4;}};
        let length=std::str::from_utf8(&received[..header_end]).unwrap().lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length: ").and_then(|value|value.parse::<usize>().ok())).unwrap();
        assert!(length<=1024*1024);while received.len()<header_end+length {let bytes=socket.read(&mut buffer).await.unwrap();assert!(bytes>0);received.extend_from_slice(&buffer[..bytes]);}
        let request:Value=serde_json::from_slice(&received[header_end..header_end+length]).unwrap();assert_eq!(request["model"],"gpt-5.6-sol");
        requests.fetch_add(1,Ordering::SeqCst);
        let response=format!("HTTP/1.1 {status} OK\r\nConnection: close\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}",body.len());socket.write_all(response.as_bytes()).await.unwrap();
    }});
    Server {url,count,task}
}
fn sse(events:&[Value])->String {events.iter().map(|event|format!("data: {event}\n\n")).collect()}
fn success()->String {sse(&[json!({"type":"response.content_part.added","part":{"type":"output_text"}}),json!({"type":"response.output_text.delta","delta":"ready"}),json!({"type":"response.output_text.done"}),json!({"type":"response.completed","response":{"id":"response","output":[],"usage":{"input_tokens":1,"output_tokens":1}}})])}
fn config(home:&std::path::Path,first:&str,second:&str)->ConfigModule {
    let mut config=ConfigModule::isolated(home).unwrap();config.values=toml::Value::try_from(json!({
        "defaults":{"provider":"pool","model":"openai/gpt-5.6-sol"},"settings":{"inference_max_retries":0},
        "providers":{"first":{"type":"codex","enabled":true,"api_key":"synthetic-placeholder","base_url":first,"transport":"sse"},"second":{"type":"codex","enabled":true,"api_key":"synthetic-placeholder","base_url":second,"transport":"sse"},"pool":{"type":"smart","enabled":true,"providers":["first","second"]}}
    })).unwrap();config
}
async fn session(config:&ConfigModule,agent:&str)->Box<dyn Session> {
    let session=config.session(agent,&json!({}),Vec::new()).await.unwrap();
    config.route_states.lock().unwrap().get(&("pool".to_owned(),"openai/gpt-5.6-sol".to_owned(),agent.to_owned())).unwrap().lock().unwrap().current=0;session
}
async fn collect(session:&mut dyn Session)->Vec<Event> {
    tokio::time::timeout(Duration::from_secs(5),async {
        let(sender,mut receiver)=mpsc::channel(64);let run=session.run(RunRequest {context:SessionContext {instructions:String::new(),messages:vec![happy_providers::Message::user("hello")]},..Default::default()},CancellationToken::new(),sender);tokio::pin!(run);let mut complete=false;let mut events=Vec::new();loop {tokio::select!{_=&mut run,if !complete=>complete=true,event=receiver.recv()=>match event{Some(event)=>events.push(event),None=>break}}}events
    }).await.unwrap()
}
#[tokio::test]
async fn smart_authentication_failure_switches_before_visibility_and_stays_failed_across_sessions() {
    let failed=server(401,"{\"error\":{\"message\":\"unauthorized\"}}".to_owned()).await;let ready=server(200,success()).await;let directory=tempfile::tempdir().unwrap();let config=config(directory.path(),&failed.url,&ready.url);
    let mut first=session(&config,"sticky").await;let events=collect(first.as_mut()).await;
    assert!(events.iter().any(|event|matches!(event,Event::TextDelta {delta} if delta=="ready")));assert!(matches!(events.last(),Some(Event::Done {outcome:Outcome::Normal {..}})));assert_eq!(failed.count.load(Ordering::SeqCst),1);assert_eq!(ready.count.load(Ordering::SeqCst),1);
    first.destroy().await;let mut second=config.session("sticky",&json!({}),Vec::new()).await.unwrap();let events=collect(second.as_mut()).await;assert!(matches!(events.last(),Some(Event::Done {outcome:Outcome::Normal {..}})));assert_eq!(failed.count.load(Ordering::SeqCst),1);assert_eq!(ready.count.load(Ordering::SeqCst),2);second.destroy().await;
}
#[tokio::test]
async fn smart_never_replays_visible_output_or_an_ordinary_provider_failure() {
    let ready=server(200,success()).await;
    for (index,status,body,visible) in [
        (0,200,sse(&[json!({"type":"response.content_part.added","part":{"type":"output_text"}}),json!({"type":"response.output_text.delta","delta":"already visible"}),json!({"type":"error","status":401,"error":{"message":"unauthorized"}})]),true),
        (1,400,"{\"error\":{\"message\":\"invalid request\"}}".to_owned(),false),
    ] {
        let failed=server(status,body).await;let directory=tempfile::tempdir().unwrap();let config=config(directory.path(),&failed.url,&ready.url);let mut routed=session(&config,&format!("visible{index}")).await;let events=collect(routed.as_mut()).await;
        assert_eq!(events.iter().any(|event|matches!(event,Event::TextDelta {delta} if delta=="already visible")),visible);assert!(matches!(events.last(),Some(Event::Done {outcome:Outcome::Error {..}})));assert_eq!(failed.count.load(Ordering::SeqCst),1);assert_eq!(ready.count.load(Ordering::SeqCst),0);routed.destroy().await;
    }
}
#[tokio::test]
async fn frozen_voice_route_keeps_its_account_and_observes_both_disable_boundaries() {
    let directory=tempfile::tempdir().unwrap();let config=config(directory.path(),"https://api.openai.com","https://api.openai.com");
    let route=config.live_controller_route().await.unwrap();let selected=route.provider_id.clone();let other=if selected=="first"{"second"}else{"first"};config.set_provider_enabled(other,false).unwrap();assert_eq!(route.provider_id,selected);assert!(!route.signal.is_cancelled());
    config.set_provider_enabled("pool",false).unwrap();tokio::time::timeout(Duration::from_secs(1),route.signal.cancelled()).await.unwrap();config.set_provider_enabled("pool",true).unwrap();
    let next=config.live_controller_route().await.unwrap();assert_eq!(next.provider_id,selected);config.set_provider_enabled(&selected,false).unwrap();tokio::time::timeout(Duration::from_secs(1),next.signal.cancelled()).await.unwrap();assert!(config.live_controller_route().await.is_err());
}