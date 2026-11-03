# Runners learnings

## Runners have fixed tokens, not a join flow

An invitation and join step was proposed first. The person deploying a team node is usually an
agent running elsewhere, and it already writes the node's machine `happy.toml`; a join flow would
have needed a tool on the node and a second round trip for every runner. Each runner now has a
fixed token in `[runners.<id>]`, written to both machines at deployment, so a runner can be
provisioned before the node first starts. Removing the entry and restarting revokes it.

## The runner dials the daemon

Runners usually sit behind NAT and must not need an inbound port, so the runner opens the
connection and keeps it open. Both standalone and team nodes keep their listeners private behind
Tailcat, so `happy-agent runner` accepts a `tailcat:<address>[:<port>]` endpoint and dials through
the same embedded carrier the daemon uses for remote connections; `https://`, `http://`, and
`unix:` endpoints remain for private networks and local tests.

## One machine abstraction, not local and runner branches

The first port gave projects, workspaces, and Git separate local and runner implementations. The
user asked for one path: run the commands on a compute that is either this machine or a runner.
`machine(runnerId?)` now returns this machine's host compute or the runner's product compute, and
folder work is written once against it. The only remaining differences are capabilities this
machine has natively — the FFF index, non-recursive file watches, the SDK's restricted-environment
stdio transport for MCP, and the native Bun proxy fast path — and each has a runner equivalent.
README's "Parity with this machine" lists every feature and how it behaves on a runner.

## Live Git runs on the runner, not around it

Steve asked for every API to behave the same on runner folders, and Git state was the largest gap:
`GET …/git` answered `404`, `git/watch` left runner folders out, and the Happy integration refused
them. Live tracking was first treated as legacy too tied to this machine to port. It is now the same
`GitStateTracker` with the folder's machine behind it (`GitRepositoryMachine`): scans run on the
runner through the hardened scanner, untracked counts and binary bytes are read through the
runner's filesystem (`GitWorkingFiles`), and the runner's own watches drive it. Nothing about the
debounce, the path-scoped classification, or the fingerprint stale checks changed, so the two
cannot drift.

## One watch per folder on a runner, shared and bounded

Before, each of the eight most recently read runner folders had a recursive watch for file events
only. Live Git would have added another for the tree and one for the Git directory per worktree.
`RunnerWatches` (in the Git module) now owns them: one tree watch per folder, shared by
`files.updated` and Git; one Git-directory watch per common directory, shared by its worktrees and
skipping `objects`, `logs`, and `hooks`; at most 32 tree and 16 Git watches per runner, the rest
polled. A watch that ends — the runner went away, overflow — is re-armed with backoff and reported
as a change of everything, so the tracker rescans rather than trusting a gap.

The runner skips dependency and repository directories by name. Directories Git ignores are
derived from `ls-files --ignored --directory` on the runner and dropped on the daemon, because
compute 0.1.25 can take an ignore list only when a watch starts and a restarted watch can miss
changes. Those directories therefore still cost kernel watches and traffic on the runner; an
`ignorePaths` update in the runner protocol is the fix, and needs a compute release.

## Disconnects are seen within seconds, by both sides

Steve saw both sides of a Tailcat runner connection keep believing in it long after one side had
stopped, and requests to its folders answering `500`. Nothing in the goodbye path was wrong on its
own; the order around it was. The daemon disposed every runner machine before it said goodbye, and
its Tailcat exposure closed concurrently with this module, so the goodbye was usually written into
a carrier that was already gone. The daemon's channel stopped listening once it closed, so nothing
could wait for the close to be delivered. A stopping runner closed its WebSocket without a goodbye
and then closed its Tailcat carrier at once, which drops unflushed frames and sends no FIN. With
both ends silent, only the default idle timeout (45 s) noticed, after the HTTP forwarder's 30 s had
already turned the request into a `500`. A runner whose daemon restarted then backed off up to
30 s before it tried again.

Now each side says goodbye first and waits up to two seconds for its WebSocket to close before
closing anything underneath; the daemon's Tailcat closes after this module; both sides ping every
5 s and give up after 20 s of silence; a runner retries at most every 5 s for a minute after a
connection ends; and `RunnerDisconnectedError` maps to `503` like `RunnerUnavailableError`. A
deliberate stop is seen in about a second, a silent loss in at most about 25 s. A single frame
large enough to take 20 s on a slow relay would trip the idle timeout; none is close to that today.

## Secrets and port bridges on runners

