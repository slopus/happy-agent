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

From the repository root, `pnpm build:bun` compiles the current platform and
`pnpm build:bun:all` compiles macOS and Linux for arm64 and x64. Bun 1.4.0 is
pinned by `mise.toml` and invoked at that exact version through `pnpm dlx`, so
the build also works without a version manager and does not install every
cross-platform Bun package into `node_modules`. The four-target outputs are
`dist/bin/happy-agent-darwin-arm64`, `happy-agent-darwin-x64`,
`happy-agent-linux-arm64`, and `happy-agent-linux-x64`.

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
