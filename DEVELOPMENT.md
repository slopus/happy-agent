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

This builds the checkout, reloads its isolated Happy agent, and runs the built
Happy Terminal CLI. The agent socket, token, logs, registry, and session database stay
under the ignored `.happy-terminal-dev` directory instead of the normal Happy home. The
agent remains available after the TUI exits; the next `pnpm dev` reloads it from
the newest build.

## Running this checkout as the global `happy-terminal`

To make `happy-terminal` resolve to a fresh build from this checkout, run:

```sh
pnpm link:global
```

This builds every package, links `packages/happy-terminal` globally, and reloads the normal
Happy Agent daemon from that build. The link points at this checkout, but Happy Terminal executes
`packages/happy-terminal/dist/main.js`, so run `pnpm link:global` again whenever you want to
rebuild and restart it with newer source.

Use `pnpm unlink:global` to remove the link before installing a published Happy Terminal
again. Linking the real package uses the normal Happy home, sessions, and daemon;
it is not isolated like `pnpm dev`.

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

From a clean, current `main` branch, publish a release with new features in it:

```sh
pnpm release minor
```

or one that only fixes things:

```sh
pnpm release patch
```

Both are ordinary releases; pick by what is in it rather than by how large it
feels. An exact version such as `pnpm release 0.4.0` says the same thing
explicitly, and there are `pnpm release:minor` and `pnpm release:patch`
shorthands.

Happy Terminal is still on `0.x` and takes no major release, which the command refuses. A
major version is a promise about compatibility, and Happy Terminal deliberately changes its
own schemas, protocol, and configuration instead of carrying migrations for
them. Leaving `0.x` is a decision about the product rather than about one
release, so it is made by changing the rule in
`scripts/release/assertReleaseBumpAllowed.ts` rather than by passing a flag.

The command runs type checks and tests, builds the package, creates the release
commit and tag, previews the package contents, and pushes the release to `main`.
Pushing a tag named `happy-terminal-v<package version>` starts the `Publish package` GitHub
Actions workflow, which repeats the validation and publishes `@slopus/happy-terminal` to
npm.

### Beta releases

Publish the next beta when a change should reach early adopters quickly:

```sh
pnpm release beta
```

From a stable version this creates the next patch as `-beta.0`; each later beta
increments that suffix. Beta releases run type checks and build the package but
skip tests both locally and in the publish workflow. They use npm's `beta`
distribution tag and never move `latest`. Install or advance to the newest beta
with:

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

If the local release is interrupted before the tag is pushed, rerun the command
with the exact version to resume safely. If the GitHub Actions job fails, fix the
configuration or transient failure and rerun that job instead of creating a new
tag.

### One-time publishing setup

The publish workflow uses npm Trusted Publishing, so it does not need a
long-lived npm token or a contributor's npm account:

1. In the GitHub repository settings, create an environment named `npm`. Under
   deployment branches and tags, select only matching tags and add `happy-terminal-v*`. Do not
   add required reviewers if every collaborator with permission to create tags
   should be able to release.
2. In the npm settings for `@slopus/happy-terminal`, add a GitHub Actions trusted publisher
   for organization `slopus`, repository `happy-terminal`, workflow `publish.yml`, and
   environment `npm`. Allow the `npm publish` action.
3. Do not create an `NPM_TOKEN` GitHub secret. The workflow requests a short-lived
   OIDC credential for each run and npm automatically records provenance for the
   public package.

Anyone with GitHub write access can then run `pnpm release <version>` from an
up-to-date `main` branch without receiving npm access. Keep tag creation limited
to trusted collaborators; creating a matching tag is authorization to publish.
