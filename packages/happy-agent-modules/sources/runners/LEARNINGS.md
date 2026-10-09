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
stdio transport for MCP, and the native Bun proxy fast path. The daemon's embedded Git tracking
(live snapshots, working-tree watches, untracked counts) is legacy and deliberately not ported to
runners; Git commands that create worktrees and clones do run there.

## Everything that touches a folder runs on the runner

Git, workspace checkouts, terminals, file watching, services, and the workspace proxy were all
asked for explicitly, not only agent commands. Sandboxed services are the exception for now: the
runner protocol has no isolated-services capability, so starting one for a runner or container
agent fails with a message naming runners. Once any runner is configured nothing runs on the
daemon's machine and nothing falls back to it: a disconnected runner is an error that names it.
Repository tokens still never leave the daemon — Git on a runner reaches back to the daemon's
credential proxy through a loopback listener carried over the runner connection.

## A runner that is away fails at once

Each call on an absent runner used to wait ten seconds for it to return, so an agent turn that
reads AGENTS.md, skills, and its folder before inference stalled for minutes before failing. The
wait now counts from the moment the runner went away: a brief drop is still bridged, and once the
window has passed every call answers `runner_unavailable` immediately.
