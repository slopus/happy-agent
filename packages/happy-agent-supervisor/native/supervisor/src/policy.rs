use crate::proxy::MAX_HOST_BYTES;
use crate::{SupervisorResult, invalid_input};
use serde::Deserialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PermissionMode {
    ReadOnly,
    WorkspaceWrite,
    Auto,
    FullAccess,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProxyFrontEnd {
    Http,
    Socks5,
}

/// The front-ends to expose inside the sandbox.
///
/// The supervisor provides the proxy itself: it forks an egress process outside the jail and joins
/// the two with a socketpair, so nothing inside the sandbox ever reaches the proxy — or anything
/// else — by address, and the caller supplies no descriptor and no token.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct OutgoingProxyPolicy {
    pub(crate) front_ends: Vec<ProxyFrontEnd>,
}

impl OutgoingProxyPolicy {
    pub(crate) fn exposes(&self, front_end: ProxyFrontEnd) -> bool {
        self.front_ends.contains(&front_end)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct NetworkPolicy {
    pub(crate) egress: bool,
    #[serde(default)]
    pub(crate) allowed_hosts: Vec<String>,
    pub(crate) local_binding: bool,
    #[serde(default)]
    pub(crate) outgoing_proxy: Option<OutgoingProxyPolicy>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct SupervisorPolicy {
    pub(crate) mode: PermissionMode,
    #[serde(default)]
    pub(crate) allowed_read_paths: Vec<PathBuf>,
    #[serde(default)]
    pub(crate) denied_read_paths: Vec<PathBuf>,
    #[serde(default)]
    pub(crate) allowed_write_paths: Vec<PathBuf>,
    #[serde(default)]
    pub(crate) denied_write_paths: Vec<PathBuf>,
    pub(crate) network: NetworkPolicy,
    #[serde(default)]
    pub(crate) service: Option<crate::service_policy::ServicePolicy>,
}

impl SupervisorPolicy {
    pub(crate) fn validate(&self) -> SupervisorResult<()> {
        if let Some(service) = &self.service {
            service.validate()?;
            if self.mode != PermissionMode::ReadOnly
                || !self.network.local_binding
                || !self.allowed_read_paths.is_empty()
                || !self.allowed_write_paths.is_empty()
                || !self.denied_read_paths.is_empty()
                || !self.denied_write_paths.is_empty()
                || self.network.egress == service.outbound.is_empty()
                || self.network.outgoing_proxy.is_some() != self.network.egress
            {
                return Err(invalid_input("services require their mandatory isolation policy, not ordinary shell overrides").into());
            }
        }
        for path in self
            .allowed_read_paths
            .iter()
            .chain(&self.denied_read_paths)
            .chain(&self.allowed_write_paths)
            .chain(&self.denied_write_paths)
        {
            validate_absolute_path(path)?;
        }
        for host in &self.network.allowed_hosts {
            validate_allowed_host(host)?;
        }
        if self.mode == PermissionMode::FullAccess {
            let mut restrictions = Vec::new();
            if !self.denied_read_paths.is_empty() {
                restrictions.push("deniedReadPaths");
            }
            if !self.denied_write_paths.is_empty() {
                restrictions.push("deniedWritePaths");
            }
            if !self.network.allowed_hosts.is_empty() {
                restrictions.push("network.allowedHosts");
            }
            if !self.network.egress {
                restrictions.push("network.egress");
            }
            if !self.network.local_binding {
                restrictions.push("network.localBinding");
            }
            if self.network.outgoing_proxy.is_some() {
                restrictions.push("network.outgoingProxy");
            }
            if !restrictions.is_empty() {
                return Err(invalid_input(format!(
                    "full_access cannot be combined with restrictions: {}",
                    restrictions.join(", ")
                ))
                .into());
            }
        }
        // The host list is enforced in the egress process, which only exists when a proxy is
        // configured. Naming hosts without that proxy would leave egress unfiltered, so it fails
        // closed instead.
        if self.network.egress
            && !self.network.allowed_hosts.is_empty()
            && self.network.outgoing_proxy.is_none()
        {
            return Err(invalid_input(
                "network.allowedHosts requires network.outgoingProxy, which is where a host list is enforced",
            )
            .into());
        }
        if let Some(proxy) = &self.network.outgoing_proxy {
            validate_outgoing_proxy(proxy, self.network.egress)?;
        }
        Ok(())
    }

    pub(crate) fn writable_roots(&self, cwd: &Path) -> Vec<PathBuf> {
        let mut roots = self.allowed_write_paths.clone();
        if matches!(
            self.mode,
            PermissionMode::WorkspaceWrite | PermissionMode::Auto
        ) {
            roots.push(cwd.to_path_buf());
        }
        deduplicate_paths(roots)
    }
}

fn validate_outgoing_proxy(proxy: &OutgoingProxyPolicy, egress: bool) -> SupervisorResult<()> {
    if !egress {
        return Err(invalid_input(
            "network.outgoingProxy requires network.egress, because the proxy is how egress happens",
        )
        .into());
    }
    if proxy.front_ends.is_empty() {
        return Err(invalid_input(
            "network.outgoingProxy.frontEnds must name at least one front-end",
        )
        .into());
    }
    Ok(())
}

/// One entry names one host, or one `*.suffix`.
///
/// A bare `*` is refused rather than read as open egress: a policy that meant to reach everything
/// says so by configuring no proxy at all, and a wildcard that slipped into a list would otherwise
/// silently undo every other entry beside it.
fn validate_allowed_host(host: &str) -> SupervisorResult<()> {
    if host.is_empty() {
        return Err(invalid_input("network.allowedHosts cannot contain an empty host").into());
    }
    if host.len() > MAX_HOST_BYTES {
        return Err(invalid_input(format!(
            "network.allowedHosts entries must be at most {MAX_HOST_BYTES} bytes: {host}"
        ))
        .into());
    }
    let name = host.strip_prefix("*.").unwrap_or(host);
    let unusable = name.is_empty()
        || name.contains('*')
        || host
            .bytes()
            .any(|byte| byte <= b' ' || byte == b'/' || byte == b'@' || byte == 0x7f);
    if unusable {
        return Err(invalid_input(format!(
            "network.allowedHosts entries name one host or one *.suffix, so {host} cannot be used"
        ))
        .into());
    }
    Ok(())
}

fn validate_absolute_path(path: &Path) -> SupervisorResult<()> {
    if !path.is_absolute() {
        return Err(invalid_input(format!(
            "supervisor policy paths must be absolute: {}",
            path.display()
        ))
        .into());
    }
    Ok(())
}

fn deduplicate_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::new();
    for path in paths {
        if !result.iter().any(|existing| existing == &path) {
            result.push(path);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{PermissionMode, ProxyFrontEnd, SupervisorPolicy};

    #[test]
    fn service_policy_cannot_relax_the_mandatory_boundary() {
        let valid = serde_json::json!({
            "mode": "read_only", "network": { "egress": false, "localBinding": true },
            "service": {
                "root": "/private/execution/root", "cwd": ".",
                "inputs": [{ "source": "/workspace/src", "destination": "src" }], "scratch": [],
                "cgroupParent": "/sys/fs/cgroup/delegated", "executionId": "abcdefghijklmnop",
                "controllerPid": 42,
                "bridgeSocket": "/private/execution/bridge", "bridgeToken": "a".repeat(64),
                "port": 4187, "memoryMiB": 1024, "processes": 64, "outbound": []
            }
        });
        let parse = |value| {
            serde_json::from_value::<SupervisorPolicy>(value)
                .unwrap_or_else(|error| panic!("{error}"))
        };
        assert!(parse(valid.clone()).validate().is_ok());
        for (pointer, value) in [
            ("/mode", serde_json::json!("full_access")),
            ("/network/egress", serde_json::json!(true)),
            ("/network/localBinding", serde_json::json!(false)),
            ("/service/root", serde_json::json!("/")),
            (
                "/service/bridgeSocket",
                serde_json::json!("/private/execution/root/bridge"),
            ),
            ("/service/memoryMiB", serde_json::json!(1025)),
            ("/service/processes", serde_json::json!(0)),
            (
                "/service/inputs/0/destination",
                serde_json::json!("../private"),
            ),
        ] {
            let mut policy = valid.clone();
            *policy
                .pointer_mut(pointer)
                .unwrap_or_else(|| panic!("missing {pointer}")) = value;
            assert!(parse(policy).validate().is_err(), "{pointer}");
        }
    }

    #[test]
    fn parses_compute_permission_names() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "deniedWritePaths": ["/workspace/.git"],
                "network": {"egress": true, "localBinding": false}
            }"#,
        )
        .unwrap_or_else(|error| panic!("policy should parse: {error}"));

        assert_eq!(policy.mode, PermissionMode::WorkspaceWrite);
        assert_eq!(
            policy.denied_write_paths[0].to_string_lossy(),
            "/workspace/.git"
        );
    }

    #[test]
    fn rejects_unknown_fields() {
        let result = serde_json::from_str::<SupervisorPolicy>(
            r#"{
                "mode": "auto",
                "shell": "sh -lc",
                "network": {"egress": false, "localBinding": false}
            }"#,
        );
        assert!(result.is_err());
    }

