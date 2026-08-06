# Master plan 15: P2P networking

## Big picture

P2P networking must feel like joining one Rig to another, not like manually
configuring transport identities and trust records. Its main use is one primary
workstation Rig with secondary Rigs on remote Macs, Linux machines, and Windows
machines. A secondary manages its own computer and runs its own agents, including
platform-specific or hours-long work, while the primary provides one place to
configure and reach all of them.

Four layers must remain separate:

- **Connectivity** decides how bytes travel between Rigs.
- **Identity and trust** prove which stable Rig is on the other end.
- **Authority and capabilities** decide what that Rig may see or do.
- **Agent routing** locates an Agent ID without making its machine part of its
  identity.

A working connection proves none of the layers above it. In particular, a
trusted identity does not automatically receive control of the daemon socket or
the machine.

## Joining and verification

A person creates a short-lived invitation on the main Rig. The same flow is
available from the TUI, CLI, and HTTP API. The TUI begins at `/peering`, then
`/invite`, and produces a command of this form:

```sh
npm install -g @slopus/rig && rig join <invitation>
```

The invitation is an encoded bundle, not a secret or an encrypted message. It
contains the inviter's public key, stable instance ID, transport type, transport
address, and a one-time token. The token exists only in the inviting daemon's
memory, expires after five minutes, and is valid for one join.

Running `rig join` starts a pending connection. Both Rigs immediately display
the same Telegram-style sequence of emoji so the person can compare them and
detect a man-in-the-middle. The inviter shows it in the TUI and through the API
so Happy can show the same verification.

Until the emoji comparison has been accepted, the two Rigs are not peers and
cannot use each other's sessions, terminals, browsers, APIs, configuration, or
compute credentials. Only the bounded peering handshake needed to complete or
reject verification is allowed. Trust is persisted only after successful
verification.

After verification, the joining Rig receives a human-readable hello message
confirming that it is connected. Expired, reused, cancelled, mismatched, or
unverified invitations leave no trusted connection behind.

## Identity, names, and durable trust

Every Rig installation has one stable instance ID and one durable identity key.
The secret key lives in Rig's private storage. It is never stored in ordinary
configuration or included in an invitation.

Every instance also has a display name. Rig detects a useful default at runtime
from the machine name, preferring a friendlier device name where the platform
provides one, such as on macOS. This is a display name rather than a host name:
it may contain arbitrary printable characters, including spaces and emoji. The
name is stored in configuration and can be changed through the runtime
configuration API.

Trusted relationships live in Rig's main database, not in daemon configuration.
The durable record includes the peer's stable identity, public key, display
name, verified transport bindings, authority relationship, and the state needed
to reconnect. Configuration may enable transports and provide local transport
settings, but people do not maintain peer allowlists, endpoint IDs, or copied
public keys there.

Identity and transport remain independent. A trusted Rig is still the same peer
when its address changes, when a transport is replaced, or when several
transports reach it. Each Rig may trust multiple peers, use multiple transports
to the same peer, and perform multiple joins.

## Connectivity

Connectivity is pluggable and must use proven carriers rather than a bespoke
overlay or dedicated-port network. We do not build another ZeroTier-like
network: experience shows that such a network works poorly compared with
Tailscale.

The transports have different roles:

- **Direct TLS with mutual Rig authentication** is the preferred operational
  transport when machines already have private reachability, especially over
  Tailscale or another trusted private network. Both Rigs can connect and
  establish the same stable Rig trust without treating an IP address or
  certificate alone as the Rig's identity.
- **SSH** is an initiator-created carrier. SSH access proves that the initiator
  reached some account on a machine; it does not tell the main Rig which Rig
  process is on the other side. The same mutual Rig identity authentication is
  therefore mandatory inside the SSH channel. Conceptually, the authenticated
  Rig session used by direct connectivity is carried through SSH; SSH is not a
  substitute for the Rig handshake.
- **Iroh** is the easiest default bootstrap and onboarding transport because it
  provides discovery, NAT traversal, and relay connectivity with almost no
  setup. Its address is nevertheless exposed to discovery and relay
  infrastructure, relay operators can learn endpoint addresses, and corporate
  networks may block it. It is a poor protocol to depend on for normal
  operation and is therefore a lower-preference fallback once private or
  direct connectivity is available, despite being the default
  zero-configuration way to get the first connection.
- **WebRTC** is a possible future transport. It may provide more private or
  self-hosted signaling than Iroh. Whether to support it, and what signaling
  service it would use, remains open rather than being a commitment in this
  plan.

Transport selection and failover must preserve the stable peer identity and the
capability decision. Changing the carrier must never silently broaden trust or
authority. The exact selection and failover algorithm remains open.

## Ownership and authority

