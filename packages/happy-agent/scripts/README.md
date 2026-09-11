# build scripts

The package's ordinary TypeScript build produces its published Node-compatible
JavaScript distribution and copies the repository's `docs/` into `dist/docs/`.
`build-binary.ts` takes that distribution and compiles
target-specific Bun executables. The binary compiler owns all platform asset
discovery and adapts third-party runtime-selected native packages at the bundle
boundary; product code remains runtime-neutral.

```text
sources/ ----> tsc ------> dist/cli.js (Node or Bun)
docs/ ----> copy-docs ---> dist/docs/
                              |
                              +--> build-binary.ts --> dist/bin/happy-agent-<target>
```

From the repository root, `pnpm build:bun` compiles the current platform after
building JavaScript. The compiler supports macOS and Linux arm64/x64 plus Windows
x64; `--all` selects all five targets and requires their native assets to be
available. Windows native assets must be built on Windows first, as described
below. Bun 1.4.0 is pinned by `mise.toml` and invoked at that exact version through
`pnpm dlx`. Output names are `dist/bin/happy-agent-<platform>-<arch>`; Windows adds
`.exe`. Windows helpers are embedded only in the Windows executable.

Each target embeds a checked-in Tailcat v0.4.0 executable after verifying its pinned SHA-256. The
Linux assets come unchanged from Tailcat's official release archives. Tailcat publishes no macOS
archives, so the two Darwin assets were built once from the exact v0.4.0 tag with the upstream
release flags; their provenance is recorded in `../assets/tailcat/README.md`. A normal Happy Agent
build neither downloads nor compiles Tailcat. The Tailcat executable and BSD-3-Clause license are
materialized together only when Tailcat exposure is enabled.

macOS release jobs use the same Apple credentials as Happy Desktop. They Developer ID-sign the
selected Tailcat executable before embedding it, sign Happy Agent with the shared hardened-runtime
entitlements, and require Apple to accept a notarization payload containing both exact signed
executables. Standalone executables cannot carry stapled tickets, so Gatekeeper retrieves their
notarization tickets online.

The manual GitHub release workflow supplies `HAPPY_AGENT_RELEASE_VERSION`; local builds omit it
and use the package manifest version. The override changes only the version embedded in the
compiled executable, leaving the Node-compatible package manifest untouched.

The executable selects Bun-native sockets, WebSockets, PTYs, and image processing. The ordinary
package remains Node-compatible and keeps the established Node HTTP, `ws`, `node-pty`, and Sharp
implementations. Binary compilation replaces those runtime selectors, so their native libraries
are not embedded in the executable.

Every release target runs `smoke-binary-transports.mjs` against the compiled executable. The
smoke proves Bun image normalization and ThumbHash, embedded file indexing, a Bun PTY command,
a Monty workflow, live terminal input/output over the binary protocol, and HTTP through a real
workspace `CONNECT` tunnel. These boundaries must be tested in the executable itself because the
normal API gym runs the same source under Node rather than Bun.

The transport smoke also checks multiple successful and rejected HTTP requests on one connection,
SSE cancellation, and a local terminal WebSocket upgrade after an ordinary HTTP request. Use
`--keepalive-only` for the focused HTTP/SSE check. To test the built JavaScript with the pinned Bun
runtime before compiling an executable, pass the Bun executable as the first argument and add
`--bun-source`; this exercises runtime behavior but does not replace release-binary verification.

Run `node scripts/smoke-bun-http.mjs <bun-executable>` for the TCP HTTP half. It starts an isolated
team-mode daemon, verifies generated test-signed WorkOS tokens against a fixture public key, and
checks the same successful/rejected requests on one connection, authenticated SSE cancellation,
terminal input/output and reattachment, invalid-token rejection, and authenticated workspace
HTTP keep-alive and nested CONNECT tunnels.
No real WorkOS account or external WorkOS request is used.

## Native Windows 11 x64

The Windows standalone artifact includes the Bun runtime, Happy's supervisor,
matching sandbox runner and setup helper, native database binding, Python worker,
and provider assets. These files are embedded in one `happy-agent-win32-x64.exe`
and materialized into an owner-controlled, content-addressed cache when used.
The end user does not install Bun, Rust, a compiler, or Codex's app server to run
Happy Agent. Project-specific tools such as Git and Node.js remain requirements
of the projects that use them. Bundled provider executables still require valid
provider credentials; including an executable does not sign the user in.

For a source build, install Node.js 22.19 or newer, pnpm 10.28.1, Git for Windows,
the `1.95.0-x86_64-pc-windows-gnu` Rust toolchain, GNU GCC/G++, GNU `cp`, CMake,
`mingw32-make`, and `tar`. Their executables must be on PATH. Git for Windows
provides `cp.exe` in `usr/bin`; PowerShell's `cp` alias is insufficient for
native build subprocesses. These are developer/build-machine requirements.
The native source revisions, lockfiles, checksums and patches are tracked in
`../native/libsql`, `../native/monty`, `../native/fff`, and
`../../happy-agent-supervisor/native/windows`.

