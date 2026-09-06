# Deploy a standalone remote agent

Use this recipe when the user wants a personal, non-team Happy Agent on another machine, ready to
run coding tasks from their existing Happy installation with minimal further setup. The remote is
an independent daemon with its own projects, agents, profile, and credentials. Do not create a
Happy team, WorkOS organization, or team login for this deployment.

Read [configuration](../configuration.md) and [Tailcat](../tailcat.md) as needed. Use the installed
release's `API.md` for exact API requests (in the source checkout it is
`packages/happy-agent/API.md`). This walkthrough targets a fresh Linux server with systemd;
adapt the service manager and paths for macOS instead of running Linux commands there.

## Automatic by default

The agent executes this recipe end to end: discover the target and current settings, copy the
local profile into remote config, provision authorized credentials, install and start the service,
register the connection, configure Git, and run the completion checks. Do not turn the examples
into homework for the user. Reuse existing choices and authorized access without asking for each
step. Ask only when a material choice or authority is missing; pause for unavoidable browser,
device-login, SSH, or Keychain approval, then continue automatically. Automation never bypasses
permission review or authorizes transferring an unrelated account's credentials.

## 1. Resolve the few choices that matter

Reuse information already supplied by the user. Ask together for anything still missing:

- Which machine and SSH account should be used? Confirm its host key, operating system,
  architecture, and permission to install a persistent service and enable remote access.
- Which provider accounts should the remote use? Explain that copying credentials grants that
  machine access to those accounts and their spending limits. Obtain consent for the specific
  credentials and destination; prefer a fresh remote login or dedicated credentials when possible.
- “Would you like GitHub set up there too? I can install GitHub CLI (`gh`), authenticate your chosen
  GitHub account, and configure Git to use it.” Confirm the GitHub host, account, and repositories.
- Read the current user's effective `git config --get user.name` and
  `git config --get user.email` in the intended local repository, or their global values when
  there is no repository. Propose those exact values for the remote: “I'll use this Git name and
  email on the remote too; should they be different?” Ask for missing or ambiguous values. Preserve
  a GitHub no-reply email if that is what the user uses; never invent one from their username.
- Reuse the friendly remote name, default provider/model, and initial repository or working
  folder from the request or local setup. Ask only if the choice is missing or ambiguous.
- As an active admin bot on the **local** installation, call `get_local_profile` with `{}`. It
  reads the existing name and email directly from local storage, without an API request. Reuse
  those values by default, separately from Git commit identity. Ask only for missing values
  (`null`) or when the user requests a different remote profile. Never copy a profile database,
  private identity, installation ID, or version to the remote.

If an existing installation is present, inspect its service, account, config, and projects first.
Preserve them and merge only the requested settings. Do not replace an existing daemon's identity,
credentials, or data to make these fresh-install examples fit.

### exe.dev deployment notes

Prefer SSH with the user's existing `~/.ssh/id_ed25519` key when it is authorized for exe.dev.
Use the VM address and login user reported by exe.dev; do not invent an SSH hostname or copy the
private key onto the VM. Verify the host key and use the key explicitly, for example
`ssh -i ~/.ssh/id_ed25519 <confirmed-user>@<confirmed-vm-host>`.

The default exe.dev bearer token can create and list VMs, but cannot SSH, delete VMs, or add SSH
keys. Successful VM creation therefore does not prove that bootstrap access exists. If SSH is not
authorized, ask the user to arrange the required access; do not retry privileged operations with
that token or treat it as a Happy Agent credential.

When SSH is available, avoid exe.dev first-boot scripts. They run once as `exedev`, not as the
`happy-agent` service user, and quoting newlines inside an HTTPS payload is easy to get wrong.
Use inspected, repeatable SSH steps instead. For the standard x86-64 exe.dev VM use the
`linux-x64` archive, still checking `uname -m` first. Pin the actual config directory explicitly in
the systemd environment, as below, instead of relying on a path copied from an older deployment.

## 2. Install the binary and prepare one service account

