# Set up WSL projects from Windows

Use this recipe when a Windows 11 user wants Linux projects in Happy Desktop. Chief of Staff
performs the setup and verification within the user's authorization, reusing existing choices.
Ask only for a missing material choice, new authority, or an unavoidable login or restart.

Read [Deploy a standalone remote agent](deploy-standalone-remote.md) in full for release download,
checksums, profile bootstrap, credentials, Tailcat configuration, connection registration, and API
checks. Apply the WSL-specific account and service choices below instead of creating its dedicated
server account. Consult the installed `API.md` for exact request shapes.

## One installation per environment

- The Windows Agent owns the user's bots and their conversations by default. Keep existing bots
  there. A remote project does not move a bot or change the shell that its tools use.
- A separate Linux Happy Agent in the selected WSL distribution owns Linux projects, workspaces,
  Git, shells, and provider configuration. Connect it as an ordinary standalone remote, for
  example `wsl-ubuntu` with the display name `Ubuntu (WSL)`.
- The Desktop uses its existing connection view to access the WSL Agent. Creating a project while
  connected to WSL registers a Linux path on that Agent; Windows projects stay on Windows.
- Never share `.happy`, databases, bot identities, Tailcat private keys, or `runtime.toml` between
  Windows and Linux. A fresh remote seeds its own administrative Chief of Staff; that is a separate
  bot, not a copy of the user's Windows bot. Leave it unused for ordinary work unless requested.

The control flow is:

```text
Windows Chief of Staff -- wsl.exe bootstrap --> Linux Happy Agent
Windows Happy Desktop --> Windows Happy Agent
                         --> existing authenticated Tailcat connection
                             --> Linux Happy Agent --> Linux project and tools
```

An ordinary bot's `create_project`, shell, and agent messaging tools operate on its own
installation. Register and run remote work through the selected remote connection and its
documented API; do not assume local agent IDs or local project tools route across installations.

## 1. Discover before installing

From PowerShell, inspect `wsl.exe --status` and `wsl.exe --list --verbose`. Reuse an existing WSL2
distribution and its normal Linux user. If several are available, reuse the one named by the user
or containing the requested project; ask only when the choice remains ambiguous. Do not change
the default distro just to make commands shorter. Always pass its exact name with `--distribution`.

When WSL is absent, install it with one elevated Windows operation:

```powershell
wsl.exe --install --distribution Ubuntu-24.04 --no-launch --web-download
```

Windows may show UAC. If installation reports a required reboot, record the result and stop
dependent work until the user restarts; do not repeatedly relaunch the installer or restart their
computer yourself. After restart, inspect state again and install Ubuntu only if it is still
missing. If virtualization remains unavailable, report the actual Windows/firmware requirement.
Never reset, unregister, or reinstall an existing distro to resolve a startup error.

Complete the distro's initial normal-user setup if needed. Reuse its existing user rather than
creating a second account that cannot see its provider login. Inspect `id`, `uname -m`, `$HOME`,
the existing Happy process/service, and any overrides for `HAPPY_HOME_DIR`, `CLAUDE_CONFIG_DIR`, or
`CODEX_HOME`. Run these inside Linux; a Windows path or Windows `HOME` is not the Linux home.

Use explicit argument lists with `wsl.exe --distribution NAME --user USER --exec ...`. For
multiline bootstrap commands, use an inspected script with Linux line endings and invoke Bash
explicitly. Avoid composing Linux shell commands by interpolating untrusted project paths.

## 2. Install under the Linux user's identity

Download the matching stable Linux Happy Agent release and verify its checksum using the remote
deployment recipe. The standalone binary includes its runtime and Linux helpers; no source
checkout, Node.js installation, Windows executable, or separate Tailcat installation is needed.
Install the trusted executable at `/usr/local/bin/happy-agent`; run it as the selected normal
Linux user, never root. Install Git and the actual project's required tools inside that distro.

