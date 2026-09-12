# Happy Agent Supervisor

`@slopus/happy-agent-supervisor` is the small trusted native boundary used to
launch agent workloads without an intermediary shell. You hand it a policy and
an argument vector; it applies the operating system's own isolation and then
`execve`s your command inside it.

```text
caller
  │ policy JSON argument or trusted file
  │ argv after --
  ▼
supervisor
  ├─ Linux: user + mount + PID namespaces, private procfs, mount policy,
  │          seccomp, zero capabilities, no_new_privs
  └─ macOS: in-process Seatbelt profile
  ▼
execve(target, argv, inherited environment)
```

The package is two things in one npm name: a native executable per platform,
and a small TypeScript API that validates a policy and tells you where the
matching executable lives.

## Where it runs

| Platform   | Architecture | Rust target                  | Enforcement                                             |
| ---------- | ------------ | ---------------------------- | ------------------------------------------------------- |
| macOS      | arm64        | `aarch64-apple-darwin`       | Seatbelt profile installed in-process                   |
| macOS      | x64          | `x86_64-apple-darwin`        | Seatbelt profile installed in-process                   |
| Linux      | arm64        | `aarch64-unknown-linux-musl` | namespaces, mount policy, seccomp, capability removal   |
| Linux      | x64          | `x86_64-unknown-linux-musl`  | namespaces, mount policy, seccomp, capability removal   |
| Windows 11 | x64          | `x86_64-pc-windows-gnu`      | Codex restricted tokens, Happy accounts, ACLs, firewall |

The Linux binaries are static musl builds, so they run on any distribution and
can be mounted read-only into a container that has no toolchain of its own.
The Windows 11 x64 adapter builds a pinned Codex native sandbox
with separate Happy OS identities; see `native/windows/source.json` and the license notices there.
Run `pnpm build:native:windows` with the specified Rust toolchain installed. Set
`HAPPY_CODEX_SOURCE_DIR` to reuse a checkout of the exact pinned commit. Building does not
provision the sandbox. First execution requires one-time native setup; host allowlist proxy
and independent listener policies currently fail closed until their Windows implementation
is complete. The matching Windows supervisor and helpers are published starting with `0.0.9`.

Windows retains Codex's native restricted-token model. A folder granting write access to
`Everyone` can satisfy that token's write check even outside the selected writable roots.
This release does not include Codex TUI's additional world-writable-folder audit; use normal
per-user project directories. Broader filesystem hardening is deferred.

## Install

```sh
npm install @slopus/happy-agent-supervisor
pnpm add @slopus/happy-agent-supervisor
```

Nothing is downloaded by a post-install script. The native binaries ship as
ordinary npm packages, and the root package names them as optional dependencies
guarded by `os` and `cpu`, so your package manager installs exactly the one that
matches the machine and silently skips the other three.

The binaries are published as versions of the same npm name, one per target:

| Optional dependency                           | Resolves to                                             |
| --------------------------------------------- | ------------------------------------------------------- |
| `@slopus/happy-agent-supervisor-darwin-arm64` | `@slopus/happy-agent-supervisor@<version>-darwin-arm64` |
| `@slopus/happy-agent-supervisor-darwin-x64`   | `@slopus/happy-agent-supervisor@<version>-darwin-x64`   |
| `@slopus/happy-agent-supervisor-linux-arm64`  | `@slopus/happy-agent-supervisor@<version>-linux-arm64`  |
| `@slopus/happy-agent-supervisor-linux-x64`    | `@slopus/happy-agent-supervisor@<version>-linux-x64`    |

Each of those packages contains one executable at
`vendor/<rust-target>/bin/happy-agent-supervisor` plus a `SHA256SUMS` file for it.

### Getting a binary for another platform

Two cases need a binary that does not match the host: building a Linux image on
a Mac, and shipping a container that carries the supervisor. Install the target
package explicitly and read its path from your build script:

```sh
# The binary you want to copy into a linux/amd64 image.
npm install --no-save @slopus/happy-agent-supervisor@0.0.3-linux-x64
```

Or ask your package manager for every variant at once, which is what a release
pipeline usually wants:

```sh
npm install --force \
  @slopus/happy-agent-supervisor@0.0.3-linux-x64 \
  @slopus/happy-agent-supervisor@0.0.3-linux-arm64
```

Then point the container at it:

```ts
import { resolveLinuxSupervisorBinary } from "@slopus/happy-agent-supervisor";

// Accepts OCI, Node.js, and Rust spellings: amd64 | x64 | x86_64 | arm64 | aarch64.
const hostPath = resolveLinuxSupervisorBinary("amd64");
// docker run -v ${hostPath}:/usr/local/bin/happy-agent-supervisor:ro ...
```

## Using the TypeScript API

```ts
import { spawn } from "node:child_process";
import { parseSupervisorPolicy, resolveSupervisorBinary } from "@slopus/happy-agent-supervisor";

const policy = parseSupervisorPolicy({
    mode: "workspace_write",
    allowedWritePaths: ["/work/project"],
    network: { egress: false, localBinding: false },
});

const child = spawn(
    resolveSupervisorBinary(),
    ["--policy", JSON.stringify(policy), "--", "/usr/bin/env", "node", "build.mjs"],
    { cwd: "/work/project", stdio: "inherit" },
);
```

