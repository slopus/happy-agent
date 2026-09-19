# Windows release CI

The Windows x64 release is one `happy-agent-win32-x64.exe` inside
`happy-agent-<version>-win32-x64.tar.gz`, accompanied by a SHA-256 checksum.
The executable embeds Happy's supervisor, sandbox setup and runner helpers,
Monty, libsql, file indexing, and the remaining native runtime assets. End users
do not need Rust, Bun, Node.js, or an installed Codex sandbox.

`.github/workflows/build-windows.yml` is shared by validation and release. Three
native build jobs use the source revisions, patches, and Rust toolchain pinned
in the repository. A fresh Windows runner then builds the standalone executable,
checks libsql lifetimes, native file indexing, named-pipe transports, and sandbox
enforcement, and runs the packaged daemon through the scripted inference smoke
(commands, PTY, Monty workflow, images, indexing, and terminal/proxy transports).
These are deterministic checks; they do not call a paid inference provider.

The disposable hosted runner provisions Happy's sandbox once, then disables all
further provisioning for the checks. This creates Happy's accounts and firewall
rules only on that disposable machine. No setup state or credentials are uploaded.

To validate a branch without publishing:

```sh
gh workflow run verify-supervisor.yaml --ref <branch> -f windows_only=true
```

Download `happy-agent-win32-x64` from the completed run. Validation builds use a
prerelease version. An actual release still uses the existing manual
`release-happy-agent.yml` workflow from `main`, with a release version and notes;
its publish job waits for Windows and all existing macOS/Linux jobs. macOS
signing and notarization are unchanged.

## Azure Artifact Signing

Signing runs only on `main` with repository variable `WINDOWS_SIGNING_ENABLED=true`.
Other branches keep producing unsigned validation artifacts. A signing error
fails the build; it never falls back to an unsigned release when enabled.

Set these GitHub Actions repository variables after Azure identity validation and
creation of a Public Trust certificate profile:

| Variable                    | Value                                                         |
| --------------------------- | ------------------------------------------------------------- |
| `AZURE_CLIENT_ID`           | Application/client ID for the GitHub signing identity         |
| `AZURE_TENANT_ID`           | Azure tenant ID                                               |
| `AZURE_SUBSCRIPTION_ID`     | Subscription containing the signing account                   |
| `WINDOWS_SIGNING_ENDPOINT`  | Regional endpoint, e.g. `https://wus2.codesigning.azure.net/` |
| `WINDOWS_SIGNING_ACCOUNT`   | Artifact Signing account name                                 |
| `WINDOWS_SIGNING_PROFILE`   | Approved Public Trust certificate profile name                |
| `WINDOWS_SIGNING_PUBLISHER` | Exact approved certificate common name or full subject        |
| `WINDOWS_SIGNING_ENABLED`   | `true` after provisioning is complete                         |

Use GitHub OIDC with issuer `https://token.actions.githubusercontent.com`, audience
`api://AzureADTokenExchange`, and subject
`repo:slopus/happy-agent:ref:refs/heads/main`. The Azure application needs **Artifact
Signing Certificate Profile Signer** on the certificate profile. GitHub holds no
client secret or private key. An application shared with Desktop needs a separate
federated credential for each repository.

The build stages private copies of embedded `.exe`, `.dll`, and `.node` assets
and signs them before Bun compiles the standalone Agent. Existing valid,
timestamped vendor signatures are preserved. The final Agent executable is then
signed before smoke checks, archive creation, and SHA-256 generation. Both stages
verify timestamped signatures; new signatures must match the configured publisher.
Native build caches and installed dependencies remain reusable and unsigned by
Happy. The signing module is pinned in both the workflow and signing script.

Run Windows validation from `main` before the first signed release. Unsigned
executables can trigger SmartScreen warnings or be blocked by Smart App Control
or organizational policy. Signing does not guarantee immediate SmartScreen
reputation; the workflow does not change Windows security settings.