Steve decided "we trust compute": a runner may receive the attached secrets a command selected.
The daemon resolves the selection when the command starts and sends the values in that one
command's `environment` (runner protocol 4), with `null` for every other attached secret's
variable so the runner's own environment cannot stand in for one that was not selected. The runner
applies them to the spawn and deletes them afterwards. While the process runs, the runner's user,
root there, and other commands running as that user can read them, as on any machine; a modified
runner could keep them. A command that selects nothing is sent unchanged, so runners older than
protocol 4 keep working for everything else and refuse only a selection, asking to be updated.
Containers still refuse, because Docker cannot give one command its own environment.

Port bridges listen on the runner through compute `network.listen` with `ownerOnly`, which the
runner enforces against its own socket table. USB and Bluetooth on runners are permanently
unsupported, reported as `runner_compute`, so apps hide them.

Workspace services were retired product-wide while this was being decided, so strict services on
runners were not built.

## Everything that touches a folder runs on the runner

Git, workspace checkouts, terminals, file watching, and the workspace proxy were all asked for
explicitly, not only agent commands. While a runner is the default nothing runs on the daemon's
machine and nothing falls back to it: a disconnected runner is an error that names it.
Git on a runner uses the Git authentication configured on that runner. The daemon does not
discover or proxy GitHub tokens, so remote repository access must be configured for the user
running Git there.

## This machine can stay the default

Steve asked for runners to be usable without giving up local work. `[runners] default = "local"`
keeps local execution on: the home project, new projects, bots, tasks, and Surface chats that name
no runner stay on this machine, and only projects registered or cloned with a `runnerId` go to a
runner. `local` is a reserved ID rather than a separate switch, so the setting reads as which
machine is the default. Internally a local default looks exactly like having no runners
(`defaultRunnerId` is undefined), so call sites ask only where a folder goes, never whether runners
exist. Without the setting nothing changed: one runner is the default automatically, and several
need `default`.

## A runner's paths follow the runner's platform

A Windows runner under a Linux daemon used to have its folders named with POSIX rules
(`C:\Users\x/happy/Bots/...`) and its agents told they ran on Linux. Every path composed or
compared for a runner now uses `paths(runnerId)` — `path.win32` or `path.posix` from the platform
the runner reported — and folders are laid out as a local installation on that platform would lay
them out. Agents in runner folders get `environment(runnerId, cwd)`, so the Windows PowerShell
guidance in the system prompt applies on Windows runners. Local paths are unchanged.

The runner's operating system release and shell travel in the `ready` frame at protocol 3, not in
`hello`: older daemons validate `hello` exactly and would refuse a runner that added fields there.
Because `@slopus/happy-agent-compute` and `@slopus/happy-agent-client` are consumed from npm, the
runner can only send them, and the daemon only store and show them, after both are released and
every pin is bumped. Until then the environment names the platform and no shell.

## A runner that is away fails at once

Each call on an absent runner used to wait ten seconds for it to return, so an agent turn that
reads AGENTS.md, skills, and its folder before inference stalled for minutes before failing. The
wait now counts from the moment the runner went away: a brief drop is still bridged, and once the
window has passed every call answers `runner_unavailable` immediately.

## Separate Linux users are local runners started through sudo

The request was to run agent work as a Linux user other than the daemon's, so that agent commands
cannot read the configuration, database, or credentials, with specific bots able to use a user of
their own. Every path that touches a folder is already written against a runner's compute, so each
user gets a local runner, started as `sudo -n -u <user> -- happy-agent runner --stdio` and spoken
to over stdio with the unchanged runner protocol, rather than a second, sudo-aware execution path.
The sudo command line is fixed and minimal so the sudoers rule can allow exactly that command; the
spawn passes only `PATH` and starts in `/`.

It fails closed: a missing sudo rule, an unknown user, a runner that stops before it is ready, or
an `id -un` that does not name the configured user fails the work with a message naming the user
and the reason, and nothing falls back to the daemon's user. A user that is the daemon's own is
refused, because it would only look separated. The daemon still starts when the default user's
runner cannot, so the operator can read the log and fix the sudo rule. Per-bot users are keyed by
bot ID, and an agent's user is unknown until `BotsModule` has bound its bots, so `userFor` refuses
until then instead of choosing the default.

`[execution]` cannot be combined with a default runner: then no work runs on the node's machine at
all, and that is the stronger separation. It can be combined with `[runners] default = "local"`,
since local work continues there. The API stays unchanged — folders are ordinary
folders on this machine — so a workload user that cannot start answers `503 runner_unavailable`.