`parseSupervisorPolicy(value)` validates against the TypeBox schema and throws a
readable error listing every offending field; the schemas and their `Static`
types are exported if you want to compose them yourself.

`resolveSupervisorBinary(binaryPath?)` returns the executable for the current
host, and `resolveLinuxSupervisorBinary(architecture, binaryPath?)` returns a
Linux one regardless of host. Both accept an explicit path that wins over
lookup — useful in tests and for a locally built binary — and both fall back to
this repository's `native/target` build directories when the optional package is
not installed. If neither is present they throw, naming the package to reinstall.

## Command line

Policy and command are ordinary arguments, matching Codex's direct `sandbox-exec -p` invocation:

```sh
happy-agent-supervisor --policy '{"mode":"workspace_write","network":{"egress":false,"localBinding":false}}' -- /bin/sh -c 'printf "%s\n" "$VALUE"'
happy-agent-supervisor --policy-file /trusted/policy.json -- /usr/bin/env
```

Exactly one of `--policy` and `--policy-file` is required, and everything after `--` is the target
command. Policy files are read and closed before sandbox setup. Policy JSON is limited to 1 MiB and
rejects unknown fields. The direct form creates no inherited descriptor beyond ordinary stdin,
stdout, and stderr.
A supervisor-level failure — a bad argument, an invalid policy, an enforcement
step that would not apply — exits `125` with a message on stderr, which keeps it
distinguishable from the workload's own status. Otherwise the workload's exit
status is reproduced as its own.

## Policy

The policy names match `ComputePermissions`:

```json
{
    "mode": "workspace_write",
    "allowedReadPaths": [],
    "deniedReadPaths": [],
    "allowedWritePaths": [],
    "deniedWritePaths": [],
    "network": {
        "egress": true,
        "allowedHosts": [],
        "localBinding": false
    }
}
```

`mode` is one of `read_only`, `workspace_write`, `auto`, or `full_access`. For
`workspace_write` and `auto`, the process working directory is the workspace
write root — the cwd is the single source of truth, so it is not repeated in the
document. Denials win over grants. Linux write-denied paths and writable roots
must already exist so the supervisor never creates a user-visible mount point
while privileged.

## Outgoing proxy

Filtered egress is asked for by adding `network.outgoingProxy`, which names only
the front-ends to offer inside the sandbox:

```json
{
    "network": {
        "egress": true,
        "allowedHosts": ["example.com", "*.internal.example.com"],
        "localBinding": false,
        "outgoingProxy": { "frontEnds": ["http", "socks5"] }
    }
}
```

The supervisor provides the whole proxy. It forks an egress process before the
sandbox exists and joins the two with a socketpair, so the caller supplies no
descriptor and no token, and nothing inside the sandbox reaches the proxy — or
anything else — by address. The workload is given ordinary `HTTP_PROXY` and
`ALL_PROXY` addresses on loopback, carrying a secret generated for that one
invocation; both front-ends refuse a client that does not present it, as HTTP
Basic and as RFC 1929 respectively.

The egress process decides every destination. The requested name must match one
`allowedHosts` entry exactly or under one `*.suffix`, and the address that name
actually resolved to must not be loopback, private, link-local, or multicast
unless the policy named that IP literal directly. A bare `*` is refused: open
egress is expressed by configuring no proxy at all, and an empty list with a
proxy configured reaches nothing.

Egress with a non-empty `allowedHosts` and no proxy fails closed, because nothing
would be enforcing the list. A host list with egress disabled is already enforced
by the isolated network namespace. No TLS is terminated anywhere, so the boundary
is which host may be reached rather than what is sent to it.

## Process hardening

The supervisor runs as the same user as the workload and holds the workload's
only route out of the jail, so before it forks anything it makes itself harder
to read: non-dumpable on Linux, debugger attachment denied on macOS, and core
dumps disabled. The egress process asks for the same again after the fork,
because macOS gives a child fresh process flags. Any of these failing stops the
run rather than continuing unprotected.

It also drops `LD_*` and `DYLD_*` from its own environment, so nothing chosen by
the caller is loaded into the process that is about to become the boundary. The
workload's environment is taken before that happens and passed on unchanged: a
sandboxed build may legitimately need `LD_LIBRARY_PATH`, and the workload can set
these variables for its own children in any case.

## Building from source

The native workspace lives in `native/` and pins its own Rust toolchain.

```sh
pnpm build              # TypeScript API into dist/
pnpm build:native       # host supervisor binary into native/target/release/
pnpm test               # TypeScript tests
pnpm test:native        # Rust behavior tests, which need the host's real kernel
```

A binary built this way is picked up automatically by the resolvers, so a
checkout works without any published package installed. Release packaging and
publishing are described in [`release/README.md`](release/README.md).
