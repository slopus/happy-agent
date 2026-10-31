# Harden a node with separate Linux users

Use this recipe to split one Linux machine that runs Happy Agent into two kinds of account. The
**service user** (here `happy-agent`) runs the daemon, and only it can read the configuration,
database, provider credentials, and API token. The **workload user** (here `happy-work`) runs
everything agents do: file tools and commands, Git, workspace checkouts and setup, terminals, file
browsing, previews, and MCP stdio servers. An agent command that goes wrong, or a dependency that
runs hostile code, then runs as an account that cannot read anything worth stealing. Specific
bots can run as a user of their own on top of that, such as a bot other people talk to.

The daemon starts one small runner per workload user through sudo, with
`sudo -n -u <user> -- /usr/local/bin/happy-agent runner --stdio`, and talks to it over its
standard input and output with the same protocol a [dedicated runner](add-runner.md) uses. Agent
commands still run in the normal sandbox inside it. The daemon never runs agent work itself once
this is configured: a missing sudo rule, an unknown user, or a runner that will not start makes
that work fail with the reason, and nothing falls back to the service user.

A [dedicated runner](add-runner.md) on a separate machine is still the stronger separation, and
it is what to recommend for a remote node. This recipe is for a node that runs its own work, and
for hardening any machine that runs Happy Agent as a service. The two cannot be combined on one
node: once runners are configured nothing runs on the node's machine, so the daemon refuses
`[execution]` beside `[runners]`. Harden a runner host by giving `happy-runner` nothing but its
own folders, as that recipe does.

