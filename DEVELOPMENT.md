# Developing Happy Agent and Happy Terminal

Thanks for helping improve Happy Agent and Happy Terminal. This guide contains the repository-specific
setup, testing, and release details that contributors need. For product usage
and configuration, start with the [README](README.md).

## Repository layout

This repository is a pnpm TypeScript workspace.

- `packages/happy-agent` contains the headless Happy Agent daemon and lifecycle entry points.
- `packages/happy-agent-modules` contains the daemon's tools and product features.
- `packages/happy-terminal` contains the published `@slopus/happy-terminal` TUI, standalone CLI,
  and Node.js embedding API. Its executable entry point is `packages/happy-terminal/sources/main.ts`.
- `packages/gym` contains the host-side end-to-end harness, PTY integration,
  fixtures, and Docker image definition.
- `packages/gym-tests` contains black-box terminal scenarios that exercise Happy Terminal and
  Happy Agent together in fresh containers.
- `scripts` contains repository release automation.

Shared TypeScript and code-quality configuration lives at the workspace root.
Root commands run the relevant package scripts.

## Setup

Install dependencies from the repository root:

```sh
pnpm install
```

Build and start Happy Terminal with checkout-local state:

```sh
pnpm dev
```

This builds the checkout, reloads its isolated Happy Agent from the built Node CLI,
and runs the built Happy Terminal. The agent socket, token, logs, registry, and session
database stay under the ignored `.happy-terminal-dev` directory instead of the normal
Happy home. The agent remains available after the TUI exits; the next `pnpm dev`
reloads it from the newest build.

## Running this checkout as the global `happy-terminal`

To make `happy-terminal` resolve to a fresh build from this checkout, run:

```sh
pnpm link:global
```

This builds every package, compiles the local Happy Agent Bun binary, installs it as
version `0.0.0` in the normal shared location at
`~/.happy/dist/version/0.0.0/happy-agent`, selects it through the normal
`~/.happy/dist/config.json`, links `packages/happy-terminal` globally through pnpm,
and reloads the daemon from that installed binary. Happy Desktop and Happy Terminal
therefore discover the same local Agent through the same installation state. Run
`pnpm link:global` again whenever you want to rebuild and restart it with newer source.

Use `pnpm unlink:global` to remove only the global Happy Terminal link. It deliberately
leaves Happy Agent `0.0.0` installed and selected. The terminal offers the published
release as an update; running that upgrade is how you leave the local Agent. Selecting
another version in Happy Desktop does the same. Linking the real package uses the
normal Happy home, sessions, and daemon; it is not isolated like `pnpm dev`.

## Live process debugging

Run `/debug` in any interactive Happy Terminal session to start loopback-only Node
inspectors for both the terminal UI and daemon. The command reports the current
session, state directory, and both inspector URLs. In either inspector, evaluate
`globalThis.__happyTerminalDebug` to start walking the live process state.

Breakpoints suspend the process they target until it is resumed. Native
inspector output from the daemon is written to the state directory's
`server.log`. The TUI inherits Happy Terminal's stderr, so redirect it when starting Happy Terminal if
you want to keep inspector messages out of the interface, for example
`happy-terminal 2>happy-terminal-tui.log`. If stderr is still the terminal, `/debug` warns and asks for
confirmation before starting. The inspectors use ephemeral ports bound to
`127.0.0.1`; Node does not authenticate inspector connections, so do not expose
those ports beyond the local machine.

## Validation

Run these checks separately from the repository root:

```sh
pnpm run check
pnpm test
pnpm run build
pnpm run format:check
pnpm run lint
```

Use a check that is proportionate to the change, and run all relevant checks
before publishing.

## End-to-end gym

The gym runs the built Happy Terminal CLI and Happy Agent daemon through a real PTY in a fresh Docker
container. Only inference is mocked; shell processes, tools, files, daemon
behavior, terminal rendering, interruption, and concurrency are real.

Read [packages/gym-tests/README.md](packages/gym-tests/README.md) before creating
or debugging a gym test. It is the source of truth for prerequisites,
`createGym`, fixtures, terminal snapshots, scroll tracking, targeted commands,
and cleanup.

Run the complete suite with:

```sh
pnpm test:gym
```

