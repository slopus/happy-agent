use super::*;
use serde_json::json;
use std::{path::Path, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[cfg(unix)]
fn executable(directory: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join("tailcat-fixture");
    let fixture_home = serde_json::to_string(&directory.to_string_lossy()).unwrap();
    let source = format!(r#"#!/usr/bin/python3
import json, pathlib, socket, sys, threading, time, os
home=pathlib.Path({fixture_home})
with open(home/'arguments','a') as file: file.write(json.dumps(sys.argv[1:])+'\n')
if sys.argv[1]=='genkey':
    pathlib.Path(sys.argv[2][6:]).write_text('private identity')
    sys.exit(0)
if 'serve' in sys.argv:
    pathlib.Path(os.environ['TAILCAT_ADDR_FILE']).write_text('tcfixturestable\n')
    while True: time.sleep(1)
counter=home/'generations'
generation=int(counter.read_text())+1 if counter.exists() else 1
counter.write_text(str(generation))
listener=socket.socket(); listener.bind(('127.0.0.1',0)); listener.listen(32)
print('SOCKS running at socks5h://127.0.0.1:'+str(listener.getsockname()[1]),flush=True)
def exact(connection,size):
    result=b''
    while len(result)<size:
        part=connection.recv(size-len(result))
        if not part: raise RuntimeError('closed')
        result+=part
    return result
def handle(connection):
    try:
        assert exact(connection,3)==bytes([5,1,0])
        connection.sendall(bytes([5,0]))
        header=exact(connection,5); assert header[:4]==bytes([5,1,0,3])
        host=exact(connection,header[4]); assert host==b'server.tailcat'
        port=int.from_bytes(exact(connection,2),'big')
        with open(home/'ports','a') as file: file.write(str(port)+'\n')
        if generation==1 and (home/'fail-first').exists():
            connection.sendall(bytes([5,1,0,1])); return
        connection.sendall(bytes([5,0,0,1,127,0,0,1,0,0]))
        while True:
            data=connection.recv(4096)
            if not data: break
            connection.sendall(data)
    except Exception: pass
    finally: connection.close()
while True:
    connection,address=listener.accept()
    threading.Thread(target=handle,args=(connection,),daemon=True).start()
"#);
    std::fs::write(&path, source).unwrap(); std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path.to_string_lossy().into_owned()
}

#[cfg(unix)]
#[tokio::test]
async fn failed_carrier_is_reaped_and_only_a_later_request_starts_a_replacement() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("fail-first"), "true").unwrap();
    let connection = TailcatConnection::new(executable(directory.path()), "tcfixture".into());
    assert!(connection.connect(24779).await.is_err());
    assert_eq!(std::fs::read_to_string(directory.path().join("generations")).unwrap(), "1", "The failed request was not replayed.");
    let mut socket = connection.connect(24779).await.unwrap();
    socket.write_all(b"one new request").await.unwrap();
    let mut received = [0; 15]; socket.read_exact(&mut received).await.unwrap(); assert_eq!(&received, b"one new request");
    assert_eq!(std::fs::read_to_string(directory.path().join("generations")).unwrap(), "2");
    assert_eq!(std::fs::read_to_string(directory.path().join("ports")).unwrap(), "24779\n24779\n");
    let pending = tokio::spawn(async move { let mut byte = [0]; socket.read_exact(&mut byte).await });
    connection.close().await.unwrap();
    assert!(tokio::time::timeout(Duration::from_secs(1), pending).await.unwrap().unwrap().is_err(), "Close invalidates sockets attached to the old generation.");
    assert!(connection.connect(24779).await.is_err());
    let arguments = std::fs::read_to_string(directory.path().join("arguments")).unwrap();
    assert!(arguments.lines().all(|line| serde_json::from_str::<serde_json::Value>(line).unwrap() == json!(["--key=new","socks","--listen=127.0.0.1:0","tcfixture"])));
}

#[cfg(unix)]
#[tokio::test]
async fn exposure_keeps_the_original_identity_and_refuses_a_configured_port_collision() {
    use crate::product::config::ConfigModule;
    let directory = tempfile::tempdir().unwrap();
    let path = executable(directory.path());
    let mut config = ConfigModule::isolated(&directory.path().join("happy")).unwrap();
    // The development executable is a configuration-owned resolution. Tests do
    // not inject a process host or a callback into the product owner.
    config.set_tailcat_test_executable(path);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    config.set_tailcat_test_port(port);
    let result = TailcatExposure::open(&config, json!({"host":"127.0.0.1","port":port})).await;
    assert!(result.err().unwrap().to_string().contains("already in use"));
    let key = config.tailcat_home().join("default.private.json");
    assert_eq!(std::fs::read_to_string(&key).unwrap(), "private identity");
    drop(listener);
    let exposure = TailcatExposure::open(&config, json!({"host":"127.0.0.1","port":1})).await.unwrap();
    assert_eq!(exposure.port, port); assert_eq!(exposure.address, "tcfixturestable");
    assert_eq!(std::fs::read_to_string(config.tailcat_home().join("port")).unwrap(), format!("{port}\n"));
    exposure.close().await.unwrap();
    assert!(key.exists()); assert!(!config.tailcat_home().join("address").exists()); assert!(!config.tailcat_home().join("port").exists());
    let arguments = std::fs::read_to_string(directory.path().join("arguments")).unwrap();
    assert_eq!(arguments.lines().filter(|line| line.contains("genkey")).count(), 1, "A restart preserves the original private identity key.");
}