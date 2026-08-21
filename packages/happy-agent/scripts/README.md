# build scripts

The package's ordinary TypeScript build produces its published Node-compatible
JavaScript distribution. `build-binary.ts` takes that distribution and compiles
target-specific Bun executables. The binary compiler owns all platform asset
discovery and adapts third-party runtime-selected native packages at the bundle
boundary; product code remains runtime-neutral.

```text
sources/ ----> tsc ------> dist/cli.js (Node or Bun)
                              |
                              +--> build-binary.ts --> dist/bin/happy-agent-<target>
```

From the repository root, `pnpm build:bun` compiles the current platform and
`pnpm build:bun:all` compiles macOS and Linux for arm64 and x64. Bun 1.3.14 is
pinned by `mise.toml` and invoked at that exact version through `pnpm dlx`, so
the build also works without a version manager and does not install every
cross-platform Bun package into `node_modules`. The four-target outputs are
`dist/bin/happy-agent-darwin-arm64`, `happy-agent-darwin-x64`,
`happy-agent-linux-arm64`, and `happy-agent-linux-x64`.

The manual GitHub release workflow supplies `HAPPY_AGENT_RELEASE_VERSION`; local builds omit it
and use the package manifest version. The override changes only the version embedded in the
compiled executable, leaving the Node-compatible package manifest untouched.