Reuse an existing Linux Happy home and preserve its identity. With defaults, private state lives
at `~/.happy`, global configuration at `~/happy/config/happy.toml`, and installed instructions at
`~/.happy/docs`. Set the remote profile from the Windows Chief of Staff's `get_local_profile`
result, using the remote recipe's config bootstrap. Reuse known Git name/email separately.
Ensure the Linux user owns the public `~/happy` parent as well as its `config` directory; creating
only the nested directory as root can leave Happy unable to create its bot and project folders.
Set `[node] name = "Ubuntu (WSL)"` before startup, or use the supported `PATCH /v0/config` node
setting afterward. Desktop uses the installation's own name, not its connection-roster label;
WSL otherwise commonly inherits the same machine name as Windows.

For Ubuntu 24.04, check the documented
[AppArmor prerequisite](../permissions-and-sandbox.md#ubuntu-apparmor-host-prerequisite) when
applicable. Test the Linux sandbox; do not assume that WSL itself substitutes for Happy's shell
sandbox, disable host policy globally, or choose Full access to conceal a failed restricted run.

## 3. Reuse Linux authentication and choose available models

Provider configuration belongs to the Agent executing the project. A Windows login alone does
not authenticate the Linux Agent, and the connection's Happy API token authenticates the remote
daemon rather than paying for model inference.

First discover and verify the selected Linux user's existing provider credentials. A WSL user
already signed in to Claude Code should not have to sign in again merely to install Happy. The
Linux release bundles its Claude runtime; a separate Claude CLI is only needed when using that
CLI to obtain or renew a login. Claude Desktop being signed in on Windows is not evidence of a
Linux Claude Code login.

If Linux credentials are missing, explain the specific state: for example, "Claude is signed in
on Windows. Sign in to Claude Code inside Ubuntu to use it for Ubuntu projects." Use the official
[Claude Code setup](https://code.claude.com/docs/en/setup) and
[login instructions](https://code.claude.com/docs/en/authentication), running `claude` as the same
Linux user as Happy. The user may need to complete a browser/code step. For another selected
provider, use its installed first-party CLI's supported login flow. Do not change subscription
access into paid API-key access without the user's choice.

If the user instead authorizes copying particular credentials into this distro, use the remote
recipe's private transfer workflow and explain renewal limitations. Do not silently mount shared
Windows credential files as writable Linux auth storage or print tokens. Independent logins avoid
two daemons competing to refresh the same copied OAuth session.

After discovery, verify each requested provider through the WSL Agent. Read that Agent's model
catalog and select a model it actually enables. Windows bots continue using the Windows catalog;
WSL project sessions use the WSL catalog. The same accounts and Happy version can offer matching
models, but credentials, provider configuration, and version differences may make the lists differ.

## 4. Start and connect the WSL Agent

Use the standalone remote recipe's fresh API token, `[feature.tailcat]`, and global configuration.
Tailcat is the existing authenticated remote path, including for a distro on the same computer;
it requires outbound connectivity and makes the authentication boundary reachable by its address.
Explain that when enabling remote access. Do not add an unauthenticated LAN listener, configure
WorkOS/team mode, or invent a WSL-specific tunnel. Keep address and token private.

Use one service owner. Preserve an existing working service. For a new Windows-managed WSL
installation, use one per-user Windows Scheduled Task at that user's logon to run:

```text
wsl.exe --distribution DISTRO --user LINUX_USER --cd ~ --exec /usr/local/bin/happy-agent run
```

The task runs with the normal Windows user's interactive token, without highest privileges or a
stored password. Use PowerShell with `-NoProfile -WindowStyle Hidden -Command` to invoke `wsl.exe`
and then `exit $LASTEXITCODE`; the foreground invocation waits for WSL to exit. Use a known existing
Windows working directory, explicit executable paths, and correctly quoted arguments. Keep secrets
out of the action, and avoid inheriting Windows
Happy/provider path overrides into Linux. Configure no execution time limit, allow battery power,
ignore duplicate starts, and use bounded restart-on-failure attempts. Name the task for its distro,
inspect an existing task before updating it, and start it once after installation.

This keeps the real foreground Agent attached to Windows' process owner, rather than adding a
dummy keepalive process. Do not also enable a competing systemd unit or `happy-agent start` for the
same home. `run` must remain in the foreground; a launcher that exits after spawning a daemon
cannot supervise it. Report task failures and inspect bounded, redacted logs instead of launching
duplicate processes.

If retaining a systemd service, follow the remote recipe with `User`, `HOME`, paths, and service
environment changed to the selected Linux user. An enabled service starts when the distro starts;
it does not promise to start WSL at Windows logon or keep WSL alive by itself. Verify that lifecycle
explicitly. Desktop's existing remote connection does not wake a stopped distro. See Microsoft's
[WSL service lifecycle](https://learn.microsoft.com/en-us/windows/wsl/systemd).

Wait for authenticated Linux health and Tailcat readiness, then register the exact remote address,
port, and token on Windows with `set_remote_connection` from the active admin bot. Reuse the
existing connection ID on repeated setup. Follow the private credential-handling and global-config
fallback in the remote recipe; never edit generated `runtime.toml` directly. Require connection
health to be reachable, authenticated, and ready before using it.

## 5. Register projects on their owning Agent

Prefer Linux projects in `/home/USER/projects/...` and Windows projects in
`C:\Users\USER\projects\...`. Reuse an existing project in place unless the user requests a move.
For a Windows Explorer path such as `\\wsl.localhost\Ubuntu-24.04\home\USER\projects\app`, select
that distro's connection and register `/home/USER/projects/app` there. Never give the UNC path to
the Windows Agent as a substitute for Linux execution.

A project under `/mnt/c/...` uses the Windows filesystem through WSL and has different performance
and filesystem semantics. If the user deliberately chooses it for Linux execution, register it on
the WSL Agent with its Linux path. Avoid simultaneous Windows and Linux agents changing the same
checkout. Keep package installations and Git operations consistent with the chosen environment.
See Microsoft's [filesystem guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems).

Check for existing registration first. Create/register the project through the remote connection's
documented project API or Happy Desktop with that connection selected. Install the project's actual
Linux toolchain, follow setup to readiness, and verify Git identity and noninteractive remote access
when required. Do not copy Windows `node_modules` or assume Windows Git/Node are Linux tools.

## 6. Prove the complete path

Use a synthetic toy project first; do not send private source to a provider merely to test setup.
Perform these checks through Windows' configured connection, not only from a Linux shell:

1. The WSL connection is visible in Happy Desktop; health is authenticated and ready, and its
   version satisfies Desktop. Windows projects and bots remain available.
2. Requested providers pass live inference verification, with a default model in the WSL catalog.
   Missing credentials remain an explicit onboarding step, not a silently enabled model.
3. A real project session reports Linux `pwd`/`uname`, creates and reads a toy file, and runs a real
   test through Happy's Auto sandbox. Confirm the reply, file contents, and healthy daemon afterward.
4. Git status and Happy's Changes view show the created file. For an isolated Git fixture, create
   a local bare origin and `origin/main` first: Changes compares against that branch's merge base.
   This fixture requirement does not authorize rewriting a real project's remotes or branches.
5. With no active work, restart the chosen service owner. The same remote identity, project, and
   conversation reconnect, and a follow-up request succeeds. Check startup with other WSL terminals
   closed, plus recovery after an agreed Windows logon/restart test; do not interrupt unrelated WSL
   work with `wsl --shutdown`.

Run the file-creation and subsequent Git checks in sequence; parallel tool calls can legitimately
read status before the write finishes. The Linux sandbox may report user `root` inside its user
namespace: verify `/proc/self/uid_map` maps that UID to the unprivileged host user, and verify the
daemon itself runs as that user. This does not give the command host-root privileges.

When profile, provider, project, and live checks have passed, complete installation onboarding with
the documented `POST /v0/onboarding/complete`. Do not make the user repeat it in Desktop. An already
open welcome flow reads the completion marker on its next bootstrap; complete before opening the
remote connection for the final handoff.

Report the distro/user, Agent version, connection name, service owner, verified providers, project
paths, and concrete results. Record pending login/reboot steps and any untested lifecycle behavior.
An installed WSL package or a successful health request alone is not completed end-to-end setup.