Use a dedicated unprivileged account, here `happy-agent`, with home `/var/lib/happy-agent`. The
daemon, provider credentials, Git config, GitHub login, and repositories must all belong to that
account—not root or the SSH operator. On a fresh Debian/Ubuntu host:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq tar
sudo useradd --system --create-home --home-dir /var/lib/happy-agent \
  --shell /bin/bash happy-agent
sudo chmod 0700 /var/lib/happy-agent
sudo install -d -m 0700 -o happy-agent -g happy-agent \
  /var/lib/happy-agent/happy/config \
  /var/lib/happy-agent/.happy \
  /var/lib/happy-agent/.config/happy-agent/credentials \
  /var/lib/happy-agent/projects
```

Unless the user pinned a version, resolve the latest stable Happy Agent release from GitHub at
deployment time. Filter for Happy Agent's `v<version>` tags, not Happy Terminal/library releases;
do not reuse a version remembered from a previous deployment. Match `uname -m` to `linux-x64` or
`linux-arm64`. Download in a fresh temporary directory, verify the published checksum, and install:

```sh
set -eu
DEPLOY_DOWNLOAD_DIR="$(mktemp -d)"
cd "$DEPLOY_DOWNLOAD_DIR"
DEPLOY_TAG="$(curl -fsSL 'https://api.github.com/repos/slopus/happy-agent/releases?per_page=100' |
  jq -er '[.[] | select(.draft == false and .prerelease == false) |
    select(.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))][0].tag_name // error("No stable Happy Agent release found")')"
DEPLOY_VERSION="${DEPLOY_TAG#v}"
case "$(uname -m)" in
  x86_64) DEPLOY_TARGET="linux-x64" ;;
  aarch64|arm64) DEPLOY_TARGET="linux-arm64" ;;
  *) echo "Unsupported Linux architecture; choose a supported release target." >&2; exit 1 ;;
esac
DEPLOY_ARCHIVE="happy-agent-$DEPLOY_VERSION-$DEPLOY_TARGET.tar.gz"
DEPLOY_RELEASE_URL="https://github.com/slopus/happy-agent/releases/download/v$DEPLOY_VERSION"
curl -fLO "$DEPLOY_RELEASE_URL/$DEPLOY_ARCHIVE"
curl -fLO "$DEPLOY_RELEASE_URL/$DEPLOY_ARCHIVE.sha256"
sha256sum --check "$DEPLOY_ARCHIVE.sha256"
tar -xzf "$DEPLOY_ARCHIVE"
sudo install -m 0755 "happy-agent-$DEPLOY_TARGET" /usr/local/bin/happy-agent
/usr/local/bin/happy-agent --version
```

Stop on download or checksum failure. The release binary is self-contained and embeds the Tailcat
server; a source checkout, Node.js, and a separate Tailcat server installation are unnecessary.
Install repository-specific runtimes/package managers only as required by the initial project.
For macOS use the matching `darwin-*` asset, `shasum -a 256 -c`, the chosen user's
`~/Happy/Config/happy.toml`, and a persistent launchd service under that user.

If the GitHub query is rate-limited or its page contains no Happy Agent release, resolve the
remaining pages or the release through an authorized GitHub client; do not guess a version. Record
the chosen version for the handoff. Before first startup, verify that
`/var/lib/happy-agent/.happy` belongs to `happy-agent`, particularly if an earlier root-owned
bootstrap created it. On an existing installation inspect ownership before making a scoped repair;
never recursively change unrelated directories or follow unverified symlinks.

## 3. Provision only the selected provider credentials

Never print auth files or tokens, paste them into chat, include them in command arguments, put them
in Git, or enable shell tracing while handling them. Use the available reviewed secret mechanism
or a direct encrypted SSH/SCP transfer. If authorization or safe access is unavailable, have the
user perform that private step. Do not bypass keychain or permission restrictions.

For a file transfer, create a private staging directory on the destination with `mktemp -d`, use
its exact returned path for `scp` from the authorized local auth file, then install the file as
the service account. For example, after transferring to the private staging path:

```sh
sudo install -m 0600 -o happy-agent -g happy-agent \
  /EXACT_PRIVATE_STAGING_PATH/auth.json \
  /var/lib/happy-agent/.config/happy-agent/credentials/codex.json
