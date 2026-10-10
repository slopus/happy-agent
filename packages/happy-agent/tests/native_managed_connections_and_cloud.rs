#![cfg(unix)]
use bytes::Bytes;
use futures_util::{stream, StreamExt};
use http_body_util::{BodyExt, Full, StreamBody, combinators::UnsyncBoxBody};
use hyper::{Request, Response, body::{Frame, Incoming}, service::service_fn};
use serde_json::{Value, json};
use std::{path::{Path, PathBuf}, process::Command, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, sync::mpsc};
use tokio_util::sync::CancellationToken;
type Body = UnsyncBoxBody<Bytes, anyhow::Error>;

struct Installation { directory: tempfile::TempDir, home: PathBuf, carrier: PathBuf, client: reqwest::Client, token: String }
impl Installation {
    fn start(port:u16)->Self {
        use std::os::unix::fs::PermissionsExt;
        let scratch=Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.context").canonicalize().unwrap();
        let directory=tempfile::Builder::new().prefix("").rand_bytes(2).tempdir_in(scratch).unwrap();let home=directory.path().join(".happy");
        let carrier=directory.path().join("tailcat-fixture");
        std::fs::write(&carrier,r#"#!/usr/bin/python3
import socket,sys,threading,select
assert sys.argv[1:4]==['--key=new','socks','--listen=127.0.0.1:0']
listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(64)
print('SOCKS running at socks5h://127.0.0.1:'+str(listener.getsockname()[1]),flush=True)
def exact(c,n):
    value=b''
    while len(value)<n:
        chunk=c.recv(n-len(value))
        if not chunk: raise RuntimeError('closed')
        value+=chunk
    return value
def serve(c):
    upstream=None
    try:
        assert exact(c,3)==bytes([5,1,0]);c.sendall(bytes([5,0]))
        header=exact(c,5);assert header[:4]==bytes([5,1,0,3]);assert exact(c,header[4])==b'server.tailcat'
        port=int.from_bytes(exact(c,2),'big');upstream=socket.create_connection(('127.0.0.1',port),timeout=5);upstream.settimeout(None)
        c.sendall(bytes([5,0,0,1,127,0,0,1,0,0]))
        while True:
            ready,_,_=select.select([c,upstream],[],[])
            for origin in ready:
                chunk=origin.recv(8192)
                if not chunk:return
                (upstream if origin is c else c).sendall(chunk)
    finally:
        c.close()
        if upstream:upstream.close()
while True:
    c,_=listener.accept();threading.Thread(target=serve,args=(c,),daemon=True).start()
"#).unwrap();std::fs::set_permissions(&carrier,std::fs::Permissions::from_mode(0o700)).unwrap();
        let public=directory.path().join(if cfg!(target_os="macos"){"Happy/Config"}else{"happy/config"});std::fs::create_dir_all(&public).unwrap();
        std::fs::write(public.join("happy.toml"),format!("[providers]\ndefault_enable = false\n[connections.zulu]\nname='Zulu'\naddress='tcfixture'\nport={port}\ntoken='{}'\n[connections.alpha]\nname='Alpha'\naddress='tcfixture'\nport={port}\ntoken='{}'\n","r".repeat(43),"s".repeat(43))).unwrap();
        let output=Command::new(env!("CARGO_BIN_EXE_happy-agent")).arg("start").env("HAPPY_HOME_DIR",&home).env("HAPPY_AGENT_TAILCAT_PATH",&carrier).output().unwrap();
        assert!(output.status.success(),"{}\n{}",String::from_utf8_lossy(&output.stderr),std::fs::read_to_string(home.join("agent/daemon.log")).unwrap_or_default());
        let token=std::fs::read_to_string(home.join("agent/token")).unwrap().trim().to_owned();let client=reqwest::Client::builder().unix_socket(home.join("agent/server.sock")).timeout(Duration::from_secs(10)).build().unwrap();
        Self{directory,home,carrier,client,token}
    }
    fn call(&self,method:reqwest::Method,path:&str)->reqwest::RequestBuilder {self.client.request(method,format!("http://happy{path}")).bearer_auth(&self.token)}
    async fn get(&self,path:&str)->Value {let response=self.call(reqwest::Method::GET,path).send().await.unwrap();assert_eq!(response.status(),200);response.json().await.unwrap()}
    fn restart(&self) {self.command("stop");self.command("start");}
    fn command(&self,verb:&str) {let output=Command::new(env!("CARGO_BIN_EXE_happy-agent")).arg(verb).env("HAPPY_HOME_DIR",&self.home).env("HAPPY_AGENT_TAILCAT_PATH",&self.carrier).output().unwrap();assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));}
}
impl Drop for Installation {fn drop(&mut self){let _=Command::new(env!("CARGO_BIN_EXE_happy-agent")).arg("stop").env("HAPPY_HOME_DIR",&self.home).output();}}
struct Upstream {port:u16,requests:mpsc::Receiver<Value>,stop:CancellationToken,task:tokio::task::JoinHandle<()>}
impl Upstream {
    async fn start()->Self {
        let listener=TcpListener::bind(("127.0.0.1",0)).await.unwrap();let port=listener.local_addr().unwrap().port();let(requests,receiver)=mpsc::channel(128);let stop=CancellationToken::new();let cancellation=stop.clone();
        let task=tokio::spawn(async move {let mut connections=tokio::task::JoinSet::new();loop{tokio::select!{biased;_=cancellation.cancelled()=>break,accepted=listener.accept()=>{let(stream,_)=accepted.unwrap();let requests=requests.clone();connections.spawn(async move{let service=service_fn(move|mut request:Request<Incoming>|{let requests=requests.clone();async move{
            let path=request.uri().path().to_owned();let method=request.method().to_string();let query=request.uri().query().unwrap_or("").to_owned();let headers=request.headers().clone();
            if path=="/upgrade"||request.method()==hyper::Method::CONNECT {let upgrade=hyper::upgrade::on(&mut request);requests.send(json!({"path":path,"method":method,"authorization":headers.get("authorization").unwrap().to_str().unwrap()})).await.unwrap();tokio::spawn(async move{let mut pipe=hyper_util::rt::TokioIo::new(upgrade.await.unwrap());let mut buffer=[0;64];loop{let count=pipe.read(&mut buffer).await.unwrap_or(0);if count==0{break;}pipe.write_all(&buffer[..count]).await.unwrap();}});let mut response=Response::new(Full::new(Bytes::new()).map_err(|never|match never{}).boxed_unsync());if request.method()!=hyper::Method::CONNECT{*response.status_mut()=hyper::StatusCode::SWITCHING_PROTOCOLS;response.headers_mut().insert("upgrade","websocket".parse().unwrap());response.headers_mut().insert("connection","Upgrade".parse().unwrap());}return Ok::<_,anyhow::Error>(response);}
            let body=http_body_util::Limited::new(request.into_body(),8192).collect().await.map_err(|_|anyhow::anyhow!("The bounded fixture request body was incomplete."))?.to_bytes();requests.send(json!({"path":path,"method":method,"query":query,"body":String::from_utf8(body.to_vec()).unwrap(),"authorization":headers.get("authorization").unwrap().to_str().unwrap(),"service":headers.get("x-happy-service-authorization").and_then(|value|value.to_str().ok()),"conditional":headers.get("if-none-match").and_then(|value|value.to_str().ok()),"privateHop":headers.get("x-private-hop").and_then(|value|value.to_str().ok())})).await.unwrap();
            if path=="/fail"{anyhow::bail!("The fixture closes after receiving the mutation.");}
            let body:Body=if path=="/sse"{let frames=stream::once(async{Ok::<_,anyhow::Error>(Frame::data(Bytes::from_static(b"event: fixture\ndata: first\n\n")))}).chain(stream::pending());StreamBody::new(frames).boxed_unsync()}else{Full::new(Bytes::from_static(b"upstream body")).map_err(|never|match never{}).boxed_unsync()};let mut response=Response::new(body);
            if path=="/cached"{response.headers_mut().insert("cache-control","private, max-age=60".parse().unwrap());response.headers_mut().insert("etag","\"opaque-cache\"".parse().unwrap());response.headers_mut().insert("vary","Accept-Encoding".parse().unwrap());response.headers_mut().insert("age","7".parse().unwrap());response.headers_mut().insert("expires","Wed, 21 Oct 2037 07:28:00 GMT".parse().unwrap());if headers.get("if-none-match").is_some(){*response.status_mut()=hyper::StatusCode::NOT_MODIFIED;*response.body_mut()=Full::new(Bytes::new()).map_err(|never|match never{}).boxed_unsync();}}
            if path=="/sse"{response.headers_mut().insert("content-type","text/event-stream".parse().unwrap());}
            Ok::<_,anyhow::Error>(response)
        }});let _=hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream),service).with_upgrades().await;});},_=connections.join_next(),if !connections.is_empty()=>{}}}connections.abort_all();while connections.join_next().await.is_some(){} });
        Self{port,requests:receiver,stop,task}
    }
    async fn request(&mut self)->Value {tokio::time::timeout(Duration::from_secs(5),self.requests.recv()).await.unwrap().unwrap()}
    async fn close(self){self.stop.cancel();self.task.await.unwrap();}
}

