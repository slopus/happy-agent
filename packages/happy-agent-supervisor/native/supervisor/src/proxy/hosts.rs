//! Which destinations the egress process is allowed to reach.
//!
//! Two questions are asked, and both have to be answered before a socket is opened. The name the
//! workload asked for must be in the command's list, and the address that name actually resolved to
//! must not point back inside. The second question is the one that only matters now that the
//! supervisor performs the connect itself: an allowlisted name pointing at `127.0.0.1` or
//! `169.254.169.254` would otherwise reach straight back into the host.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// One command's host list, as the egress process enforces it.
///
/// An empty list reaches nothing. Open egress is expressed by configuring no proxy at all, not by
/// configuring a proxy that permits everything.
pub(crate) struct HostPolicy {
    names: Vec<HostPattern>,
    literals: Vec<IpAddr>,
    service_destinations: Option<Vec<(String, u16)>>,
}

enum HostPattern {
    Exact(String),
    /// The `.example.com` of a `*.example.com` entry.
    Suffix(String),
}

impl HostPolicy {
    pub(crate) fn new(allowed_hosts: &[String]) -> Self {
        let mut names = Vec::new();
        let mut literals = Vec::new();
        for host in allowed_hosts {
            let host = normalize_name(host);
            if let Ok(address) = host.parse::<IpAddr>() {
                literals.push(normalize_address(address));
                continue;
            }
            match host.strip_prefix("*.") {
                // A pattern that is only a wildcard is refused when the policy is validated.
                // Dropping it here as well keeps this side fail-closed on its own.
                Some(suffix) if !suffix.is_empty() && !suffix.contains('*') => {
                    names.push(HostPattern::Suffix(format!(".{suffix}")));
                }
                Some(_) => {}
                None if host.contains('*') => {}
                None => names.push(HostPattern::Exact(host)),
            }
        }
        Self {
            names,
            literals,
            service_destinations: None,
        }
    }

    #[cfg(any(target_os = "linux", test))]
    pub(crate) fn for_service(destinations: &[crate::service_policy::ServiceDestination]) -> Self {
        let mut policy = Self::new(
            &destinations
                .iter()
                .map(|destination| destination.hostname.clone())
                .collect::<Vec<_>>(),
        );
        policy.service_destinations = Some(
            destinations
                .iter()
                .map(|destination| (normalize_name(&destination.hostname), destination.port))
                .collect(),
        );
        policy
    }

    pub(crate) fn permits_destination(&self, host: &str, port: u16) -> bool {
        self.permits_name(host)
            && self
                .service_destinations
                .as_ref()
                .is_none_or(|destinations| {
                    destinations.iter().any(|(name, allowed_port)| {
                        *name == normalize_name(host) && *allowed_port == port
                    })
                })
    }

    /// Whether the command named this destination.
    pub(crate) fn permits_name(&self, host: &str) -> bool {
        let host = normalize_name(host);
        if let Ok(address) = host.parse::<IpAddr>() {
            return self.names_address(normalize_address(address));
        }
        self.names.iter().any(|pattern| match pattern {
            HostPattern::Exact(name) => name == &host,
            HostPattern::Suffix(suffix) => host.len() > suffix.len() && host.ends_with(suffix),
        })
    }

    /// Whether the address a name resolved to may be connected to.
    ///
    /// An address inside the host is reachable only when the policy named that literal itself,
    /// which is the one case where the caller has already said what it meant.
    pub(crate) fn permits_address(&self, address: IpAddr) -> bool {
        let address = normalize_address(address);
        if self.service_destinations.is_some()
            && let IpAddr::V6(address) = address
        {
            let segments = address.segments();
            // Service egress uses ordinary global IPv6 only. Translation and tunnel
            // prefixes can encode a private IPv4 destination behind an apparently public IP.
            if segments[0] & 0xe000 != 0x2000
                || segments[0] == 0x2002
                || (segments[0] == 0x2001 && segments[1] < 0x0200)
            {
                return false;
            }
        }
        (self.service_destinations.is_none() && self.names_address(address))
            || !is_private_address(address)
    }

    fn names_address(&self, address: IpAddr) -> bool {
        self.literals.iter().any(|literal| literal == &address)
    }
}

fn normalize_name(host: &str) -> String {
    let host = host.trim_end_matches('.');
    let host = host.strip_prefix('[').unwrap_or(host);
    let host = host.strip_suffix(']').unwrap_or(host);
    host.to_ascii_lowercase()
}

/// Collapses an IPv4-mapped IPv6 address onto the IPv4 address it carries, so one destination has
/// one representation whichever way a client spelled it.
fn normalize_address(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(address) => match address.to_ipv4_mapped() {
            Some(mapped) => IpAddr::V4(mapped),
            None => IpAddr::V6(address),
        },
        address => address,
    }
}

pub(crate) fn is_private_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_private_ipv4(address),
        IpAddr::V6(address) => is_private_ipv6(address),
    }
}

