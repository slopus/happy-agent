# @slopus/happy-agent-compute

The machine a Happy agent works on: a filesystem, a shell, and the boundary around both.

An agent that can only think is not much use. It has to read a file, run a build, start a server, and
see what happened. This package is the thing underneath all of that — and, just as importantly, the
thing that decides what the agent is not allowed to touch.

## Compute

A `Compute` is one place the agent can work:

```ts
interface Compute {
    readonly id: string; // "host" | "docker" | "just-bash" | one registered later
    readonly kind: ComputeKind; // "host" | "docker" | "emulated"
    readonly cwd: string;
    readonly fs: ComputeFileSystem;
    readonly shell: ComputeShell;
    readonly services?: ComputeServices;
    readonly processes?: ComputeProcesses;
    readonly watcher?: ComputeWatcher;
    readonly network?: ComputeNetwork;
    dispose(ctx: Context): Promise<void>;
}
```

The same members mean the same thing in every backend, so code written against `Compute` does not
care which one it got. Which backend an agent has is chosen when it is built and never afterwards,
so nothing the agent does can move it to another machine. `dispose()` ends everything that compute
started, including commands still running in the background.

A compute holds no permissions of its own. That is the central idea of this package, and it is why
`Compute` has no `permissions` member: permission belongs to an action, not to a machine.

## Permissions

`ComputePermissions` is an immutable value passed into every call:

```ts
interface ComputePermissions {
    mode: ComputePermissionMode; // "read_only" | "workspace_write" | "auto" | "full_access"
    allowedReadPaths?: readonly string[];
    deniedReadPaths?: readonly string[];
    allowedWritePaths?: readonly string[];
    deniedWritePaths?: readonly string[];
    network: { egress: boolean; allowedHosts?: readonly string[]; localBinding: boolean };
}
```

The caller decides what one action may do and passes that decision in as the action is performed.
Nothing is remembered between calls, so a compute never holds an ambient policy that another part of
the program can change underneath a call already in flight, and there is no window between planning
a command and spawning it in which the boundary could have shifted. Narrowing permissions means
making the next call with a narrower value.

The mode is the coarse policy and the path lists refine it; a denial always beats a grant. Egress
and the ability to bind a listening socket are asked separately, because a build that fetches
dependencies and a dev server need opposite halves of "network access".

Build a value from a mode rather than spelling the lists out at every call site:

```ts
import { allowEverything, computePermissions } from "@slopus/happy-agent-compute";

const readOnly = computePermissions("read_only");
const build = computePermissions("workspace_write", {
    network: { egress: true, allowedHosts: ["registry.npmjs.org"], localBinding: false },
});
const reviewed = allowEverything();
```

For ordinary filesystem and shell operations, `full_access` is absolute: every filesystem and network restriction is gone, so it cannot
be combined with one. A value that tries — full access with a denied path, or with `egress: false` —
is rejected by `assertComputePermissions` rather than quietly resolved, because a caller who
believes they restricted something and a backend that ignores them is the worst outcome available to
a security boundary. A caller who wants most access with one exception is describing `auto` or
`workspace_write` with grants, and the error says so.

## Filesystem and shell

Every `ComputeFileSystem` call takes permissions first: `readFile(permissions, path)`,
`writeFile(permissions, path, content)`, `readdirPage(permissions, path, { limit })`, and the rest.
Paths are the ones that backend understands, resolved against `cwd`.

`ComputeShell.run(options)` carries the boundary in the same way, along with the command, an optional
cwd, a timeout, an output cap, a TTY flag, and the ids of any secret bundles the environment is
built from. A command that outruns its timeout is **not killed**. It is handed back as a background
session the agent can keep reading from, write to, and stop when it decides to — the opposite of what
most tools do, and the reason `startSession`, `readSession`, `killSession`, and `writeSession` exist.

Reading and stopping a session take no permissions: they act on a command whose boundary was fixed
when it started, and re-deciding it afterwards could only disagree with the process already there.
`writeSession` is the exception and does take them, because input is new instruction reaching a
process that may hold credentials.

## The product's own work

The shell is the agent's. Happy itself also has work to do on the machine — Git, terminals a person
opens, stdio MCP servers, watching a project for changes, previewing a web app — and when that
machine is a runner, it has to happen there too. Three optional capabilities carry it:

- `processes.start(ctx, { command, args, cwd, environment, terminal })` runs one program on pipes,
  or under Bun's pseudo-terminal when `terminal` gives a size. Output arrives through `onStdout` and
  `onStderr` and is held until someone listens; `write` resolves `false` when the caller should wait
  for the program to catch up; `pause` stops reading so a slow consumer slows the program down;
  `signal` reaches the whole process group.
