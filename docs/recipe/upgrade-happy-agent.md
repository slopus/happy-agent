# Upgrade Happy Agent

Use this recipe to upgrade an existing Happy Agent installation, especially a standalone remote
created with [the deployment recipe](deploy-standalone-remote.md). An upgrade replaces the runtime;
it does not recreate the service account, reconfigure providers, rotate credentials, register a new
connection, or repeat onboarding. Preserve the user's existing deployment mode and settings.

Execute the upgrade automatically by default within the authorized target and maintenance window:
discover versions, stage and verify the download, drain, stop, back up, replace, start, and verify.
Reuse known settings and ask only for missing material choices or access. The commands below are
for the agent to perform, not a manual checklist for the user. Preserve any `[profile]` bootstrap
records and the saved profile; do not recopy the local profile or overwrite remote edits on upgrade.

The concrete commands below target that recipe's Linux systemd installation:
`/usr/local/bin/happy-agent`, service `happy-agent`, home `/var/lib/happy-agent`. Inspect the actual
installation before using them. For configuration and transport details, read
[configuration](../configuration.md) and [Tailcat](../tailcat.md). Use the installed version's
`API.md` for exact API requests; in this source checkout it is `packages/happy-agent/API.md`.

## 1. Confirm the target and maintenance window

Reuse known information and ask only for missing choices:

- Which installation should be upgraded, and to which released version? If none is specified,
  resolve and use the latest stable **Happy Agent** release. Do not confuse it with Happy Terminal or
  another library, create a release, or switch to a prerelease or source build.
- When may the service be unavailable? Explain that clients will disconnect and terminal or
  background processes may stop. Confirm how to handle active work; do not cancel it silently.
- Where should the private backup live, how much space is available, and how long should it be
  retained? Do not upload it to a new destination without permission.

Record the current version from authenticated health and the installed executable, target version,
OS/architecture, service user, executable path, supervisor, config directory, Happy home, workspace
paths, and connection ID. Resolve symlinks and path/environment overrides before replacing any
file. Inspect the service definition privately; environment settings may contain secrets.