    #[test]
    fn host_allowlists_fail_closed_only_when_egress_is_enabled() {
        let blocked: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "network": {
                    "egress": false,
                    "allowedHosts": ["example.com"],
                    "localBinding": false
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("blocked policy should parse: {error}"));
        blocked
            .validate()
            .unwrap_or_else(|error| panic!("disabled egress enforces every host list: {error}"));

        let managed: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "network": {
                    "egress": true,
                    "allowedHosts": ["example.com"],
                    "localBinding": false
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("managed policy should parse: {error}"));
        let error = managed
            .validate()
            .err()
            .unwrap_or_else(|| panic!("egress allowlist without a proxy should fail closed"));
        assert!(error.to_string().contains("network.outgoingProxy"));
    }

    #[test]
    fn host_allowlists_are_accepted_once_a_proxy_owns_them() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "network": {
                    "egress": true,
                    "allowedHosts": ["example.com", "*.internal.example.com", "127.0.0.1"],
                    "localBinding": false,
                    "outgoingProxy": {"frontEnds": ["http", "socks5"]}
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("proxy policy should parse: {error}"));
        policy
            .validate()
            .unwrap_or_else(|error| panic!("proxy policy should validate: {error}"));

        let proxy = policy
            .network
            .outgoing_proxy
            .unwrap_or_else(|| panic!("proxy section should be present"));
        assert!(proxy.exposes(ProxyFrontEnd::Http));
        assert!(proxy.exposes(ProxyFrontEnd::Socks5));
    }

    #[test]
    fn a_proxy_no_longer_accepts_a_descriptor_or_a_token() {
        for proxy in [
            r#"{"upstreamFd": 3, "frontEnds": ["http"]}"#,
            r#"{"token": "abc", "frontEnds": ["http"]}"#,
            r#"{"frontEnds": ["http"], "tlsTermination": {"certificateAuthorityFile": "/tmp/ca.pem"}}"#,
        ] {
            let parsed = serde_json::from_str::<SupervisorPolicy>(&format!(
                r#"{{
                    "mode": "workspace_write",
                    "network": {{"egress": true, "localBinding": false, "outgoingProxy": {proxy}}}
                }}"#
            ));
            assert!(parsed.is_err(), "should be rejected outright: {proxy}");
        }
    }

    #[test]
    fn proxy_policies_fail_closed_on_unusable_input() {
        let cases = [
            (
                r#""allowedHosts": [], "outgoingProxy": {"frontEnds": []}"#,
                "frontEnds",
            ),
            (
                r#""allowedHosts": [""], "outgoingProxy": {"frontEnds": ["http"]}"#,
                "empty host",
            ),
            (
                r#""allowedHosts": ["*"], "outgoingProxy": {"frontEnds": ["http"]}"#,
                "*.suffix",
            ),
            (
                r#""allowedHosts": ["*.*.example.com"], "outgoingProxy": {"frontEnds": ["http"]}"#,
                "*.suffix",
            ),
            (
                r#""allowedHosts": ["user@example.com"], "outgoingProxy": {"frontEnds": ["http"]}"#,
                "*.suffix",
            ),
        ];
        for (network, expected) in cases {
            let policy: SupervisorPolicy = serde_json::from_str(&format!(
                r#"{{
                    "mode": "workspace_write",
                    "network": {{"egress": true, "localBinding": false, {network}}}
                }}"#
            ))
            .unwrap_or_else(|error| panic!("policy should parse ({network}): {error}"));
            let error = policy
                .validate()
                .err()
                .unwrap_or_else(|| panic!("policy should fail closed: {network}"));
            assert!(
                error.to_string().contains(expected),
                "expected {expected} in {error}"
            );
        }
    }

    #[test]
    fn a_proxy_without_egress_is_refused() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "workspace_write",
                "network": {
                    "egress": false,
                    "localBinding": false,
                    "outgoingProxy": {"frontEnds": ["http"]}
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("policy should parse: {error}"));
        let error = policy
            .validate()
            .err()
            .unwrap_or_else(|| panic!("a proxy without egress should fail closed"));
        assert!(error.to_string().contains("network.egress"));
    }

    #[test]
    fn full_access_cannot_carry_a_proxy() {
        let policy: SupervisorPolicy = serde_json::from_str(
            r#"{
                "mode": "full_access",
                "network": {
                    "egress": true,
                    "localBinding": true,
                    "outgoingProxy": {"frontEnds": ["http"]}
                }
            }"#,
        )
        .unwrap_or_else(|error| panic!("policy should parse: {error}"));
        let error = policy
            .validate()
            .err()
            .unwrap_or_else(|| panic!("full access should reject a proxy"));
        assert!(error.to_string().contains("network.outgoingProxy"));
    }
}