#[tokio::test(flavor="multi_thread",worker_threads=4)]
async fn native_remote_proxy_preserves_http_stream_upgrade_and_mutation_semantics() {
    let mut upstream=Upstream::start().await;let installation=Installation::start(upstream.port);
    let response=installation.call(reqwest::Method::PATCH,"/v0/connections/zulu/api/cached?a=opaque%2Bquery").header("connection","keep-alive, X-Private-Hop").header("x-private-hop","must not leave this hop").header("x-happy-service-authorization","fixture-service-credential").body("exact mutation body").send().await.unwrap();assert_eq!(response.status(),200);assert_eq!(response.headers()["cache-control"],"private, max-age=60");assert_eq!(response.headers()["etag"],"\"opaque-cache\"");assert_eq!(response.headers()["age"],"7");assert_eq!(response.text().await.unwrap(),"upstream body");
    let received=upstream.request().await;assert_eq!(received["method"],"PATCH");assert_eq!(received["path"],"/cached");assert_eq!(received["query"],"a=opaque%2Bquery");assert_eq!(received["body"],"exact mutation body");assert_eq!(received["authorization"],format!("Bearer {}","r".repeat(43)));assert_eq!(received["service"],"fixture-service-credential");assert_eq!(received["privateHop"],Value::Null);
    let response=installation.call(reqwest::Method::GET,"/v0/connections/zulu/api/cached").header("if-none-match","\"opaque-cache\"").send().await.unwrap();assert_eq!(response.status(),304);assert_eq!(response.headers()["cache-control"],"private, max-age=60");assert_eq!(response.headers()["etag"],"\"opaque-cache\"");assert!(response.bytes().await.unwrap().is_empty());assert_eq!(upstream.request().await["conditional"],"\"opaque-cache\"");
    let response=installation.call(reqwest::Method::GET,"/v0/connections/zulu/api/uncached").send().await.unwrap();assert!(!response.headers().contains_key("cache-control"));response.bytes().await.unwrap();upstream.request().await;
    let mut stream=installation.call(reqwest::Method::GET,"/v0/connections/zulu/api/sse").send().await.unwrap();assert_eq!(stream.status(),200);assert_eq!(tokio::time::timeout(Duration::from_secs(2),stream.chunk()).await.unwrap().unwrap().unwrap(),Bytes::from_static(b"event: fixture\ndata: first\n\n"));upstream.request().await;drop(stream);
    let response=installation.call(reqwest::Method::POST,"/v0/connections/zulu/api/fail").body("an ambiguous mutation").send().await.unwrap();assert_eq!(response.status(),503);assert_eq!(response.json::<Value>().await.unwrap()["code"],"remote_unavailable");assert_eq!(upstream.request().await["body"],"an ambiguous mutation");assert!(upstream.requests.try_recv().is_err(),"The mutation is never replayed.");
    for (method,path) in [("GET","/upgrade"),("CONNECT","/attach")] {let mut socket=tokio::net::UnixStream::connect(installation.home.join("agent/server.sock")).await.unwrap();let extra=if method=="GET"{"Connection: Upgrade\r\nUpgrade: websocket\r\n"}else{""};socket.write_all(format!("{method} /v0/connections/zulu/api{path} HTTP/1.1\r\nHost: happy\r\nAuthorization: Bearer {}\r\n{extra}\r\n",installation.token).as_bytes()).await.unwrap();let mut headers=Vec::new();while !headers.ends_with(b"\r\n\r\n"){headers.push(tokio::time::timeout(Duration::from_secs(5),socket.read_u8()).await.unwrap().unwrap());}assert!(String::from_utf8(headers).unwrap().starts_with(if method=="GET"{"HTTP/1.1 101"}else{"HTTP/1.1 200"}));socket.write_all(b"bidirectional bytes").await.unwrap();let mut echo=[0;19];tokio::time::timeout(Duration::from_secs(5),socket.read_exact(&mut echo)).await.unwrap().unwrap();assert_eq!(&echo,b"bidirectional bytes");assert_eq!(upstream.request().await["method"],method);}
    installation.command("stop");upstream.close().await;
}