```

Replace the staging path and destination for each selected vendor. Remove only the exact staged
credential copies after verifying the installed files. Credential files and config must be mode
`0600`, with private parent directories mode `0700`. Codex and Grok refresh credentials in place,
so both their file and its parent directory must be writable by the service account. Do not copy
an entire home directory or unrelated accounts. Duplicated OAuth sessions may interfere through
refresh-token rotation; if copying destabilizes either machine, sign in separately on the remote.

Write the provider sections below into the **remote machine's**
`/var/lib/happy-agent/happy/config/happy.toml`. Use absolute remote paths, not the source machine's
paths. Examples containing `REPLACE_...` are templates, not usable credentials. Populate secrets
through a private editor/secret provisioner, not a model-visible patch or shell command literal.
Do not assume TOML expands environment variables inside strings.

### OpenAI / Codex

Sign in with `codex login` through the first-party CLI. Its normal file is `~/.codex/auth.json`, or `auth.json`
inside the user's configured `CODEX_HOME`. Copy the entire file—including session/refresh data and
account identity—to the remote credential path. Do not extract only the access token. A keychain-only
login is not a portable file: use Codex's supported file-backed login or sign in on the remote;
never copy the OS keychain. Consult the installed Codex CLI's help for its supported login flow.

```toml
[providers.codex]
enabled = true
auth_file = "/var/lib/happy-agent/.config/happy-agent/credentials/codex.json"
transport = "auto"
```

For a user-selected OpenAI API key instead of a Codex subscription login, use `api_key` in this
section, populated privately, and omit `auth_file`. API billing and available models may differ.
Do not silently switch subscription authentication to a paid API key.

### Anthropic / Claude Code

For a headless remote, prefer an already available long-lived setup token for the authorized
account. Otherwise the agent can extract the current Keychain token automatically as described
below, with the stated expiry limitation. When a new long-lived token is needed, run
`claude setup-token` as the intended signed-in user and involve them only for the private login
interaction. Transfer the resulting token privately and write it into the remote config:

```toml
[providers.claude]
enabled = true
oauth_token = "REPLACE_WITH_PRIVATE_SETUP_TOKEN"
```

Alternatively, if the source has a file-backed Claude login, copy
`~/.claude/.credentials.json` (or the file inside `CLAUDE_CONFIG_DIR`) to a private remote directory
as `.credentials.json`. Configure the **directory**, not the file, and omit `oauth_token`:

```toml
[providers.claude]
enabled = true
config_dir = "/var/lib/happy-agent/.config/happy-agent/credentials/claude"
```

#### Read an existing macOS Keychain token directly

Claude normally stores its OAuth credentials in the login keychain; copying `~/.claude` alone
does not copy that login. With authorization to transfer this account to the chosen remote, the
agent can extract the current token automatically. Run as the signed-in local user, not root.
Use reviewed host access when the shell sandbox cannot access Keychain; never work around a
denial. Any macOS approval prompt belongs to the user.

For the default Claude configuration, this Bash snippet reads the `Claude Code-credentials`
generic-password entry and extracts only `claudeAiOauth.accessToken` into a private file. It
deliberately prints neither the JSON credentials nor the token:

```bash
set -euo pipefail
umask 077
CLAUDE_TOKEN_DIR="$(mktemp -d)"
/usr/bin/security find-generic-password \
  -a "$(id -un)" -s "Claude Code-credentials" -w |
  jq -er '.claudeAiOauth.accessToken | select(type == "string" and length > 0)' \
  > "$CLAUDE_TOKEN_DIR/oauth-token"
