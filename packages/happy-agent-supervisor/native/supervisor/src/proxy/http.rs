//! The loopback HTTP proxy front-end.
//!
//! It understands exactly the two request shapes an `HTTP_PROXY` client produces — `CONNECT` for
//! tunnels and an absolute URI for plaintext — and both reduce to one `open_stream(host, port)`.
//! No TLS is unwrapped here and no certificate is ever minted here.

use crate::proxy::bridge::relay;
use crate::proxy::credential::ProxyCredential;
use crate::proxy::mux::{Mux, MuxStream, OpenFailure, RefusalReason};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::sync::Arc;

const MAX_HEAD_BYTES: usize = 64 * 1024;
const READ_BUFFER_BYTES: usize = 8 * 1024;

pub(crate) fn serve(mux: &Arc<Mux>, credential: &ProxyCredential, mut client: TcpStream) {
    let head = match read_head(&mut client) {
        Ok(head) => head,
        Err(_) => {
            respond(&mut client, 400, "The proxy request could not be read.");
            return;
        }
    };
    let Some(split) = find_head_end(&head.bytes) else {
        respond(
            &mut client,
            431,
            "The proxy request header block is too large.",
        );
        return;
    };
    let (header_block, remainder) = head.bytes.split_at(split);
    if !is_authorized(header_block, credential) {
        respond(
            &mut client,
            407,
            "The sandbox proxy requires the credentials in the proxy address.",
        );
        return;
    }
    let Some(request) = parse_request(header_block) else {
        respond(
            &mut client,
            400,
            "The proxy request could not be understood.",
        );
        return;
    };

    let stream = match mux.open(&request.host, request.port) {
        Ok(stream) => stream,
        Err(failure) => {
            respond_refusal(&mut client, &failure);
            return;
        }
    };
    match request.body {
        RequestBody::Tunnel => {
            if client
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .is_err()
            {
                return;
            }
            relay(client, stream, remainder);
        }
        RequestBody::Forwarded(forwarded) => {
            if send_forwarded(&stream, &forwarded, remainder).is_err() {
                respond(&mut client, 502, "The destination closed the connection.");
                return;
            }
            relay(client, stream, &[]);
        }
    }
}

struct Head {
    bytes: Vec<u8>,
}

enum RequestBody {
    Tunnel,
    Forwarded(Vec<u8>),
}

struct ProxyRequest {
    host: String,
    port: u16,
    body: RequestBody,
}

fn send_forwarded(stream: &MuxStream, forwarded: &[u8], remainder: &[u8]) -> std::io::Result<()> {
    stream.send(forwarded)?;
    if !remainder.is_empty() {
        stream.send(remainder)?;
    }
    Ok(())
}

/// Whether the client proved it is the workload this proxy was created for.
///
/// The first `Proxy-Authorization` header decides, so a client cannot follow a wrong credential
/// with a right one and have the second counted.
fn is_authorized(block: &[u8], credential: &ProxyCredential) -> bool {
    let Ok(text) = std::str::from_utf8(block) else {
        return false;
    };
    for line in text.split("\r\n").skip(1) {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if name.trim().eq_ignore_ascii_case("proxy-authorization") {
            return credential.authorizes_http(value.trim());
        }
    }
    false
}

fn read_head(client: &mut TcpStream) -> std::io::Result<Head> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; READ_BUFFER_BYTES];
    loop {
        if find_head_end(&bytes).is_some() {
            return Ok(Head { bytes });
        }
        if bytes.len() >= MAX_HEAD_BYTES {
            return Ok(Head { bytes });
        }
        let read = client.read(&mut buffer)?;
        if read == 0 {
            return Ok(Head { bytes });
        }
        bytes.extend_from_slice(&buffer[..read]);
    }
}

fn find_head_end(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 4)
}

fn parse_request(block: &[u8]) -> Option<ProxyRequest> {
    let text = std::str::from_utf8(block).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split(' ');
    let method = parts.next()?;
    let target = parts.next()?;
    let version = parts.next()?;
    if parts.next().is_some() || !version.starts_with("HTTP/") {
        return None;
    }
    if method == "CONNECT" {
        // Authority form requires the port, and guessing one would silently send a tunnel
        // somewhere the client never named.
        let (host, port) = split_authority(target, None)?;
        return Some(ProxyRequest {
            host,
            port,
            body: RequestBody::Tunnel,
        });
    }
    let rest = target.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    let (host, port) = split_authority(authority, Some(80))?;
    let mut forwarded = format!("{method} {path} {version}\r\n");
    for line in lines {
        if line.is_empty() {
            break;
        }
        let name = line.split(':').next().unwrap_or_default().trim();
        if is_hop_by_hop(name) {
            continue;
        }
        forwarded.push_str(line);
        forwarded.push_str("\r\n");
    }
    // One request per stream. Keeping the connection alive would mean tracking every body framing
    // rule to find where the next request starts, and a later request on the same socket could
    // name a different host than the one this stream was opened for.
    forwarded.push_str("Connection: close\r\n\r\n");
    Some(ProxyRequest {
        host,
        port,
        body: RequestBody::Forwarded(forwarded.into_bytes()),
    })
}

fn is_hop_by_hop(name: &str) -> bool {
    name.eq_ignore_ascii_case("connection")
        || name.eq_ignore_ascii_case("proxy-connection")
        || name.eq_ignore_ascii_case("proxy-authorization")
        || name.eq_ignore_ascii_case("keep-alive")
}

