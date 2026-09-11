# Windows release CI

The Windows x64 release is one unsigned `happy-agent-win32-x64.exe` inside
`happy-agent-<version>-win32-x64.tar.gz`, accompanied by a SHA-256 checksum.
The executable embeds Happy's supervisor, sandbox setup and runner helpers,
Monty, libsql, file indexing, and the remaining native runtime assets. End users
do not need Rust, Bun, Node.js, or an installed Codex sandbox.

`.github/workflows/build-windows.yml` is shared by validation and release. Four
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

Unsigned executables can run on ordinary Windows 11 installations. SmartScreen
can warn, and Smart App Control or organizational policy can block them. Signing
will be added separately; this workflow does not weaken Windows security settings.