- `watcher.watch(ctx, { path, ignore })` reports changed paths in batches. A batch marked
  `overflow` means some changes were not itemized and the reader should rescan.
- `network.connect(ctx, { host, port })` opens a TCP connection from the compute's machine, so a
  web app listening on a runner's loopback can be proxied from the daemon. `network.listen(ctx)`
  goes the other way: a loopback port on the compute's machine whose connections arrive at the
  caller, which is how Git on a runner reaches a credential proxy that never leaves the daemon.

These are the product's actions, not the agent's: they take no permissions, and the agent sandbox
does not apply to them. Callers must not hand them commands an agent chose. The host backend and
the runner backend provide all three; a backend without one leaves it undefined, and callers
refuse the feature rather than routing it somewhere else.

## The backends

### Strict workspace services

`compute.services` is a separate, optional capability for long-lived HTTP services. Its mandatory
isolation is never disabled by Full access. Starting and writing input require Auto or Full access;
the owner above compute reviews those operations. Ordinary shell behavior is unchanged.

The controller records an execution identity before calling `start(ctx, options)`, using a private
0700 control parent outside the workspace and inside `hostPolicy.privateDirectories`. The native
supervisor receives its credential through a private policy file. No credential is returned through
the service interface. A service has independent byte-position output readers, writable stdin or
PTY input, an `admitted` promise, and a `completion` promise. Admission means the command's sandbox
setup completed, not that an HTTP server is healthy. `completion` and `stop` wait for native owners,
all command descendants, mounts, and private bridges to be gone. `reconcile` confirms teardown after
a controller crash; it never restarts a command or signals a reused numeric PID. Incomplete evidence
blocks cleanup and preserves execution files.

If a completion failed to establish cleanup, a later successful `reconcile` releases that exact
execution's active slot and process-group ownership. Disposal can then be retried without reopening
admission. Independent service reads use delta-only capture access, so an idle poll does not copy
the complete retained stdout and stderr buffers.

Selected inputs are live read-only files or directories. External edits remain visible; private
scratch paths, home, and temporary files are the only writable locations. Read-only input mounts
still permit named-pipe IPC with an outside process using a pipe in that tree; this accepted edge
does not grant ordinary file writes. Device files in selected inputs are denied. Outbound access is
the intersection of explicitly requested destinations, action permissions, and resolved user policy;
private-address destinations remain blocked. `connect(ctx)` reaches only the declared loopback HTTP
port through the private native bridge. The product layer must enforce workspace access and HTTP
protocol restrictions before using that trusted transport.

The initial implementation requires Linux 5.12+, unprivileged user namespaces, and a pre-existing
administrator-delegated cgroup v2 parent owned by the daemon user with memory and process controls.
Compute never changes host security settings or creates the delegation. Unsupported hosts and
backends fail closed, without falling back to an ordinary shell. The minimal runtime exposes system
executables and libraries; tools installed only in the host user's home are not implicitly available.

### Filesystem and shell backends

Each backend is a `ComputeProvider`: an id, a one-line description, a TypeBox config schema, a
`create` function, and `providesHostFileSystemAccess(config)` — the answer to "is this about to hand
an agent the real machine?", which the layer above uses to warn, confirm, or refuse before anything
runs.

**Host** (`host`) — the real filesystem and shell of this machine. Restricted commands invoke
`@slopus/happy-agent-supervisor` directly; its native Seatbelt (macOS) or namespace/mount/seccomp
boundary (Linux) owns the command's filesystem and network policy.

```ts
const compute = createHostCompute({ ctx, cwd, hostPolicy });
```

**Docker** (`docker`) — a filesystem and shell inside a container, either one the caller attached to
by name or one this package created from an image. Managed containers mount the architecture-matched
static Linux supervisor read-only at `/tools/happy-agent-sandbox`, and restricted commands invoke
that binary in the container. An attached container must already have the same read-only mount;
its source must be the matching installed NPM artifact rather than an arbitrary executable. It must
also be started with `seccomp=unconfined`, `apparmor=unconfined`, and
`systempaths=unconfined`, allowing the supervisor to replace Docker's outer restrictions with its
own narrower filter and mounts. Compute fails closed rather than changing a running container. Set
`architecture` when Docker runs an emulated image, such as `amd64` on an arm64 host. The two
configuration shapes are mutually exclusive at the validation boundary, and settings that only
apply while creating a container exist only on the image branch.

On Ubuntu with restricted unprivileged user namespaces, `apparmor=unconfined` alone may not allow
nested namespace setup. A managed container can select an administrator-installed profile with
`apparmorProfile: "happy-compute"`; that profile must permit the supervisor's namespace operations.
Compute never installs profiles or disables AppArmor. Missing or incompatible profiles fail closed,
and reusing a managed container with a different requested profile is refused. Attached containers
must already have their required profile selected at creation time.

