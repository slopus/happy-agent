# Add a dedicated runner

Use this recipe to give a deployed Happy Agent node — standalone or team — a separate machine that
does its work. **It is strongly recommended for every remote node.** The node keeps the database,
provider credentials, API token, and inference; the runner holds the project folders and runs
everything that touches them: agent file tools and commands, Git, workspace checkouts, setup
commands, terminals, file browsing, previews, and MCP stdio servers. An agent command that goes
wrong, or a dependency that runs hostile code, then lands on a machine with none of the node's
secrets.

Read [Runners in the configuration guide](../configuration.md#runners) for the settings, and the
installed release's `API.md` (in the source checkout `packages/happy-agent/API.md`) for exact
requests. The walkthrough targets a fresh Linux runner host with systemd. Execute it end to end,
as the [recipe rules](README.md) describe; ask only for the choices below that are still missing.

## 1. Resolve the choices

- Which node gets the runner, and which machine and SSH account host it? Confirm the runner host's
  key, operating system, architecture, and permission to install a persistent service there.
  The runner host must not be the node's own machine; that would defeat the separation.
- A short runner ID (`[a-z][a-z0-9_-]{0,63}`, for example `build-box`) and a friendly name.
- Which runtimes and package managers the user's projects need on the runner. Git is always
  required. Docker is needed only for container workspaces (step 7).
- The Git name and email commits on the runner should use — the same identity the node's own
  Git used, unless the user wants another.

A runner holds no provider credentials, no Happy data, and no API token. Do not copy any of them
to it. Repository tokens stay on the node too: Git on the runner reaches remotes through the
runner connection, and the node adds the token itself.

## 2. Generate the runner's token and add it to the node

Generate a fresh token privately on the node — 32 random bytes as 43 base64url characters — and
never print it, put it in a command argument, or reuse another token:

```sh
umask 077
head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > ~/.runner-token-build-box
```

Merge the runner into the node's machine `happy.toml`, writing the token from that file with a
TOML serializer rather than pasting it, and preserving every unrelated setting:

```toml
[runners]
default = "build-box"

[runners.build-box]
name = "Build box"
token = "REPLACE_WITH_THE_GENERATED_TOKEN"
```

`default` is optional with exactly one runner; with several it names the runner used for new
projects that name none, for the home project, and for bot folders. Each token must differ from
`[api] token`, every connection token, and every other runner's token.

**Once any runner is configured, the node runs nothing on its own machine.** Projects registered
on the node's own disk stay listed so they can be archived, but their agents, terminals, and files
refuse to work there. Tell the user before restarting, and plan to register or clone those
projects again on the runner (step 6). Apply the change by draining and restarting the node as in
its deployment recipe; keep the node's Tailcat identity and data.

## 3. Prepare the runner host

Install the **same Happy Agent release as the node**, with the same download and checksum steps
as [Deploy a standalone remote agent](deploy-standalone-remote.md#2-install-the-binary-and-prepare-one-service-account).
Use a dedicated unprivileged account that owns the runner's folders:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo useradd --system --create-home --home-dir /var/lib/happy-runner \
  --shell /bin/bash happy-runner
sudo chmod 0700 /var/lib/happy-runner
sudo install -d -m 0700 -o happy-runner -g happy-runner /var/lib/happy-runner/.happy-runner
```

Agent commands run in the sandbox on the runner, so on Ubuntu 24.04 follow the
[Ubuntu AppArmor host prerequisite](../permissions-and-sandbox.md#ubuntu-apparmor-host-prerequisite)
for the runner's executable, exactly as for a node. Install the projects' runtimes for the
`happy-runner` user, and set its Git identity:

```sh
sudo -u happy-runner -H git config --global user.name "CONFIRMED_NAME"
sudo -u happy-runner -H git config --global user.email "CONFIRMED_EMAIL"
```

## 4. Give the runner its token and the node's address

Transfer the token to the runner host over the approved private path, straight into the token
file, and delete the node's temporary copy afterwards:

```sh
sudo install -m 0600 -o happy-runner -g happy-runner /dev/stdin \
  /var/lib/happy-runner/.happy-runner/token < runner-token-from-the-node
```

The runner dials the node; it needs no inbound port. Read the node's Tailcat address and port from
its private `.happy/agent/tailcat/address` and `tailcat/port` files — the same values a primary
installation's connection uses — and write the endpoint into a private environment file. Both
standalone and team nodes are reached this way; a node that is already reachable over a private
network may use `https://host` or `http://host:port` instead.

```sh
printf 'HAPPY_RUNNER_ENDPOINT=tailcat:%s:%s\n' "$NODE_TAILCAT_ADDRESS" "$NODE_TAILCAT_PORT" |
  sudo install -m 0600 -o happy-runner -g happy-runner /dev/stdin \
    /var/lib/happy-runner/.happy-runner/endpoint.env
```

The runner reads the token from that file and removes both variables from its own environment,
so nothing it starts inherits them, and agent commands cannot read its private directory.

## 5. Install the runner service

Install `/etc/systemd/system/happy-runner.service`:

```ini
[Unit]
Description=Happy Agent runner
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=happy-runner
Group=happy-runner
WorkingDirectory=/var/lib/happy-runner
Environment=HOME=/var/lib/happy-runner
EnvironmentFile=/var/lib/happy-runner/.happy-runner/endpoint.env
ExecStart=/usr/local/bin/happy-agent runner
Restart=always
RestartSec=5
KillMode=control-group

[Install]
WantedBy=multi-user.target
```

The token and endpoint stay out of the world-readable unit. Folders live under the runner's home
unless `--home <directory>` names another absolute directory. Start it and wait, with a bounded
deadline, for the connection:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now happy-runner
sudo journalctl -u happy-runner -n 50 --no-pager
```

The log says `Connected to the daemon.` A refused token, a node without runners configured, or an
unreachable endpoint is logged in plain words; the runner keeps retrying, so fix the cause rather
than restarting in a loop.

## 6. Verify from the node

Through the connection the user will use:

1. `GET /v0/runners` lists the runner as `connected`, with its version, platform, and home. The
   home project and bot folders now report a `runner` compute.
2. Follow [Testing a deployed node](README.md#testing-a-deployed-node) with a temporary project
   registered or cloned **on the runner** — pass its `runnerId`, or rely on the default. Confirm
   the project's compute is `{ "type": "runner" }`, that the agent's shell reports the runner's
   hostname, that a terminal opens in the folder, and that the file tree lists it. Archive the
   project afterwards.
3. Re-register or clone the user's real projects on the runner when they ask. A clone through the
   node's repository credentials proves Git access without any token on the runner.

Stopping the runner makes its folders' work fail with `runner_unavailable` until it reconnects;
nothing falls back to the node.

## 7. Optional: container workspaces

To run a project's workspaces in containers on the runner, install Docker there and let
`happy-runner` use it. Membership in the `docker` group is root-equivalent on that host; say so and
get approval first. Then set the project's `defaultWorkspaceCompute` to
`{ "type": "docker", "image": "..." }`. Each new workspace's agent tools run in a container of that
image with the folder mounted at the same path; Git, terminals, and previews use the runner's copy.

## More runners, rotation, and removal

Add more runners with their own IDs and tokens and choose one per project with `runnerId`. Upgrade
runners with the node, keeping one release across both. To rotate a token, write a new one to both
the node's `happy.toml` and the runner's token file, then restart both. To remove a runner, delete
its entry and restart the node: the node refuses its token and tells it to stop everything it held.
Then disable `happy-runner` on that host.