A standalone main or terminal Rig is its own root. The inviter in a Rig's first
successful join becomes that Rig's one durable master. `rig join` therefore
makes the joining Rig subordinate to its inviter.

Rigs joined later are ordinary peers. They cannot configure the Rig and can
only perform actions explicitly enabled by its master. Avoid a distributed
configuration consensus system: the master is the single configuration
authority for its secondaries.

A remote machine may already be compromised. Peer permissions must therefore
be explicit even after identity verification. The default, simple mode is
isolated:

- the secondary lives and works independently on its own machine;
- it does not learn about agents on the main Rig;
- it cannot initiate messages back into the main Rig or its Happy clients;
- a peer connection does not expose an unrestricted daemon socket, terminal,
  browser, filesystem, or configuration surface.

The master may enable an integrated mode and individual capabilities. That mode
can make agent communication and selected remote operations transparent, but it
does not erase the capability boundary. Configuration control remains reserved
to the master. The exact capability catalog remains open; default isolation and
master-only configuration do not.

## Central configuration and credentials

The main Rig centrally configures its secondaries rather than requiring each
machine to be maintained independently. Master-controlled distribution includes
Happy authorization, compute and provider credentials, prompts, skills,
plugins, and the capabilities granted to each peer.

Credential provisioning is optional and separate from the invitation. Tokens
are never placed in the encoded invitation, verification display, status
response, or logs. Only the master may add, replace, or remove remotely
provisioned credentials.

This is a narrow P2P exception to the account-routing plan's file-only
configuration rule: account routing remains transparent to models and its
routing topology remains configuration, while the master Rig gains an API for
securely provisioning the joined daemon's credential material.

## Cross-Rig agents and continuity

When integrated communication is enabled, the main Rig connects its secondaries
to one another and distributes dedicated authenticated, capability-scoped
channels. Agents can then message agents on other machines without every
secondary becoming a configuration authority.

Agent ID remains the identity of an agent. A node or network address must not be
encoded into it. The preferred direction is to locate an Agent ID by asking the
connected Rigs which one owns it, then cache the resulting node route for a
meaningful time. The exact discovery query, cache lifetime, invalidation, and
route recovery remain open.

Work belongs to the Rig running it. A secondary continues its local agents and
hours-long work when links or the main Rig are unavailable. Reconnection makes
that work and its current state visible again. Cross-Rig communication may pause
during a partition, but one machine's loss must not stop unrelated local work
on another machine.

## Order

First, establish stable instance identity, display names, database-backed trust,
the unique master relationship, and explicit capability records.

Second, add the short-lived invitation lifecycle and `rig join`, including the
same surface for the TUI, CLI, API, and Happy, with emoji verification gating
all peer authority.

Third, make the authenticated session transport-independent. Use Iroh for the
zero-configuration bootstrap, direct mutual TLS over private connectivity when
available, and the same Rig authentication inside SSH. Reconnect by stable
identity across transport changes.

Fourth, make isolated secondary operation complete: the master can start and
observe work within granted capabilities, while the secondary cannot discover
or initiate work on the main Rig and local work survives disconnection.

Fifth, add master-controlled distribution of configuration, Happy
authorization, credentials, prompts, skills, plugins, and capability settings.

Finally, add optional integrated agent communication, authenticated channels
between secondaries, Agent-ID discovery and route caching, and reconnection that
restores the distributed view without coupling the survival of local work.

## What done looks like

- A person can create an invitation in the TUI, CLI, or API and join another
  machine with the generated install-and-join command.
- Invitations are transparent encoded bundles with a memory-only, single-use
  token that expires after five minutes.
- Both machines show the same emoji verification key, and no peer capability is
  available before it is accepted.
- A successful join persists trust in the main database and sends the joining
  Rig a hello message; an unsuccessful join persists nothing.
- Every Rig has a stable identity and a friendly, editable display name that
  supports arbitrary printable characters.
- The first inviter is the joined Rig's durable master. Later peers cannot
  change configuration and receive only explicitly enabled capabilities.
- Iroh provides zero-configuration onboarding, while direct mutual TLS is
  preferred over private connectivity and SSH carries the same authenticated
  Rig identity handshake. A transport change does not change the peer.
- A compromised or merely connected peer receives no implicit access to the
  daemon, machine, agents, terminals, browsers, or configuration.
- Isolated secondaries can run platform-specific and long-running work without
  learning about or messaging agents on the main Rig.
- The master can distribute configuration and optionally provision compute
  credentials without putting secrets in invitations, status, or logs.
- Integrated mode can create authenticated, capability-scoped channels between
  secondaries and let agents communicate across machines by Agent ID.
- Agent IDs contain no node address; discovery finds and caches a route instead.
- Local agents and work continue through network partitions and become visible
  again after reconnection.
- WebRTC remains a documented candidate rather than a promised transport.