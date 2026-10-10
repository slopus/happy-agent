use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn socks_fixture(directory: &std::path::Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    let path = directory.join("tailcat-proxy-fixture");
    std::fs::write(&path, r#"#!/usr/bin/python3
import socket,threading,select
listener=socket.socket();listener.bind(('127.0.0.1',0));listener.listen(32)
print('SOCKS running at socks5h://127.0.0.1:'+str(listener.getsockname()[1]),flush=True)
def exact(connection,size):
    result=b''
    while len(result)<size:
        part=connection.recv(size-len(result))
        if not part: raise RuntimeError('closed')
        result+=part
    return result
def serve(connection):
    try:
        assert exact(connection,3)==bytes([5,1,0]);connection.sendall(bytes([5,0]))
        header=exact(connection,5);exact(connection,header[4]);port=int.from_bytes(exact(connection,2),'big')
        with socket.create_connection(('127.0.0.1',port)) as remote:
            connection.sendall(bytes([5,0,0,1,127,0,0,1,0,0]))
            while True:
                readable,_,_=select.select([connection,remote],[],[])
                for source in readable:
                    data=source.recv(65536)
                    if not data:return
                    (remote if source is connection else connection).sendall(data)
    except Exception:pass
    finally:connection.close()
while True:
    connection,_=listener.accept();threading.Thread(target=serve,args=(connection,),daemon=True).start()
"#).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    path.to_string_lossy().into_owned()
}

#[tokio::test]
async fn caller_cancellation_closes_a_body_after_response_headers_arrive() {
    let directory = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (finished, finish) = tokio::sync::oneshot::channel::<()>();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") {
            request.push(socket.read_u8().await.unwrap());
        }
        assert!(String::from_utf8(request).unwrap().contains("authorization: Bearer test-token"));
        socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n").await.unwrap();
        let _ = finish.await;
    });
    let pool = RemoteProxyConnection::new(TailcatConnection::new(socks_fixture(directory.path()), "tcfixture".into()), port);
    let cancel = CancellationToken::new();
    let response = pool.request(Request::builder().uri("/stream").body(empty()).unwrap(), "/stream", async { Ok("test-token".into()) }, cancel.clone()).await.unwrap();
    let mut body = response.into_body();
    assert_eq!(body.frame().await.unwrap().unwrap().into_data().unwrap(), "hello");
    cancel.cancel();
    let cancelled = tokio::time::timeout(Duration::from_millis(300), body.frame()).await;
    pool.close().await.unwrap();
    let _ = finished.send(());
    upstream.await.unwrap();
    assert!(matches!(cancelled, Ok(Some(Err(_)))), "The caller's cancellation must invalidate the response body after its headers have arrived.");
}

#[tokio::test]
async fn concurrent_close_waits_for_the_same_positive_owned_task_cleanup() {
    let pool = RemoteProxyConnection::new(TailcatConnection::new("unused-no-process".into(), "tcfixture".into()), 24779);
    let (entered, entering) = tokio::sync::oneshot::channel::<()>();
    let (released, releasing) = tokio::sync::oneshot::channel::<()>();
    pool.spawn(async move {
        let _ = entered.send(());
        let _ = releasing.await;
    }).unwrap();
    entering.await.unwrap();
    let first_pool = pool.clone();
    let first = tokio::spawn(async move { first_pool.close().await });
    while !pool.closed.load(Ordering::Acquire) { tokio::task::yield_now().await; }
    // Observe the first close taking responsibility for the still-live task.
    while !pool.tasks.lock().unwrap().is_empty() { tokio::task::yield_now().await; }
    let second_pool = pool.clone();
    let mut second = tokio::spawn(async move { second_pool.close().await });
    let early = tokio::time::timeout(Duration::from_millis(100), &mut second).await;
    let _ = released.send(());
    first.await.unwrap().unwrap();
    let returned_early = early.is_ok();
    if !returned_early { second.await.unwrap().unwrap(); }
    assert!(!returned_early, "Every close caller must wait for the same owned cleanup, including a call made while an earlier close is draining tasks.");
}

#[tokio::test]
async fn health_deadline_covers_a_response_body_that_stalls_after_its_headers() {
    let directory = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (finished, finish) = tokio::sync::oneshot::channel::<()>();
    let upstream = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        while !request.ends_with(b"\r\n\r\n") { request.push(socket.read_u8().await.unwrap()); }
        socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\n{\r\n").await.unwrap();
        let _ = finish.await;
    });
    let pool = RemoteProxyConnection::new(TailcatConnection::new(socks_fixture(directory.path()), "tcfixture".into()), port);
    let result = tokio::time::timeout(Duration::from_millis(31_500), pool.health(async { Ok("test-token".into()) }, CancellationToken::new())).await;
    pool.close().await.unwrap();
    let _ = finished.send(());
    upstream.await.unwrap();
    let error = result.expect("The Source 30-second health deadline includes reading the body, even after successful response headers.").unwrap_err();
    let error = error.downcast_ref::<RemoteConnectionError>().expect("The deadline returns a safe remote error.");
    assert_eq!(error.status, 504);
    assert_eq!(error.code, "remote_timeout");
    assert_eq!(error.message, "The remote health check timed out.");
}