test -s "$CLAUDE_TOKEN_DIR/oauth-token"
```

Do not run the `security ... -w` command alone, use shell tracing, or read that file into tool
output. Stop if lookup or extraction fails. Keep the exact temporary path for the encrypted
transfer, then privately load the file's contents into the remote `[providers.claude] oauth_token`
using a TOML-aware provisioner. The setting takes the token value, not its file path. Do not put
the secret in command arguments or a model-visible patch. Verify authentication, then remove
only the exact staged token files on both machines.

For a custom Claude environment, select its actual Keychain entry instead of guessing accounts:
when `CLAUDE_CONFIG_DIR` is set, append `-` plus the first eight lowercase hex characters of the
SHA-256 of the effective directory string. When `CLAUDE_CODE_CUSTOM_OAUTH_URL` is set, insert
`-custom-oauth` after `Claude Code`. The resulting service name is
`Claude Code[-custom-oauth]-credentials[-<directory-hash>]`. Use the account that owns that login;
the normal account is the local username. These rules match Happy's Claude credential lookup.

This is the current **access token**, not a newly issued long-lived setup token. Happy's static
`oauth_token` setting does not refresh it from the local Mac, and copying `.credentials.json`
does not give Happy a Claude refresh workflow either. Check its expiry privately if present as
`claudeAiOauth.expiresAt`; a successful verification now does not guarantee unattended operation
later. For durable unattended use, prefer an already available long-lived setup token, or arrange
`claude setup-token`/fresh remote login when renewal is needed. Perform all noninteractive work
automatically and ask only for the login interaction itself. Explain the renewal requirement in
the handoff; neither token is permanent or immune to revocation.

For a user-selected Anthropic API key, use `api_key` instead, with the same private handling and
explicit billing consent. Choose one authentication method, not several competing overrides.

### xAI / Grok

Run `grok login` through the first-party CLI for the intended account. Securely copy the whole
`~/.grok/auth.json`, or `$GROK_HOME/auth.json` when configured, to the remote. Keep all scoped
records and refresh metadata intact:

```toml
[providers.grok]
enabled = true
auth_file = "/var/lib/happy-agent/.config/happy-agent/credentials/grok.json"
```

Grok refreshes its session and atomically rewrites this file. For an explicitly chosen xAI API
key, use `api_key` instead of `auth_file`; verify the desired model is available with that key.

### Amazon Bedrock

Prefer a least-privilege instance/task role when the host runs on AWS; there is then no local
secret to copy. Otherwise choose either a Bedrock bearer key or a supported AWS credential chain.
For a bearer key, privately populate:

```toml
[providers.bedrock]
enabled = true
region = "us-east-1"
bearer_token = "REPLACE_WITH_PRIVATE_BEDROCK_KEY"
```

Alternatively use `bearer_token_env_var = "AWS_BEARER_TOKEN_BEDROCK"` and place the value in the
service's private environment file in step 5; omit `bearer_token`. An export in an SSH session is
not inherited by systemd.

For an AWS profile, transfer only the authorized profile's settings and credentials from
`~/.aws/config` and `~/.aws/credentials`, preserving their AWS format. Install them in private files
and select them explicitly:

```toml
[providers.bedrock]
enabled = true
region = "us-east-1"
profile = "remote-bedrock"
config_file = "/var/lib/happy-agent/.config/happy-agent/credentials/aws-config"
credentials_file = "/var/lib/happy-agent/.config/happy-agent/credentials/aws-credentials"
```

The config section is `[profile remote-bedrock]`; the credentials section is `[remote-bedrock]`.
Temporary credentials also need their session token. Copying expiring credentials or an SSO cache
is not durable authentication: complete the supported AWS login on the remote or install and
configure its `credential_process` helper as the service user. Ensure the helper is executable
noninteractively and can refresh there. Select a region and models the account can actually use.

### Optional Gemini tools

If the user wants Gemini media/search tools, privately copy their selected key into
`[gemini] api_key`, or set `GEMINI_API_KEY` in the daemon's environment file. Gemini is not a chat
provider entry. Do not copy extra credentials merely because they exist locally.

## 4. Finish remote configuration

Combine these settings with the selected provider sections in the remote `happy.toml`:

```toml
[providers]
default_enable = false

[profile]
name = "REPLACE_WITH_LOCAL_PROFILE_NAME"
email = "REPLACE_WITH_LOCAL_PROFILE_EMAIL"