fn split_authority(authority: &str, default_port: Option<u16>) -> Option<(String, u16)> {
    if authority.contains('@') {
        return None;
    }
    if let Some(rest) = authority.strip_prefix('[') {
        let (host, tail) = rest.split_once(']')?;
        let port = match tail.strip_prefix(':') {
            Some(port) => port.parse::<u16>().ok()?,
            None if tail.is_empty() => default_port?,
            None => return None,
        };
        return usable_authority(host, port);
    }
    match authority.rsplit_once(':') {
        Some((host, port)) => usable_authority(host, port.parse::<u16>().ok()?),
        None => usable_authority(authority, default_port?),
    }
}

fn usable_authority(host: &str, port: u16) -> Option<(String, u16)> {
    if host.is_empty() || port == 0 || host.len() > 255 {
        return None;
    }
    if host
        .bytes()
        .any(|byte| byte <= b' ' || byte == b'/' || byte == 0x7f)
    {
        return None;
    }
    Some((host.to_string(), port))
}

fn respond_refusal(client: &mut TcpStream, failure: &OpenFailure) {
    let status = match failure.reason {
        RefusalReason::Blocked => 403,
        RefusalReason::Unresolvable | RefusalReason::Unreachable => 502,
    };
    respond(client, status, &failure.message);
}

fn respond(client: &mut TcpStream, status: u16, message: &str) {
    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        407 => "Proxy Authentication Required",
        431 => "Request Header Fields Too Large",
        _ => "Bad Gateway",
    };
    let challenge = if status == 407 {
        "Proxy-Authenticate: Basic realm=\"Sandbox proxy\"\r\n"
    } else {
        ""
    };
    let body = format!("{message}\n");
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n{challenge}Content-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = client.write_all(response.as_bytes());
    // Only the write side is closed. Shutting down reads as well would let the socket close with
    // unread bytes, and the client can lose the response it was just sent.
    let _ = client.shutdown(Shutdown::Write);
}

#[cfg(test)]
mod tests {
    use super::{RequestBody, is_authorized, parse_request};
    use crate::proxy::credential::ProxyCredential;

    #[test]
    fn only_the_first_proxy_authorization_header_is_consulted() {
        let credential =
            ProxyCredential::generate().unwrap_or_else(|error| panic!("generate: {error}"));
        let authorization = credential.http_authorization();

        assert!(is_authorized(
            format!(
                "CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: {authorization}\r\n\r\n"
            )
            .as_bytes(),
            &credential,
        ));
        assert!(!is_authorized(
            b"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
            &credential,
        ));
        assert!(!is_authorized(
            format!(
                "CONNECT example.com:443 HTTP/1.1\r\nProxy-Authorization: Basic d3Jvbmc=\r\nProxy-Authorization: {authorization}\r\n\r\n"
            )
            .as_bytes(),
            &credential,
        ));
    }

    #[test]
    fn connect_requests_name_a_destination_without_a_body() {
        let request =
            parse_request(b"CONNECT example.com:8443 HTTP/1.1\r\nHost: example.com\r\n\r\n")
                .unwrap_or_else(|| panic!("CONNECT should parse"));
        assert_eq!(request.host, "example.com");
        assert_eq!(request.port, 8443);
        assert!(matches!(request.body, RequestBody::Tunnel));
    }

    #[test]
    fn absolute_uri_requests_are_rewritten_to_origin_form() {
        let request = parse_request(
            b"GET http://example.com/a?b=c HTTP/1.1\r\nHost: example.com\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\nAccept: */*\r\n\r\n",
        )
        .unwrap_or_else(|| panic!("absolute URI should parse"));
        assert_eq!(request.host, "example.com");
        assert_eq!(request.port, 80);
        let RequestBody::Forwarded(forwarded) = request.body else {
            panic!("an absolute URI request is forwarded, not tunnelled");
        };
        assert_eq!(
            String::from_utf8_lossy(&forwarded),
            "GET /a?b=c HTTP/1.1\r\nHost: example.com\r\nAccept: */*\r\nConnection: close\r\n\r\n"
        );
    }

    #[test]
    fn unusable_requests_are_refused_rather_than_guessed() {
        for request in [
            &b"GET https://example.com/ HTTP/1.1\r\n\r\n"[..],
            &b"GET / HTTP/1.1\r\n\r\n"[..],
            &b"CONNECT example.com HTTP/1.1\r\n\r\n"[..],
            &b"CONNECT user@example.com:443 HTTP/1.1\r\n\r\n"[..],
            &b"CONNECT example.com:0 HTTP/1.1\r\n\r\n"[..],
            &b"CONNECT example.com:443 RTSP/1.0\r\n\r\n"[..],
        ] {
            assert!(
                parse_request(request).is_none(),
                "should refuse: {}",
                String::from_utf8_lossy(request)
            );
        }
    }

    #[test]
    fn bracketed_addresses_keep_their_port() {
        let request = parse_request(b"CONNECT [2001:db8::1]:8443 HTTP/1.1\r\n\r\n")
            .unwrap_or_else(|| panic!("bracketed authority should parse"));
        assert_eq!(request.host, "2001:db8::1");
        assert_eq!(request.port, 8443);
    }
}
