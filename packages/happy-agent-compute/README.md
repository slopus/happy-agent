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

`full_access` is absolute: it means every filesystem and network restriction is gone, so it cannot
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

## The backends

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
Missing protected paths are never materialized: macOS denies them natively, while the
protected-create monitor is Linux-only, matching Codex's platform split.

The four static supervisor artifacts are installed as optional dependencies so Docker can run a
Linux supervisor even when the caller is on macOS. The package dependency is exactly
`@slopus/happy-agent-supervisor@0.0.5`; platform aliases resolve the matching darwin or Linux
arm64/x64 binary. The workspace pnpm install configuration includes both Darwin and Linux
arm64/x64 targets, so a macOS checkout downloads the Linux artifact needed by an emulated Docker
image.

## Processes

`sources/processes/` is the process machinery the host backend runs on, and it is what makes the
shell semantics in master plan 8 work: delta-only reads, stdin into a running session, graceful-then-
forceful tree kill, process-group reaping after a launcher exits, and the timeout that backgrounds a
command rather than killing it.

Background work belongs to the compute's own lifetime, never to the tool call that happened to start
it, so a finished call is never retained by a process it left running.

## Tests

```sh
pnpm test              # unit tests, no host side effects
pnpm test:live         # live tests against the real host, Docker, and just-bash backends
pnpm test:live:host    # one backend at a time
pnpm test:live:docker
pnpm test:live:just-bash
```

The live tests exercise real sandboxes and a real Docker daemon, so they are opt-in through
`HAPPY_AGENT_COMPUTE_LIVE_TEST` and are not part of the default run.