Run from the repository root in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm --filter @slopus/happy-agent-supervisor build:native:windows
pnpm --filter @slopus/happy-agent build:native:monty
pnpm --filter @slopus/happy-agent build:native:fff
pnpm --filter @slopus/happy-agent build:native:libsql
pnpm build
$env:HAPPY_AGENT_RELEASE_VERSION = "0.4.48-local.windows"
pnpm --filter @slopus/happy-agent build:bun
& .\packages\happy-agent\dist\bin\happy-agent-win32-x64.exe --version
```

Use a distinct version for each artifact selected by Desktop. The repository
manifest is `0.0.0`; omitting the build version can therefore trigger Desktop's
minimum-version warning. Building does not install the artifact into Desktop or
publish it. Desktop's normal installer downloads a versioned archive, checks its
digest, extracts the executable, selects it, and starts the agent.

To run a separate local daemon without selecting it for Desktop:

```powershell
$env:HAPPY_HOME_DIR = Join-Path $PWD ".local\windows-agent\.happy"
& .\packages\happy-agent\dist\bin\happy-agent-win32-x64.exe start
& .\packages\happy-agent\dist\bin\happy-agent-win32-x64.exe status
# Stop this same isolated daemon when finished.
& .\packages\happy-agent\dist\bin\happy-agent-win32-x64.exe stop
```

First restricted execution needs Happy's native sandbox provisioning. You can
inspect it with `happy-agent sandbox status` and initialize it explicitly with
`happy-agent sandbox setup`. Windows may request UAC for Happy's setup helper to
create HappySandboxOffline, HappySandboxOnline and HappySandboxUsers and apply
Happy-scoped ACL/network rules. A failed or cancelled attempt is retained; repeated
commands do not retry UAC. After addressing the reported error,
`happy-agent sandbox setup --retry` deliberately permits one more attempt.

The default sandbox state is `.happy/windows-sandbox` under the actual Windows
profile resolved by native code, independent of `HAPPY_HOME_DIR`, `HOME` and
`USERPROFILE`. Isolated daemon homes still share that provisioning. An absolute
`HAPPY_WINDOWS_SANDBOX_HOME` may explicitly select an existing development state;
do not use a fresh provisioning root for each project or test. The global Happy
sandbox accounts cannot safely carry separate per-root credentials.
`HAPPY_WINDOWS_SANDBOX_NO_PROVISION=1` blocks every provisioning path, including
explicit setup, while permitting read-only status and an already prepared sandbox.
Native tests set that guard so an unattended suite cannot open UAC.
Model commands run under restricted, non-administrator identities. An Auto
approval for one exceptional invocation runs that invocation with the signed-in
user's ordinary access; subsequent commands return to the sandbox. It does not
grant the model administrator access.

Automatic first setup is allowed only for the canonical Windows state when no Happy
sandbox accounts exist. An explicit missing development state requires deliberate
`sandbox setup`. After setup returns cancellation or failure, `--retry` may retry it
directly. If a helper is still pending or its outcome is unknown in the current boot,
finish the existing Windows prompt or restart Windows before retrying; a retry never
overlaps that helper.

Sandbox status checks the setup version, saved identities and enabled accounts.
A restricted command verifies that those credentials can actually log on and execute.
Explicit development state overrides still refer to the same global Happy accounts;
they are not independent sandbox installations.

### Windows policy scope

Happy uses the pinned Codex Windows sandbox crate with Happy-specific helper
names, state and OS identities. The launch path is Happy Agent -> supervisor ->
Happy runner -> restricted command. There is no additional custom command-broker
service or bundled Codex server.

The initial Windows boundary follows that implementation rather than promising
identical macOS/Linux policy capabilities. Workspace writes, protected paths,
offline execution, interactive commands and process cleanup are supported.
Protected paths may have Windows-only protected placeholders. Arbitrary independent
read-denial policies for simultaneous commands are not supported by the shared
account/group ACL design. Destination allowlists, proxy enforcement and independent
outbound-versus-listener restrictions are outside this Windows scope; unsupported
policies must fail explicitly. WSL support and Claude-specific onboarding validation
are deferred. This does not change the macOS/Linux implementations.

### Native verification

The native verification commands require Bun 1.4 or newer on PATH alongside Node.
The Windows database regression tests use the locally installed development
binding. After building the native binding, install that same output into the
development dependency explicitly; this does not change the standalone build's
asset path:

```powershell
node packages/happy-agent/scripts/build-native-libsql.mjs --install-development-binding
pnpm --filter @slopus/happy-agent test:native:libsql
pnpm --filter @slopus/happy-agent test:native:monty
pnpm --filter @slopus/happy-agent test:native:fff
pnpm --filter @slopus/happy-agent test:native:transport
# Provision once using sandbox setup before running native checks.
$env:HAPPY_WINDOWS_SANDBOX_NO_PROVISION = "1"
pnpm --filter @slopus/happy-agent-supervisor test:native:windows
pnpm --filter @slopus/happy-terminal-gym-tests test:gym:windows
```

The canonical sandbox state is reused even with a different Happy home. If local
development already uses an explicit provisioned state, retain that same absolute
`HAPPY_WINDOWS_SANDBOX_HOME` for setup, runtime and verification. Native checks
fail early when provisioning is incomplete. This shares provisioning only; gyms
still own isolated workspaces, databases and IPC endpoints. The native lane scripts
inference while running the real terminal, daemon, PowerShell and filesystem.
Live-provider gyms require the separate explicit live opt-ins documented in
[the gym README](../../gym-tests/README.md#native-windows-lane). Passing this lane
does not claim the Docker/Linux exhaustive API suite passed on Windows.

The current public release workflow still publishes the four macOS/Linux targets.
Windows CI build integration, Authenticode signing and public publishing are
separate release work. Local builds are unsigned; do not describe them as a signed
Windows release. Sign matching native helpers before embedding them when preparing
a future signed artifact.