Read [Work as separate Linux users](../configuration.md#work-as-separate-linux-users) for the
settings. The walkthrough targets a Linux host with systemd and sudo, on top of
[Deploy a standalone remote agent](deploy-standalone-remote.md) or a
[team deployment](deploy-happy-team.md). Execute it end to end, as the [recipe rules](README.md)
describe; ask only for the choices below that are still missing.

## 1. Resolve the choices

- Which node, and whether it is a fresh installation. Apply this **before the daemon first
  starts**. The home project, the Chief of Staff's folder, and every bot, task, project, and
  workspace folder are placed under the workload user's home. On an existing node, folders
  already created under the service user's home stay there, out of the workload user's reach,
  and their agents fail with `Permission denied`; tell the user, and plan to register their
  projects again under the workload user's home.
- The workload user's name. `happy-work` is the default here. Names are a lowercase letter or
  `_` followed by up to 31 lowercase letters, digits, `_`, or `-`; `root` and the service user
  itself are refused.
- Whether any bot should run as a user of its own, and which. Find each bot's ID with
  `list_bots`; the bot ID is not its agent ID. Bots are created before they can be named here,
  so a bot gets its own user after it exists.
- Which runtimes, package managers, and Git identity the projects need. They belong to the
  workload user, not the service user.

## 2. Prepare the service user

Follow the deployment recipe's service account step: `happy-agent` with home
`/var/lib/happy-agent`, mode `0700`, owning `happy/config`, `.happy`, and the credentials folder,
each `0700`, with `happy.toml` and credential files `0600`. Install the release binary root-owned
at `/usr/local/bin/happy-agent`, mode `0755`, in root-owned directories. The workload user runs
that same file, so it must not live in the service user's home: a binary under `~/.happy/dist` is
unreachable once that home is `0700`. Check both:

```sh
sudo stat -c '%U %a %n' /var/lib/happy-agent /var/lib/happy-agent/.happy \
  /var/lib/happy-agent/happy/config /var/lib/happy-agent/happy/config/happy.toml
ls -l /usr/local/bin/happy-agent
```

Expect `happy-agent 700` on each directory, `happy-agent 600` on `happy.toml`, and a binary owned
by `root`.

## 3. Create the workload user

```sh
sudo useradd --system --create-home --home-dir /home/happy-work \
  --shell /bin/bash happy-work
sudo chmod 0700 /home/happy-work
id happy-work
```

`id` must show no `sudo`, `adm`, `docker`, `lxd`, or `happy-agent` group: each would give agent
commands a way back to what this separates. Install the projects' runtimes for `happy-work`, and
give it the agreed Git identity:

```sh
sudo -u happy-work -H git config --global user.name "CONFIRMED_NAME"
sudo -u happy-work -H git config --global user.email "CONFIRMED_EMAIL"
```

Git in the workload user's runner uses that user's configured Git authentication, exactly as on
a dedicated runner. Install `gh` or other command-line
logins for `happy-work` only if the user wants agents to use them, and only with an account whose
reach they accept for every agent on the node.

Folders are laid out under the workload user's home, the way a runner lays out its own:

| Folder                                | What lives there                     | Owner         |
| ------------------------------------- | ------------------------------------ | ------------- |
| `/home/happy-work`                    | The home project                     | `happy-work`  |
| `/home/happy-work/Happy/Projects`     | Projects Happy Agent clones          | `happy-work`  |
| `/home/happy-work/happy/workspaces`   | Managed workspaces                   | `happy-work`  |
| `/home/happy-work/happy/Bots/<name>`  | Each bot's folder                    | `happy-work`  |
| `/home/happy-work/happy/Tasks/<name>` | Each task's folder                   | `happy-work`  |
| `/var/lib/happy-agent`                | Configuration, database, credentials | `happy-agent` |

`HAPPY_AGENT_WORKSPACES_DIRECTORY` and `HAPPY_AGENT_PROJECTS_DIRECTORY` describe the service
user's own layout and do not move these. Register an existing repository for the node only once it
is somewhere `happy-work` owns, such as `/home/happy-work/src/<name>`.

## 4. Allow exactly one command through sudo

The service user needs to start the runner as the workload users and nothing else. Write the
rule to a private temporary file, check it, and only then install it:

```sh
umask 077
cat > /tmp/happy-agent.sudoers <<'EOF'
# Happy Agent starts a runner as each workload user. Nothing else is allowed.
happy-agent ALL=(happy-work) NOPASSWD: /usr/local/bin/happy-agent runner --stdio
EOF
sudo visudo -cf /tmp/happy-agent.sudoers
sudo install -m 0440 -o root -g root /tmp/happy-agent.sudoers /etc/sudoers.d/happy-agent
rm /tmp/happy-agent.sudoers
sudo visudo -c
```

With bots that have users of their own, name every target user in the one rule, such as
`(happy-work,happy-guest)`. Keep the arguments exactly `runner --stdio`: listing them makes sudo
refuse the program with any other arguments, and the daemon never needs another. Do not add a
group to the run-as list, use `ALL`, keep environment variables with `env_keep`, or turn off
`env_reset`; the daemon passes only `PATH`, so provider keys in its environment never reach a
workload user. Never give a workload user a sudo rule of its own.

Stop if `visudo -cf` reports an error; a broken file in `/etc/sudoers.d` can lock out sudo
entirely.

## 5. Configure the daemon and its service

Merge the workload user into the service user's machine `happy.toml`, preserving every unrelated
setting:

```toml
[execution]
user = "happy-work"
```

`executable` defaults to the daemon's own executable; set it only when that is not the path the
sudo rule names, for example `executable = "/usr/local/bin/happy-agent"` when the daemon is
started through a symbolic link. Give a bot a user of its own by its bot ID:

```toml
[execution.bots.k3x9q2w7e5r1t8y4u6i0o3pa]
user = "happy-guest"
```

A project's `happy.toml` cannot set either; only the machine's file can.

Use the deployment recipe's systemd unit unchanged — `User=happy-agent`, `UMask=0077`, and
`ExecStart=/usr/local/bin/happy-agent run`. The runners start inside the service's own control
group, so stopping the service stops them and everything they started. Do **not** add
`NoNewPrivileges=yes`, `RestrictSUIDSGID=yes`, or a `CapabilityBoundingSet` that drops
`CAP_SETUID` and `CAP_SETGID`: sudo is setuid, and each of those makes every runner fail to start.
`UMask=0077` carries through sudo, so files agents create are private to the workload user.

On Ubuntu 24.04, the [Ubuntu AppArmor host prerequisite](../permissions-and-sandbox.md#ubuntu-apparmor-host-prerequisite)
is still required. The profile attaches to `/usr/local/bin/happy-agent` by path, so the same
profile covers every runner sudo starts from that file; nothing more is needed for the workload
users.

Restart the service to apply the change; `[execution]` is read only at startup:

```sh
sudo systemctl restart happy-agent
sudo journalctl -u happy-agent -n 100 --no-pager | grep -i 'linux user'
```

The log says `Agent work for the Linux user happy-work runs in its own runner.` A missing sudo
rule, an unknown user, or a runner that cannot start is logged instead, saying what to fix, and
the daemon keeps running so the user can still reach it; every piece of work on the node fails
with the same reason until it is fixed and the service restarted.

## 6. Give a bot a Linux user of its own

For a bot that other people talk to, or one that should not see the node's projects:

```sh
sudo useradd --system --create-home --home-dir /home/happy-guest \
  --shell /bin/bash happy-guest
sudo chmod 0700 /home/happy-guest
```

Add it to the sudo rule's run-as list and to `[execution.bots.<botId>]`, as above. Every agent
the bot governs — the bot itself, its subtasks and their collaborators, its exported-bot
conversations, and tasks it opens — runs its files and commands as that user.

The bot's folder was created by the workload user, so grant the bot's user that folder and nothing
else. Install the `acl` package if `setfacl` is missing, and use the folder `list_bots` reports:

```sh
BOT_FOLDER=/home/happy-work/happy/Bots/guest
sudo setfacl -m u:happy-guest:x /home/happy-work /home/happy-work/happy /home/happy-work/happy/Bots
sudo setfacl -R -m u:happy-guest:rwX,d:u:happy-guest:rwX,d:u:happy-work:rwX "$BOT_FOLDER"
```

The traverse permission on the parent folders lets the bot's user reach its folder by name, not
list or read anything beside it, because the workload user's files are private under
`UMask=0077`. The default entries keep each new file usable by both users.

Then, through [bot settings](bot-settings.md), keep the bot to its own agents with
`crossWorkspace: false`, so every subtask it creates shares its folder. A subtask in a project
workspace would run as the bot's user in a folder that user cannot write, and fail.

What changes for such a bot:

- Stdio MCP servers run as the workload user and are shared by every agent in a folder, so they
  are not offered to the bot; it sees them as failed, with the reason. HTTP servers still work.
- Terminals and file browsing in its folder, workspace setup, and Git checkouts are the product's
  own work and run as the workload user.

## 7. Limits that remain

- Attached secrets are refused for commands that run as a workload user, as on runners, because
  their values stay with the daemon. A bot or project that needs secrets in commands cannot use
  this setup yet.
- Live Git state — the changed-file list and branch comparison — is not tracked for folders that
  run as a workload user, exactly as on runners. `GET /v0/workspaces/:workspaceId/git` answers
  `404`.
- Docker workspaces and a bot's Docker compute are started by the workload user's runner, which
  then needs Docker. Membership in the `docker` group is root-equivalent and undoes this
  separation; say so and get approval before granting it, or leave Docker off on this node.

## 8. Verify the separation

Run these from an operator session, not from a tool of the daemon being checked:

```sh
# The rule allows exactly the runner, as exactly the workload users.
sudo -l -U happy-agent
sudo -u happy-agent sudo -n -u root true && echo "WRONG: root is reachable"
sudo -u happy-agent sudo -n -u happy-work /bin/sh -c id && echo "WRONG: a shell is reachable"
sudo -u happy-work sudo -n true && echo "WRONG: the workload user has sudo"

# The workload user cannot read the daemon's configuration, database, or credentials.
sudo -u happy-work cat /var/lib/happy-agent/happy/config/happy.toml
sudo -u happy-work ls /var/lib/happy-agent/.happy/agent
sudo -u happy-work ls /var/lib/happy-agent/.config/happy-agent/credentials

# The runners run as the workload users, inside the service's control group.
ps -o user,pid,args -u happy-work
systemctl status happy-agent --no-pager
```

None of the `WRONG` lines may print. Each `cat` and `ls` must fail with `Permission denied`.
`ps` lists `/usr/local/bin/happy-agent runner --stdio` as `happy-work`, and `systemctl status`
shows it under the service.

Then follow [Testing a deployed node](README.md#testing-a-deployed-node) with a temporary project
registered under `/home/happy-work`. Have its agent run `id -un` and `pwd`: they report
`happy-work` and a folder under `/home/happy-work`. For a bot with a user of its own, send the bot
a small task that runs `id -un` in its folder and confirm it reports that user. Archive the
temporary project afterwards.

Report each check that passed, and say plainly which were not run.