For a behavior regression, first reproduce the failure in
`packages/gym-tests/tests`, then make the same scenario pass without weakening
it. Name scenarios for the behavior they prove, interact at the terminal
boundary, wait for observable state instead of sleeping, and dispose every gym
instance.

## Agent evaluations

Read [EVALUATIONS.md](EVALUATIONS.md) before comparing Happy Terminal with another agent
harness. It defines the frozen hard-task suite, paired run contract, spend
gates, Docker and credential isolation, preflight requirements, and reporting
rules. A benchmark run is not authorized merely because its configuration is
documented; paid trials remain blocked until that guide's preflight is complete.

## Provider reference sources

Local reference implementations live in `~/Developer/coding-assistant-sources`,
including the Codex and Claude Code source trees. Consult them when implementing
or comparing provider-aligned behavior. Preserve the useful model-facing
semantics while adapting them to Happy Terminal's simpler product model.

Pi packages are used as foundations for model streaming and the terminal UI.
Happy Terminal intentionally layers a curated experience on top instead of mirroring every
Pi customization mechanism.

## Code organization

Favor one function per file when adding or reshaping source code. Keep all
user-facing strings human-readable, and translate protocol values or internal
identifiers into natural English before rendering them.

For terminal work, treat the visible transcript as append-only. Update an
existing activity row in place when its state changes, and move completed live
work into history without making the composer jump.

## Publishing

Happy Terminal releases are dispatched manually through the `Release Happy Terminal`
GitHub Actions workflow from `main`. The action requires an explicit semantic version and
Markdown change notes. It applies that version to an ephemeral checkout, typechecks, tests,
builds, packs, and smoke-tests the exact npm tarball before it creates any tag.

After those gates pass, the action commits the requested package version to `main`, creates
`happy-terminal-v<version>` on that exact commit and opens a draft GitHub Release. It publishes
the verified tarball as `@slopus/happy-terminal` through npm Trusted Publishing, verifies the
registry, and then makes the GitHub Release public. Prereleases use their own npm channel, such
as `beta`; stable releases move `latest`.

### Beta releases

Dispatch the workflow with the next explicit beta version when a change should reach early
adopters quickly. Beta releases use npm's `beta` distribution tag and never move `latest`.
Install or advance to the newest beta with:

```sh
happy-terminal upgrade
```

That command runs `npm install -g @slopus/happy-terminal@beta`. When the installed version
is a canary, it preserves that channel and installs `@slopus/happy-terminal@canary`
instead.

### Canary builds

Every push to `main` publishes a canary to npm under the `canary` distribution
tag, so a change can be installed and used before it is released:

```sh
npm install --global @slopus/happy-terminal@canary
```

A canary is versioned from the release it followed — `0.0.148-canary.<build>.<commit>`
after `0.0.147` — so reading one tells you what it is built on. Being a
prerelease keeps it out of the way: npm excludes prereleases from ranges that do
not ask for them, so no ordinary install resolves a canary, and publishing one
never moves `latest`. Nothing needs versioning by hand; the workflow sets it.

If the action fails before creating the tag, fix the issue and rerun the same version. Once a
tag exists, never move or reuse it; advance to the next release version if publication failed.

### One-time publishing setup

The release workflow uses npm Trusted Publishing, so it does not need a
long-lived npm token or a contributor's npm account:

1. npm requires a package to exist before a trusted publisher can be attached. An npm owner
   must therefore publish a one-time placeholder version to initialize the
   `@slopus/happy-terminal` name. Do not create a release tag for the placeholder.
2. In the GitHub repository settings, create an environment named `npm` and allow deployments
   from `main`.
3. In the npm settings for `@slopus/happy-terminal`, add a GitHub Actions trusted publisher
   for organization `slopus`, repository `happy-agent`, workflow
   `release-happy-terminal.yml`, and environment `npm`. Allow the `npm publish` action.
4. Do not create an `NPM_TOKEN` GitHub secret. The workflow requests a short-lived
   OIDC credential for each run and npm automatically records provenance for the
   public package.

Anyone with GitHub Actions write access can then dispatch the release from an up-to-date
`main` branch without receiving npm access. The workflow, rather than a local release command,
owns tag creation.