#[tokio::test(flavor="multi_thread",worker_threads=4)]
async fn native_connection_reorder_and_cloud_authorization_obey_durable_public_contracts() {
    let upstream=Upstream::start().await;let installation=Installation::start(upstream.port);let original=installation.get("/v0/connections").await;assert_eq!(original["connections"][0]["id"],"alpha");assert_eq!(original["connections"][1]["id"],"zulu");assert!(!original.to_string().contains("tcfixture"));assert!(!original.to_string().contains(&"r".repeat(43)));
    let no_match=installation.call(reqwest::Method::POST,"/v0/connections/zulu/reorder").json(&json!({"afterId":null})).send().await.unwrap();assert_eq!(no_match.status(),400);
    let moved=installation.call(reqwest::Method::POST,"/v0/connections/zulu/reorder").header("if-match",original["version"].as_str().unwrap()).json(&json!({"afterId":null,"mutationId":"reorder-fixture"})).send().await.unwrap();assert_eq!(moved.status(),200);let moved:Value=moved.json().await.unwrap();assert_eq!(moved["connections"][0]["id"],"zulu");assert_eq!(moved["connections"][1]["orderKey"],original["connections"][0]["orderKey"]);assert!(moved["version"].as_str().unwrap()>original["version"].as_str().unwrap());
    let conflict=installation.call(reqwest::Method::POST,"/v0/connections/zulu/reorder").header("if-match",original["version"].as_str().unwrap()).json(&json!({"afterId":"alpha"})).send().await.unwrap();assert_eq!(conflict.status(),409);let conflict:Value=conflict.json().await.unwrap();assert_eq!(conflict["currentVersion"],moved["version"]);assert_eq!(conflict["connections"],moved["connections"]);
    let noop=installation.call(reqwest::Method::POST,"/v0/connections/zulu/reorder").header("if-match",moved["version"].as_str().unwrap()).json(&json!({"afterId":null})).send().await.unwrap();assert_eq!(noop.status(),200);assert_eq!(noop.json::<Value>().await.unwrap(),moved);
    let disconnected=installation.get("/v0/cloud").await;assert_eq!(disconnected["cloud"]["status"],"disconnected");let mint=installation.call(reqwest::Method::POST,"/v0/cloud/access-token").send().await.unwrap();assert_eq!(mint.status(),409);let mint:Value=mint.json().await.unwrap();assert_eq!(mint["code"],"cloud_not_authenticated");assert_eq!(mint["cloud"],disconnected["cloud"]);
    let start=installation.call(reqwest::Method::POST,"/v0/cloud/auth/start").json(&json!({"environment":"staging","redirectUri":"happy-auth://callback","mutationId":"cloud-fixture"})).send().await.unwrap();assert_eq!(start.status(),200);let authorizing:Value=start.json().await.unwrap();assert_eq!(authorizing["cloud"]["status"],"authorizing");let retry=installation.call(reqwest::Method::POST,"/v0/cloud/auth/start").json(&json!({"environment":"staging","redirectUri":"happy-auth://callback"})).send().await.unwrap();assert_eq!(retry.json::<Value>().await.unwrap(),authorizing);
    let malformed=installation.call(reqwest::Method::POST,"/v0/cloud/auth/complete").json(&json!({"callbackUrl":"happy-auth://callback?code=wrong&state=wrong"})).send().await.unwrap();assert_eq!(malformed.status(),400);assert_eq!(malformed.json::<Value>().await.unwrap()["cloud"],authorizing["cloud"]);
    installation.restart();assert_eq!(installation.get("/v0/connections").await,moved);
    // Source CloudModule intentionally retains no PKCE attempt after restart.
    // Its original expiry procedure settles the persisted pending marker.
    let restarted=tokio::time::timeout(Duration::from_secs(5),async{loop{let value=installation.get("/v0/cloud").await;if value["cloud"]["version"].as_str().unwrap()>authorizing["cloud"]["version"].as_str().unwrap(){break value;}tokio::task::yield_now().await;}}).await.unwrap();assert_eq!(restarted["cloud"]["status"],"disconnected");assert_eq!(restarted["cloud"]["authorization"],Value::Null);assert_eq!(restarted["cloud"]["error"]["code"],"authorization_expired");
    let signout=installation.call(reqwest::Method::DELETE,"/v0/cloud/auth").send().await.unwrap();assert_eq!(signout.status(),200);let signed_out:Value=signout.json().await.unwrap();assert_eq!(signed_out["cloud"]["status"],"disconnected");assert!(signed_out["cloud"]["version"].as_str().unwrap()>authorizing["cloud"]["version"].as_str().unwrap());installation.command("stop");upstream.close().await;
}