```ts
const compute = await dockerComputeProvider.create(ctx, {
    image: "node:24",
    workingDirectory: "/work",
    architecture: "arm64",
    mounts: [{ source: projectDirectory, target: "/work" }],
});
```

**Just-bash** (`just-bash`) — a Bash-compatible shell running entirely inside this process, with no
host processes at all, backed either by an in-memory filesystem or by one real folder. It is fast, it
is deterministic, and the memory variant touches nothing real, which makes it the right choice for
tests and for the gym. The storage shape is explicit because durability differs; it is never inferred
from which optional fields happen to be present.

```ts
const compute = createJustBashCompute({ storage: "memory", cwd: "/work" });
const compute = createJustBashCompute({ storage: "folder", cwd: "/work", folder: "/some/path" });
```

**Runner** (`runner`) — a filesystem, shell, processes, file watching, and connections on a separate
machine dedicated to running work, so the daemon's own machine, with its database and provider
credentials, never runs agent code. The
runner serves a host compute behind the same native supervisor; the daemon reaches it through a
`RunnerLink` over whatever authenticated channel the runner dialed in on. A runner compute needs a
live link rather than a configuration value, so it is built directly instead of through the
provider registry. See [the runner protocol](sources/runner/README.md).

```ts
const link = new RunnerLink(ctx, { name: "Build box", instanceId: daemonInstanceId });
await link.accept(channelTheRunnerOpened);
const compute = await createRunnerCompute(ctx, { link, computeId: agentId, cwd: "/srv/work/app" });
```

## Choosing a backend at runtime

`ComputeProviders` is the one place a machine is built from a name. Configuration arrives as
data — from a file, a protocol message, or a person's choice — so the name and the settings are both
untrusted until checked. The registry resolves the id, validates the settings against that provider's
schema, and only then builds:

```ts
const providers = new ComputeProviders([
    hostComputeProvider,
    dockerComputeProvider,
    justBashComputeProvider,
]);
const compute = await providers.create(ctx, "host", { cwd });
```

Adding a kind of machine is registering one provider; nothing else needs to know which kinds exist.

## Host policy

Some of the files a compute must protect belong to the agent product itself: the configuration that
decides what a command may reach, the directory holding its credentials, the skills it can read.
Which files those are is not something this package can know, so the embedder describes its own
layout through `ComputeHostPolicy` — protected project files, the subset of those read as network
policy, private directories, readable directories, and the environment variables whose values name
private paths.

It is entirely optional. `EMPTY_COMPUTE_HOST_POLICY` is deliberately empty, because the universally
sensitive paths — SSH keys, cloud credentials, shell history — are not the embedder's to declare and
are protected by the package on its own.

## Restricted execution

`sources/supervisor/` translates one immutable `ComputePermissions` value into the native supervisor
policy. Like Codex's macOS Seatbelt path, the policy is passed directly as an argument and the
workload receives ordinary stdin with only descriptors 0, 1, and 2. The supervisor itself supplies
filtered HTTP and SOCKS egress, so compute does not create a host/Docker proxy or socket bridge for
protections the supervisor already owns. Existing project policy files are denied directly.
macOS denies missing protected paths natively. On Linux and native Windows, the protected-create
monitor removes a missing protected path that a restricted command creates, so nothing is ever
materialized at those paths.

On native Windows, read-only commands that run often, such as Git status scans, can use
`createHostCommandWorker`. It keeps one sandboxed runner per workspace, so a stream of commands
pays for one sandbox logon and one private desktop instead of one of each per command.

### The Windows shell runner

On native Windows every restricted command used to start its own supervisor, and every supervisor
paid for a sandbox setup refresh, a logon of the sandbox account, and a private desktop. Each of
those is expensive for the whole machine, not just for the command: the logon is work for the
security subsystem, and every desktop holds graphics memory. An agent that runs hundreds of short
commands turned that into visible system load. The restricted host shell therefore runs workspace
commands in a long-lived `SandboxShellRunner` (`happy-agent-supervisor --shell-runner`), which pays
those costs once and then runs commands for as long as it is in use.

The runner is built so that sharing it never weakens the sandbox:

- **One runner per exact policy.** Runners are keyed by a hash of the runner's whole command line:
  supervisor, policy, state directory, and workspace. Two callers share a runner only when every
  permission is identical, so a command never runs under a broader or narrower sandbox than it
  asked for. A command whose working directory is not the workspace itself keeps the one-shot path,
  because the supervisor prepares write access for the folder it is given.