On Ubuntu, retain the administrator-approved [AppArmor namespace allowance](../permissions-and-sandbox.md#ubuntu-apparmor-host-prerequisite)
and its exact executable-path binding. Include the profile in the stopped-state backup. A missing
allowance is a host-policy prerequisite requiring approval, not a reason to disable AppArmor or
change global sysctls. Verify sandboxed tools through the actual service after the upgrade.

Read all release notes between the installed and proposed versions. Check OS requirements,
configuration changes, database migrations or generation resets, provider changes, and client
protocol compatibility. A release that intentionally resets state is not a routine in-place
upgrade: explain the data impact and stop for explicit direction. Likewise, do not silently
upgrade unrelated clients or providers to satisfy a new requirement.

Use an independent control path that will survive the target daemon stopping: usually SSH from
the primary machine or an operator's terminal. Do not run the entire upgrade inside an agent,
terminal, or background tool owned by the daemon being replaced. Do not rely solely on the remote
connection that will disappear during shutdown. If no independent operator/control path exists,
prepare the instructions and ask the user to perform the stop/start portion.

## 2. Capture a baseline and stage the verified release

Before downtime, confirm the current remote is reachable through the user's normal connection.
Record non-secret baseline facts: version, readiness, Tailcat address/port privately, project and
agent IDs, enabled providers and default model, profile, Git name/email, and selected GitHub
account if configured. Keep credential values out of chat, logs, URLs, and command arguments.

Check sufficient disk space for the download, extracted binary, private backup, and any database
migration. Download and verify the proposed release without starting it against live state:

```sh
set -eu
UPGRADE_DOWNLOAD_DIR="$(mktemp -d)"
cd "$UPGRADE_DOWNLOAD_DIR"
UPGRADE_VERSION="REPLACE_WITH_CONFIRMED_RELEASE_VERSION"
UPGRADE_TARGET="linux-x64"
UPGRADE_ARCHIVE="happy-agent-$UPGRADE_VERSION-$UPGRADE_TARGET.tar.gz"
UPGRADE_RELEASE_URL="https://github.com/slopus/happy-agent/releases/download/v$UPGRADE_VERSION"
curl -fLO "$UPGRADE_RELEASE_URL/$UPGRADE_ARCHIVE"
curl -fLO "$UPGRADE_RELEASE_URL/$UPGRADE_ARCHIVE.sha256"
sha256sum --check "$UPGRADE_ARCHIVE.sha256"
tar -xzf "$UPGRADE_ARCHIVE"
"./happy-agent-$UPGRADE_TARGET" --version
```

Select `linux-arm64` for an ARM64 Linux host. Stop on checksum failure, an unexpected archive layout,
or a version mismatch. Do not run `start`, `run`, or `reload` on the staged binary yet: startup can
write state or apply migrations. `--version` is the bounded version check. Do not test against a
copied production home either; it contains real credentials and identities that could reconnect
to external services.

## 3. Drain work and stop the existing service

Coordinate the maintenance window with the user. Inspect active agents, terminal processes,
workspace setup, and other background work. Let important work finish or obtain explicit
permission to interrupt it before shutting down.

Use the token-free local command on the **target machine**, from the independent SSH/operator
session and as the daemon's service user:

```sh
sudo -u happy-agent -H /usr/local/bin/happy-agent drain
```

Preserve `HAPPY_HOME_DIR` if this installation overrides it. No provider token, Happy bearer token,
WorkOS token, or HTTP request is involved. The command checks the PID and private local process
identity, sends `SIGUSR2`, reports progress, and exits successfully only after the drain completes.
It works for both standalone and team daemons. A missing/stale status file or unsupported old
daemon fails without sending a potentially destructive signal; do not ignore a nonzero exit.

There are two distinct stages of a graceful maintenance stop:

1. **Drain:** `SIGUSR2` enters the same read-only boundary as the drain API. New mutations are
   rejected. In-flight inference and tool work reach their safe durable boundary; pending tool
   batches and follow-up work stay persisted for the next daemon. The command prints
   `Daemon drain is complete.` and leaves the process alive. Repeating it is safe. Ctrl-C stops
   the waiting command, not the daemon, and does not undo the daemon's sticky drain state.
2. **Graceful shutdown:** after draining, `systemctl stop` sends `SIGTERM`. The daemon runs its
   named cleanup handlers, closes background services/processes and database connections, releases
   transports, and exits. Wait for actual process exit before taking the backup. `SIGTERM` on its
   own requests shutdown, not a drain first; do not substitute it for step 1 while work is active.

Draining does not stop the supervisor or process. Shutdown does not guarantee that an arbitrary
shell job finishes successfully; coordinate those jobs separately. A forced kill skips graceful
cleanup and must never be presented as an equivalent maintenance flow.

For an operator who prefers a direct signal, after verifying the running release supports it:

```sh
sudo systemctl kill --kill-whom=main --signal=SIGUSR2 happy-agent
sudo -u happy-agent -H /usr/local/bin/happy-agent drain
```

The first command requests draining; the second waits for confirmed completion and progress.
Signal only the daemon's main process, not the whole service group. Never send `SIGUSR2` blindly
to an older release: its default OS action can terminate a process without a registered handler.
The CLI is preferred because it checks support and process identity before signaling. Local
progress is stored in owner-only `.happy/agent/drain.json`, an ephemeral status snapshot, not a
credential or a replacement for HTTP authentication.

Drain completion does **not** mean terminal processes, background commands, existing streams, or
workspace setup have finished. Account for those separately. Use bounded status checks and keep
the user informed of pending handler names/counts. A timeout is a blocker to inspect, not permission
to force-kill. On older releases without the signal command, use that release's supported
authenticated drain API with its normal private credential handling, or coordinate an idle window
and graceful stop. Do not claim it drained when that release provides no drain support.

Stop through the existing supervisor so it cannot restart the old binary during the backup:

```sh
sudo systemctl stop happy-agent
sudo systemctl show happy-agent --property=ActiveState --property=SubState --property=MainPID
```

Confirm the service is inactive and its original PID and owned processes have exited. Account for
any external watchdog or application that can relaunch it. Inspect the supervisor's stop timeout
beforehand and ensure it permits graceful shutdown; a forced termination needs separate handling
before calling the snapshot clean. Do not use `kill -9` or `happy-agent kill` as routine upgrade
steps. If shutdown stalls, inspect bounded, redacted logs and shutdown progress before proceeding.

## 4. Back up the stopped installation

Take a consistent private backup only after the daemon and other writers have stopped. A live
copy of a SQLite database alone is not a safe backup. Preserve the entire state tree, including
any SQLite WAL/SHM sidecars, together with configuration and credentials. Do not delete sidecars
or edit database migration records to make a backup or upgrade work.

For the deployment recipe's standard paths, a stopped-service backup can be created as follows:

```sh
set -eu
UPGRADE_BACKUP_DIR="$(sudo mktemp -d /var/backups/happy-agent-upgrade.XXXXXXXX)"
sudo chmod 0700 "$UPGRADE_BACKUP_DIR"
sudo cp -p /usr/local/bin/happy-agent "$UPGRADE_BACKUP_DIR/happy-agent.previous"
sudo tar -czpf "$UPGRADE_BACKUP_DIR/service-home.tar.gz" \
  -C /var/lib happy-agent
sudo cp -p /etc/systemd/system/happy-agent.service "$UPGRADE_BACKUP_DIR/happy-agent.service"
sudo tar -tzf "$UPGRADE_BACKUP_DIR/service-home.tar.gz" >/dev/null
```

Confirm `/var/backups` is available and has sufficient space first. Record the exact resulting
backup path privately. This example covers the service home, binary, and unit only. Include actual
systemd drop-ins, external environment/credential files, overridden Happy/config directories, and
projects or worktrees outside that home in the same stopped-state backup. Symlinks are not copies
of their targets: include the referenced Git common directories and external data explicitly.
Use the approved filesystem snapshot or backup mechanism for large installations, preserving
ownership, permissions, links, and any required ACLs. Inspect integrity without printing sensitive
file names or contents. If backup or verification fails, do not install the new binary.

In particular, retain all of the following unchanged:

- user-authored `happy.toml`, global instructions, MCP settings, skills, and plugins;
- the daemon-owned `runtime.toml`, which holds live overrides and must not be discarded;
- databases, conversations, bot state, profile, secret storage, and integration credentials;
- the standalone API token and Tailcat private identity key, keeping the existing connection valid;
- provider auth files and their write permissions for token refresh;
- Git/GitHub configuration, repository data, worktree metadata, and uncommitted files;
- for team deployments, the existing organization/client/owner settings and endpoint registration.

Do not copy these credentials or identities into a second active installation. Do not regenerate
them because the binary changed. An encrypted off-machine backup is optional and requires an
approved destination; the local backup itself contains account-access secrets.

## 5. Replace only the runtime and start it once

With the service still stopped and backup verified, install the staged binary into the inspected
executable path. For the standard installation, from the download directory in step 2:

```sh
set -eu
sudo install -m 0755 "happy-agent-$UPGRADE_TARGET" /usr/local/bin/happy-agent
/usr/local/bin/happy-agent --version
sudo systemctl start happy-agent
sudo systemctl is-active happy-agent
```

If using separate shells, re-establish the exact validated download path and target first. If
replacement or the version check fails, leave the daemon stopped and recover the saved binary;
do not start a partially installed executable. Keep the existing service user, home, environment,
configuration directory, permission mode, and startup command. Run `systemctl daemon-reload` only
if an approved service-definition change was actually necessary.

Use the platform's existing installation mechanism for other deployment types:

- On macOS, stage the matching signed/notarized `darwin-arm64` or `darwin-x64` release, verify with
  `shasum -a 256 -c`, and stop/start its existing launchd service under the correct account. Preserve
  its paths and keychain context; never disable signature or Gatekeeper checks to force an upgrade.
- For a detached standalone CLI daemon, stop it with its existing `happy-agent stop`, verify exit,
  back it up, replace its executable, and start with `happy-agent start` as the same user and with
  the same environment. Do not use a new binary's `start` to skip the backup: it can replace a
  running daemon whose version differs.
- For an app-managed or package-managed daemon, update through its owning application's or package
  manager's supported flow, keeping the same package source and explicit version. Do not replace
  a managed executable behind that manager's back or upgrade unrelated packages.
- For a team server, retain team mode and its supervisor. Standalone socket commands do not apply;
  `happy-agent drain` is the token-free signal command and does apply. Perform HTTP readiness checks
  with the configured WorkOS identity. No organization recreation or
  endpoint update is needed when the endpoint is unchanged.

Do not run a second foreground or detached daemon alongside the supervised one. Allow startup to
apply only the release's normal migrations; never manually rewrite schema versions or delete state
to bypass startup errors.

## 6. Verify the upgrade through the real client path

Wait within an explicit startup deadline for authenticated health. Process existence, a listening
socket, or HTTP 200 is not enough: require readiness, the expected product version, and no active
drain or shutdown state. Handle optional fields according to that release's API. Verify the client
accepts the reported protocol rather than requiring an arbitrary exact client/daemon version match.

Then check:

1. The primary's existing connection reaches the upgraded remote. The Tailcat address/port and
   credential relationship are unchanged; do not publish a new endpoint to mask lost identity.
2. Existing project, workspace, agent, and bot IDs still resolve, and earlier conversation content
   is visible. Profile, onboarding, default model, permission mode, and enabled providers remain
   as configured. Upgrade alone must not require a new Chief of Staff or fresh provider logins.
3. Provider verification with `POST /v0/providers/:providerId/verify` and
   `{ "level": "inference" }` reports `status: "passed"` for each provider the user relies on.
   These small requests may incur charges. Do not treat an HTTP 200 failure result as success or
   silently switch provider accounts to make the check pass.
4. A follow-up in an existing remote agent produces a reply and performs a harmless shell/file
   check inside the agreed workspace. Use a unique disposable file and remove only that file.
   Check pending work before sending another task; do not replay mutations already completed.
5. If GitHub was configured, noninteractive repository access still works as the service user,
   `gh api user --jq .login` is the expected account, and effective Git name/email remain correct.
   Do not push a test commit or replace Git credentials unless separately authorized.

Inspect a bounded startup log excerpt for migration, authentication, or repeated restart errors.
Redact secrets before presenting any diagnostics. Confirm the service remains enabled and stable.
Do not reboot the machine as an upgrade check without permission.

## 7. Recover safely if verification fails

Stop admitting user work while investigating. Capture bounded diagnostics and determine whether
failure is due to the executable, environment, authentication, connectivity, or persistent state.
Do not rerun setup, wipe the database, rotate tokens, disable authentication, or enable Full access
as an automatic recovery step.

If the new binary never started and persistent state is unchanged, restore the saved executable
to its inspected path and restart through the original supervisor. If the new binary opened or
migrated the databases, do **not** assume the old executable can read them. Consult release-specific
rollback guidance; when compatibility is unknown, keep the service stopped and ask for direction.

A full rollback may require the previous binary **and** the matching stopped-state backup. Explain
that restoring it discards changes made since the backup and obtain explicit authorization before
overwriting state. Preserve the failed installation separately for recovery, restore only the
validated target paths with their original ownership/permissions, and never merge two database
generations. Coordinate token refresh rotation and external side effects: restoring a local backup
does not undo a Git push, an API call, or a credential rotation on a provider's servers.

## 8. Hand off the result

Report the installation, previous and current versions, checks passed, preserved connection and
identity, service status, and private backup location/retention. Note pending work, failed checks,
or required credential renewal explicitly. An installed binary alone is not a successful upgrade.

Keep the rollback backup for the agreed period. Do not delete it automatically or include its
contents or tokens in the handoff. Clean up only the exact download/staging artifacts when no
longer needed; removing a material backup requires the user's retention decision.