fn is_private_ipv4(address: Ipv4Addr) -> bool {
    let [first, second, third, _] = address.octets();
    first == 0
        || first == 10
        || first == 127
        || (first == 100 && (64..=127).contains(&second))
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 0 && (third == 0 || third == 2))
        || (first == 192 && second == 168)
        || (first == 198 && (second == 18 || second == 19))
        || (first == 198 && second == 51 && third == 100)
        || (first == 203 && second == 0 && third == 113)
        // Multicast, reserved, and broadcast.
        || first >= 224
}

fn is_private_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    // `::ffff:a.b.c.d` and the deprecated `::a.b.c.d` both carry an IPv4 address, and `::1` and
    // `::` land here too, where their embedded octets are already refused.
    if segments[..5].iter().all(|segment| *segment == 0)
        && (segments[5] == 0 || segments[5] == 0xffff)
    {
        return is_private_ipv4(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            (segments[6] & 0xff) as u8,
            (segments[7] >> 8) as u8,
            (segments[7] & 0xff) as u8,
        ));
    }
    // Unique local, link-local, multicast, and documentation.
    (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] & 0xff00) == 0xff00
        || (segments[0] == 0x2001 && segments[1] == 0x0db8)
}

#[cfg(test)]
mod tests {
    use super::{HostPolicy, is_private_address};

    fn policy(hosts: &[&str]) -> HostPolicy {
        HostPolicy::new(
            &hosts
                .iter()
                .map(|host| (*host).to_string())
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn names_match_exactly_or_under_a_suffix_wildcard() {
        let policy = policy(&["Example.com", "*.internal.example.com"]);

        assert!(policy.permits_name("example.com"));
        assert!(policy.permits_name("EXAMPLE.COM."));
        assert!(policy.permits_name("api.internal.example.com"));
        assert!(policy.permits_name("deep.api.internal.example.com"));
        assert!(!policy.permits_name("internal.example.com"));
        assert!(!policy.permits_name("notexample.com"));
        assert!(!policy.permits_name("example.com.evil.test"));
    }

    #[test]
    fn services_require_exact_ports_and_never_allow_private_literals() {
        use crate::service_policy::ServiceDestination;
        let policy = HostPolicy::for_service(&[
            ServiceDestination {
                hostname: "example.com".into(),
                port: 443,
            },
            ServiceDestination {
                hostname: "127.0.0.1".into(),
                port: 80,
            },
        ]);
        assert!(policy.permits_destination("EXAMPLE.COM.", 443));
        assert!(!policy.permits_destination("example.com", 80));
        assert!(!policy.permits_destination("other.example.com", 443));
        for address in [
            "127.0.0.1",
            "::ffff:127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "64:ff9b::a00:1",
            "2002:a00:1::",
            "2001::1",
        ] {
            assert!(
                !policy.permits_address(address.parse().unwrap_or_else(|error| panic!("{error}")))
            );
        }
        assert!(
            policy.permits_address(
                "2606:4700:4700::1111"
                    .parse()
                    .unwrap_or_else(|error| panic!("{error}"))
            )
        );
    }

    #[test]
    fn an_empty_list_reaches_nothing_and_a_bare_wildcard_is_not_a_list() {
        assert!(!policy(&[]).permits_name("example.com"));
        assert!(!policy(&["*"]).permits_name("example.com"));
        assert!(!policy(&["*."]).permits_name("example.com"));
    }

    #[test]
    fn addresses_inside_the_host_are_refused_unless_the_policy_named_them() {
        let named = policy(&["127.0.0.1"]);
        assert!(named.permits_name("127.0.0.1"));
        assert!(
            named.permits_address(
                "127.0.0.1"
                    .parse()
                    .unwrap_or_else(|error| panic!("{error}"))
            )
        );

        let by_name = policy(&["localhost", "metadata.internal"]);
        assert!(by_name.permits_name("localhost"));
        for address in [
            "127.0.0.1",
            "::1",
            "169.254.169.254",
            "10.0.0.5",
            "::ffff:127.0.0.1",
        ] {
            let address = address
                .parse()
                .unwrap_or_else(|error| panic!("{address}: {error}"));
            assert!(
                !by_name.permits_address(address),
                "a name the policy allows must not reach {address}"
            );
        }
        assert!(
            by_name.permits_address(
                "93.184.216.34"
                    .parse()
                    .unwrap_or_else(|error| panic!("{error}"))
            )
        );
    }

    #[test]
    fn every_reserved_range_counts_as_private() {
        for address in [
            "0.0.0.0",
            "10.1.2.3",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "172.16.0.1",
            "192.0.0.1",
            "192.0.2.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "255.255.255.255",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
        ] {
            let parsed = address
                .parse()
                .unwrap_or_else(|error| panic!("{address}: {error}"));
            assert!(is_private_address(parsed), "{address} should be private");
        }
        for address in ["1.1.1.1", "93.184.216.34", "2606:4700::1111"] {
            let parsed = address
                .parse()
                .unwrap_or_else(|error| panic!("{address}: {error}"));
            assert!(!is_private_address(parsed), "{address} should be public");
        }
    }
}
