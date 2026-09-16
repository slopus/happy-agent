//! The secret that tells a front-end its client is the workload.
//!
//! On macOS the listeners sit on the host's loopback, where any local process can reach them. The
//! secret is generated once per invocation and delivered to the workload only through the proxy
//! URLs, so the environment that tells a client where the proxy is also tells it how to
//! authenticate. It is enforced on both platforms: uniform behaviour is easier to test than
//! conditional behaviour, and on Linux, where the listeners already live in a private network
//! namespace, it costs nothing.

use crate::SupervisorResult;
use std::fs::File;
use std::io::Read;

/// The user name half of the credential. Only the secret carries entropy; the name is here because
/// both vocabularies the front-ends speak are user-and-password shaped.
const PROXY_USER: &str = "supervisor";

const SECRET_BYTES: usize = 32;
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub(crate) struct ProxyCredential {
    secret: String,
    /// The exact `Proxy-Authorization` payload an authorised client sends, compared rather than
    /// decoded so the front-end never has to trust a base64 decoder with untrusted input.
    basic: String,
}

impl ProxyCredential {
    pub(crate) fn generate() -> SupervisorResult<Self> {
        let mut bytes = [0_u8; SECRET_BYTES];
        File::open("/dev/urandom")
            .and_then(|mut source| source.read_exact(&mut bytes))
            .map_err(|error| {
                std::io::Error::other(format!("generate the sandbox proxy secret: {error}"))
            })?;
        let secret = hexadecimal(&bytes);
        let basic = base64(format!("{PROXY_USER}:{secret}").as_bytes());
        Ok(Self { secret, basic })
    }

    /// The `user:secret` the proxy URLs carry.
    pub(crate) fn url_user_information(&self) -> String {
        format!("{PROXY_USER}:{}", self.secret)
    }

    /// The header value a correctly configured client sends, which only the tests need to build.
    #[cfg(test)]
    pub(crate) fn http_authorization(&self) -> String {
        format!("Basic {}", self.basic)
    }

    pub(crate) fn authorizes_http(&self, header_value: &str) -> bool {
        let Some((scheme, credentials)) = header_value.split_once(' ') else {
            return false;
        };
        scheme.eq_ignore_ascii_case("basic")
            && equal_in_constant_time(credentials.trim().as_bytes(), self.basic.as_bytes())
    }

    pub(crate) fn authorizes_socks(&self, user: &[u8], secret: &[u8]) -> bool {
        let user_matches = equal_in_constant_time(user, PROXY_USER.as_bytes());
        let secret_matches = equal_in_constant_time(secret, self.secret.as_bytes());
        user_matches && secret_matches
    }
}

/// Compares without leaking where two values first differ.
fn equal_in_constant_time(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn hexadecimal(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        text.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        text.push(char::from(b"0123456789abcdef"[usize::from(byte & 0x0f)]));
    }
    text
}

fn base64(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = chunk.get(1).copied().map_or(0, u32::from);
        let third = chunk.get(2).copied().map_or(0, u32::from);
        let packed = (first << 16) | (second << 8) | third;
        text.push(char::from(BASE64_ALPHABET[(packed >> 18) as usize & 0x3f]));
        text.push(char::from(BASE64_ALPHABET[(packed >> 12) as usize & 0x3f]));
        text.push(if chunk.len() > 1 {
            char::from(BASE64_ALPHABET[(packed >> 6) as usize & 0x3f])
        } else {
            '='
        });
        text.push(if chunk.len() > 2 {
            char::from(BASE64_ALPHABET[packed as usize & 0x3f])
        } else {
            '='
        });
    }
    text
}

#[cfg(test)]
mod tests {
    use super::{ProxyCredential, base64, equal_in_constant_time};

    #[test]
    fn base64_matches_the_encoding_every_client_uses() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"supervisor:secret"), "c3VwZXJ2aXNvcjpzZWNyZXQ=");
    }

    #[test]
    fn comparison_rejects_a_different_length_without_indexing_past_it() {
        assert!(equal_in_constant_time(b"abc", b"abc"));
        assert!(!equal_in_constant_time(b"abc", b"abd"));
        assert!(!equal_in_constant_time(b"abc", b"abcd"));
        assert!(!equal_in_constant_time(b"", b"a"));
    }

    #[test]
    fn only_the_generated_secret_authorizes_either_front_end() {
        let credential =
            ProxyCredential::generate().unwrap_or_else(|error| panic!("generate: {error}"));
        let user_information = credential.url_user_information();
        let (user, secret) = user_information
            .split_once(':')
            .unwrap_or_else(|| panic!("the URL user information carries a user and a secret"));
        assert_eq!(secret.len(), 64);

        let authorization = super::base64(user_information.as_bytes());
        assert!(credential.authorizes_http(&format!("Basic {authorization}")));
        assert!(credential.authorizes_http(&format!("basic {authorization}")));
        assert!(!credential.authorizes_http(&format!("Bearer {authorization}")));
        assert!(!credential.authorizes_http("Basic c3VwZXJ2aXNvcjp3cm9uZw=="));
        assert!(!credential.authorizes_http("Basic"));

        assert!(credential.authorizes_socks(user.as_bytes(), secret.as_bytes()));
        assert!(!credential.authorizes_socks(user.as_bytes(), b"wrong"));
        assert!(!credential.authorizes_socks(b"someone-else", secret.as_bytes()));
    }

    #[test]
    fn each_invocation_generates_its_own_secret() {
        let first = ProxyCredential::generate().unwrap_or_else(|error| panic!("generate: {error}"));
        let second =
            ProxyCredential::generate().unwrap_or_else(|error| panic!("generate: {error}"));
        assert_ne!(first.url_user_information(), second.url_user_information());
    }
}