[feature.team]
enabled = false

[api]
token = "REPLACE_WITH_FRESH_43_CHARACTER_BASE64URL_TOKEN"

[feature.tailcat]
enabled = true
port = 24779

[defaults]
provider = "codex"
model = "REPLACE_WITH_AVAILABLE_MODEL_ID"
permission_mode = "auto"
```

Replace the default provider and model with an available pair chosen by the user. Keep only
providers whose authentication you provisioned enabled. Auto reviews actions; never choose Full
access simply to make bootstrap checks pass. Keep each TOML table unique when merging snippets.

Write both `[profile]` fields from `get_local_profile` into this global configuration **before
first startup**, escaping them with a TOML serializer. Startup creates the remote's own profile
and fills missing name/email fields from these records. This satisfies the profile part of
onboarding without a profile-creation screen or an HTTP profile mutation. There is no
`skip_profile` flag: do not bypass the requirement with an empty profile. Other onboarding checks,
including provider credentials and a project, still apply. Later profile edits are preserved on
restart; config only fills fields that are still missing. Project config cannot set these values,
and team deployments reject a shared `[profile]` section. Use a release supporting these settings;
if the selected older release lacks them, report the needed upgrade instead of silently falling
back to a profile API call.

For a fresh remote deployment, securely generate 32 random bytes encoded without padding as
43 base64url characters and privately write that fresh value under `[api] token`. This gives the
remote and its primary connection one explicit credential from the start. Never reuse an exe.dev
token, provider credential, or another installation's token. Preserve an existing installation's
token during upgrades. Without an explicit setting the daemon can generate a token itself, but
this deployment recipe deliberately provisions one and uses that exact value for registration.

Tailcat is account-free encrypted connectivity, not authentication. Anyone who learns its address
can reach the API authentication boundary; the bearer token grants standalone daemon access.
Keep both private and obtain consent to enable this exposure. No public unauthenticated HTTP
listener, WorkOS configuration, or Tailscale account is needed.

## 5. Install a restart-safe service

Install `/etc/systemd/system/happy-agent.service`:

```ini
[Unit]
Description=Happy Agent (standalone)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=happy-agent
Group=happy-agent
WorkingDirectory=/var/lib/happy-agent
Environment=HOME=/var/lib/happy-agent
Environment=HAPPY_TERMINAL_CONFIGURATION_DIRECTORY=/var/lib/happy-agent/happy/config
EnvironmentFile=-/var/lib/happy-agent/.config/happy-agent/service.env
ExecStart=/usr/local/bin/happy-agent run
Restart=on-failure
RestartSec=2
UMask=0077