- **The runner holds no environment for commands.** Each request carries the command's complete
  environment. Nothing one command sets can reach the next, and the runner's own environment is
  used only to start the sandbox.
- **Every command is still isolated.** Each command gets its own restricted token, its own job
  object, and its own scratch folder, which is its `TEMP` and is deleted when it ends. Stopping a
  command ends its whole process tree without touching any other command.
- **Commands run concurrently.** Frames on the pipe name the command they belong to, and each
  command has its own thread inside the sandbox, so a slow or blocked command never holds up
  another. Commands may have a pseudo-terminal and input, exactly as before.
- **One private desktop per runner.** Commands share the runner's desktop instead of creating one
  each.
- **Its read restrictions are re-checked before every command.** Deny-read ACLs belong to the
  sandbox group, and every setup reconciles the group's whole set to its own workspace, so another
  workspace's setup can revoke a deny this runner relies on: the user profile, denied to a
  workspace outside it, is the important case. Before each command the runner compares the
  persisted deny-read state with what its own setup left there, and repeats its setup refresh when
  another setup changed it. A command therefore starts with its deny set in force, exactly as a
  one-shot command does; if the refresh fails, the command is refused. The scan worker does the
  same.
- **A crash is loud and bounded.** If the runner dies, every command it was running ends with an
  error saying so; none is left waiting. The next command starts a new runner, but only after a
  backoff that starts at one second, doubles up to five minutes, and resets once a runner has
  stayed up for a minute. During the backoff commands are refused with a readable message
  instead of each starting a sandbox setup of its own, which is how setup storms begin.
- **Its own lifetime.** A runner lives in its own named context derived from the root, never in
  the context of the tool call or agent that first needed it, so it never retains a finished call.
  It stops after five minutes without commands. Closing its stdin, including when the daemon
  exits, stops every command it runs and then the runner.

Setting `HAPPY_WINDOWS_SHELL_RUNNER=0` returns every restricted command to the one-shot path.

The five native supervisor artifacts are installed as optional dependencies so Docker can run a
Linux supervisor even when the caller is on macOS. The package dependency is exactly
versioned; platform aliases resolve the matching Darwin or Linux arm64/x64 binary, or the Windows
x64 supervisor with its matching Happy runner and setup helper. The workspace install includes
these platforms so a macOS checkout can also package the Linux artifact for a Docker image.

Windows 11 uses Happy's separate sandbox accounts and restricted tokens with scoped filesystem
ACLs and firewall rules. Installation setup is shared across projects; ordinary project commands
do not require repeated elevation. Restricted Windows networking supports offline or explicitly
online execution; selective host allowlists and independently allowed local listeners are rejected.
Approved full access uses the ordinary caller's permissions. The next restricted command receives
a fresh restricted token. Neither mode requires an installed Codex application.

Windows write-boundary checks target ordinary per-user project directories. The inherited
Codex token model can also write to folders with `Everyone` write access, and this release
does not include Codex TUI's separate permissive-folder audit. Such ACLs are outside this
release's isolation guarantee; additional hardening is deferred.

## Processes

`sources/processes/` is the process machinery the host backend runs on, and it is what makes the
shell semantics in master plan 8 work: delta-only reads, stdin into a running session, graceful-then-
forceful tree kill, process-group reaping after a launcher exits, and the timeout that backgrounds a
command rather than killing it.

Background work belongs to the compute's own lifetime, never to the tool call that happened to start
it, so a finished call is never retained by a process it left running.

Windows uses the system Windows PowerShell by default. Its own built-in modules precede inherited
PowerShell 7 module paths, preserving access to cmdlets such as `Get-Acl` when Happy is launched
from a PowerShell 7 environment. Other configured module paths remain available.

## Tests

```sh
pnpm test              # unit tests, no host side effects
pnpm test:live         # live tests against the real host, Docker, and just-bash backends
pnpm test:live:host    # one backend at a time
pnpm test:live:docker
pnpm test:live:just-bash
pnpm test:bun          # processes and runners under Bun, the runtime Happy Agent ships on
```

Terminals for the product's own programs use Bun's pseudo-terminal, so their tests run only under
`pnpm test:bun`; under Node, `processes.start` refuses a terminal with `ENOTSUP`.

The live tests exercise real sandboxes and a real Docker daemon, so they are opt-in through
`HAPPY_AGENT_COMPUTE_LIVE_TEST` and are not part of the default run.
The native Windows release gate uses `HAPPY_AGENT_COMPUTE_WINDOWS_LIVE_TEST=1` and exercises
workspace/read-only/full-access transitions, denied reads, and real offline/online networking.
It requires an already provisioned Happy sandbox; set `HAPPY_WINDOWS_SANDBOX_NO_PROVISION=1`
to prevent tests from initiating installation setup.
