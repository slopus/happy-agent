# Runners learnings

## Runners have fixed tokens, not a join flow

An invitation and join step was proposed first. The person deploying a team node is usually an
agent running elsewhere, and it already writes the node's machine `happy.toml`; a join flow would
have needed a tool on the node and a second round trip for every runner. Each runner now has a
fixed token in `[runners.<id>]`, written to both machines at deployment, so a runner can be
provisioned before the node first starts. Removing the entry and restarting revokes it.

## The runner dials the daemon

Runners usually sit behind NAT and must not need an inbound port, so the runner opens the
connection and keeps it open. The daemon is reached the way any client reaches it: a standalone
daemon through Tailcat, a team daemon through its listener, or a local socket while testing.

## Everything that touches a folder runs on the runner

Git, workspace checkouts, terminals, file watching, services, and the workspace proxy were all
asked for explicitly, not only agent commands. Once any runner is configured nothing runs on the
daemon's machine and nothing falls back to it: a disconnected runner is an error that names it.
Repository tokens still never leave the daemon — Git on a runner reaches back to the daemon's
credential proxy through a loopback listener carried over the runner connection.