[Install]
WantedBy=multi-user.target
```

If any credential uses an environment variable, create `service.env` privately with `NAME=value`
entries, no `export`, and correct systemd quoting. Set owner `happy-agent`, mode `0600`; do not put
secrets in the world-readable unit. Include required credential helpers/runtimes in the service's
PATH using explicit paths. Avoid competing provider variables left over from another installation.

```sh
sudo chown happy-agent:happy-agent /var/lib/happy-agent/happy/config/happy.toml
sudo chmod 0600 /var/lib/happy-agent/happy/config/happy.toml
sudo systemctl daemon-reload
sudo systemctl enable --now happy-agent
sudo systemctl is-active happy-agent
```

Wait with a bounded deadline for authenticated `/v0/health` to report readiness, not just for the
process to exist. The default local socket is `/var/lib/happy-agent/.happy/agent/server.sock`; the
token is `/var/lib/happy-agent/.happy/agent/token`. Use a protected client/header file or the client
SDK so the token never appears in process arguments or tool output. On failure inspect a bounded,
redacted log excerpt; do not dump credential-bearing config. Keep systemd as the service owner—do
not also launch a second daemon with `happy-agent start`.

### Graceful maintenance after deployment

For upgrades or a planned maintenance stop, use an independent SSH/operator session, not a tool
owned by the daemon you are stopping:

```sh
sudo -u happy-agent -H /usr/local/bin/happy-agent drain &&
sudo systemctl stop happy-agent
```

On a release supporting signal-based draining, the first command uses `SIGUSR2` and private local
status—no API, provider, or WorkOS tokens. It waits for admitted agent work to reach a safe durable
boundary and reports completion, while leaving the daemon running in read-only drain mode. New
work is rejected; pending work stays persisted. Repeating drain is safe. If the command fails,
stop and inspect the cause rather than continuing with maintenance.

The second command requests graceful shutdown with `SIGTERM`. Named cleanup handlers close the
runtime's services and processes, database connections, and API transports before the daemon exits.
Wait for that exit before backing up or replacing files. Sending `SIGTERM` alone does not first
drain active inference. Draining also does not wait for arbitrary terminal/background jobs to
finish, so arrange those separately; forced termination is not a graceful shutdown.

`happy-agent drain` checks the live daemon's signal support and process identity. Do not send raw
`SIGUSR2` to an older release, where it could terminate the process. Keep the same service user
and any `HAPPY_HOME_DIR` override. See the [upgrade recipe](upgrade-happy-agent.md) for direct
signal use, older-release handling, backups, shutdown progress, and recovery.

## 6. Connect the primary installation

Wait up to 90 seconds for the remote's private `.happy/agent/tailcat/address` and `tailcat/port`
files. Both must be present and the service must remain healthy. Securely transfer the address,
port, and daemon token to the primary machine. Never copy the Tailcat private identity key.

On the primary, have the active Chief of Staff/admin bot register these exact values with
`set_remote_connection`. Its input shape is:

```json
{
    "id": "personal-server",
    "connection": {
        "name": "Personal server",
        "address": "REPLACE_WITH_EXACT_TAILCAT_ADDRESS",
        "port": 24779,
        "token": "REPLACE_WITH_REMOTE_API_TOKEN"
    }
}
```

Use the approved private credential-provisioning path for the token; never repeat it in chat,
logs, or the handoff. The tool registers an existing remote; it does not deploy the VM. It writes
the primary's generated runtime configuration and takes effect without restarting the primary.
Then call `check_remote_connection_health` with `{ "id": "personal-server" }` and require
`reachable`, `authenticated`, and `ready` to **all** be `true`. These are separate checks: a
reachable endpoint can reject authentication, and an authenticated daemon may still be starting.
This proves connectivity, not provider inference; verify provider credentials separately in step 8.

If no active admin bot or safe tool credential path is available, the manual alternative is the
**primary machine's** global `happy.toml` (not the remote's and not a repository):

```toml
[connections.personal-server]
name = "Personal server"
address = "REPLACE_WITH_EXACT_TAILCAT_ADDRESS"
port = 24779
token = "REPLACE_WITH_REMOTE_DAEMON_TOKEN"
```

Use the exact case-sensitive address blob, not a `tailcat://` URL, and the actual configured port.
Use an unused connection ID and restrict this configuration file to its owner. Do not add
`workos_organization_id` to a standalone connection. Restart the primary daemon to apply the file
change, coordinating with ongoing work. Live connection overrides reside in generated
`runtime.toml` and take precedence
over global entries; resolve an existing override instead of appending a competing setting.

Verify through the primary's authenticated API: `GET /v0/connections` lists the remote, and
`GET /v0/connections/personal-server/api/v0/health` reaches the remote and reports readiness. The
primary credential authenticates to the primary; its connection layer supplies the remote token.
The bundled transport handles this connection without a separate client-side login. A manual
Tailcat client needs its own v0.4.0 executable; see [Tailcat](../tailcat.md).

If health returns 401, check the remote token; if unavailable, check Tailcat state, outbound
connectivity, and the exact address/port. Do not disable authentication to troubleshoot. Preserve
the remote's `.happy/agent` state across upgrades so its data, token, and Tailcat identity survive.

## 7. Set Git identity and, if requested, GitHub authentication

Always set the agreed Git identity for the **service user**, even when GitHub setup was declined:

```sh
sudo -u happy-agent -H git config --global user.name "CONFIRMED_NAME"
sudo -u happy-agent -H git config --global user.email "CONFIRMED_EMAIL"
```

If the user accepted GitHub setup, install `gh` from GitHub CLI's official instructions or a trusted
distribution package (`sudo apt-get install -y gh` on Debian/Ubuntu when available), then verify
`gh --version`. Authenticate as `happy-agent`, not root:

```sh
sudo -u happy-agent -H gh auth login --hostname github.com --git-protocol https --web
sudo -u happy-agent -H gh auth setup-git --hostname github.com
sudo -u happy-agent -H gh api user --jq .login
```

For a headless login the user completes the browser/device step on their own machine. Use their
confirmed GitHub Enterprise host instead when applicable. Request only the access needed for the
chosen repositories, including organization SSO authorization when required. Without a keyring,
`gh` may store its token in `~/.config/gh/hosts.yml`; keep it owner-only in a private directory.

If the user specifically prefers copying an existing GitHub token, transfer it privately into
`gh auth login --hostname github.com --git-protocol https --with-token` on stdin as the service
user, then run `gh auth setup-git`. Never run `gh auth token` into model-visible output, put a token
in a Git URL, or copy unrelated GitHub accounts. A narrowly scoped token may not support every
`gh` operation; verify the required ones. Merely setting `GH_TOKEN` does not prove a durable Git
credential-helper setup. Test without relying on the SSH operator's environment.

Clone the agreed repository over HTTPS into `/var/lib/happy-agent/projects` as the service user,
or create the agreed local working folder if no repository was requested. Register it as a project
on the **remote** using Happy or the documented project API. Check in that repository:

- `git config --get user.name` and `git config --get user.email` match the agreed identity;
- `git var GIT_AUTHOR_IDENT` resolves correctly;
- `git ls-remote origin` works noninteractively, if a remote was configured;
- the GitHub account and repository permissions match what the user requested.

Existing repository-local identity overrides win over global values; ask before changing an
intentional override. Git author identity and GitHub authentication are separate. A read test
does not prove write permission; inspect the granted repository permissions and disclose anything
untested. Do not push a test commit without explicit authorization. If GitHub was declined, do not
install its CLI or copy its credentials; explain any resulting private-repository limitation.

## 8. Prove it is ready and hand it over

Perform checks against the **remote**, through the connection the user will actually use:

1. Verify each selected provider with `POST /v0/providers/:providerId/verify` and
   `{ "level": "inference" }`. These checks can incur small provider charges. Require
   `status: "passed"`; HTTP 200 alone also covers verification failure. Inspect the remote model
   catalog through `GET /v0/config` and confirm the default provider/model is present.
2. Confirm the config-bootstrapped remote profile has the expected name and email and does not
   require manual profile creation. The remote's admin bot can inspect it with `get_local_profile`.
   Do not write it through the profile API. Verify the initial project is registered and onboarding
   reports its actual prerequisites satisfied; do not mark incomplete setup as finished merely to
   hide missing steps.
3. Open an agent in that remote project through Happy. Send a small task that checks its working
   directory, runs a harmless shell command, and creates/reads a disposable file inside the agreed
   workspace. Confirm model inference, tool execution, writable storage, and the user-visible
   response all work. Clean up only that test file. Test every provider the user expects to use.
4. With no active work, restart the remote service. Confirm systemd is enabled, authenticated
   health returns, the Tailcat endpoint is unchanged, the primary reconnects, the same project and
   agent remain available, and a follow-up agent task succeeds. Recheck noninteractive Git access
   as the service user if GitHub was enabled. A reboot test requires the user's approval.

Give a concise handoff: machine and connection name, installed version, service/config/project
locations, verified providers and default model, profile and Git identity, GitHub account/setup
choice, and which checks passed. Include `sudo systemctl status happy-agent` and
`sudo systemctl restart happy-agent` for maintenance, and any credential expiry/renewal steps.
Never include tokens or auth-file contents. Report pending user login steps or unverified access
plainly; a reachable daemon alone is not a fully working agent.
