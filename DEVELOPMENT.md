# Developing Happy Agent

Thanks for helping improve Happy Agent. This guide contains the repository-specific setup,
testing, and release details that contributors need. For product usage and configuration, start
with the [README](README.md).

## Repository layout

This repository is a pnpm TypeScript workspace.

- `packages/happy-agent` contains the headless Happy Agent daemon and lifecycle entry points.
- `packages/happy-agent-modules` contains the daemon's tools and product features.
- `packages/happy-agent-gym` contains the end-to-end harness that starts the real daemon with
  scripted inference on an emulated machine.
- `packages/happy-agent-gym-tests` contains the black-box scenarios that drive the daemon through
  its API.
- `scripts` contains repository release automation.

Shared TypeScript and code-quality configuration lives at the workspace root.
Root commands run the relevant package scripts.

## Setup

Install dependencies from the repository root:

```sh
pnpm install
```

Build every package:

```sh
pnpm build
```

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

The gym starts the real Happy Agent daemon on a throwaway installation and drives it over its own
socket. Only inference is scripted and the machine is emulated; the daemon, routes, tools,
permissions, persistence, interruption, and concurrency are real.

Read [packages/happy-agent-gym/README.md](packages/happy-agent-gym/README.md) and
[packages/happy-agent-gym-tests/README.md](packages/happy-agent-gym-tests/README.md) before
creating or debugging a gym test. They are the source of truth for `createAgentGym`, fixtures,
scripted inference, targeted commands, and cleanup.

Run the complete suite with:

```sh
pnpm test:gym
```

For a behavior regression, first reproduce the failure in
`packages/happy-agent-gym-tests/tests`, then make the same scenario pass without weakening it.
Name scenarios for the behavior they prove, interact at the API boundary, wait for observable
state instead of sleeping, and dispose every gym instance.

## Agent evaluations

Read [EVALUATIONS.md](EVALUATIONS.md) before comparing Happy Agent with another agent
harness. It defines the frozen hard-task suite, paired run contract, spend
gates, Docker and credential isolation, preflight requirements, and reporting
rules. A benchmark run is not authorized merely because its configuration is
documented; paid trials remain blocked until that guide's preflight is complete.

## Provider reference sources

Local reference implementations live in `~/Developer/coding-assistant-sources`,
including the Codex and Claude Code source trees. Consult them when implementing
or comparing provider-aligned behavior. Preserve the useful model-facing
semantics while adapting them to Happy Agent's simpler product model.

Pi packages are used as foundations for model streaming. Happy Agent intentionally layers a
curated experience on top instead of mirroring every Pi customization mechanism.

## Code organization

Favor one function per file when adding or reshaping source code. Keep all
user-facing strings human-readable, and translate protocol values or internal
identifiers into natural English before rendering them.

## Publishing

Ask an agent to release; it follows the [release instructions](.agent/skills/release-agent/SKILL.md).
An unqualified request publishes a Happy Agent preview (`X.Y.Z-preview.N`) for
Nightly Desktop. Explicit production requests publish the next stable patch.
Both use the existing manually dispatched workflow: version and notes in,
build/test/sign and publication in one run. Previews never move GitHub's stable
latest release. Previews are requested, not triggered by pushes.

SDKs keep their existing tagged publication workflows, which publish through npm Trusted
Publishing without a long-lived npm token.

If publication fails before a tag exists, fix the issue and rerun the version.
Never move or reuse an existing tag; advance the release version instead.

### Contributors with push permissions

With release access you can request an Agent preview and test it on Nightly
Desktop. Publish and repin changed SDKs only when the candidate needs new
published dependencies; that is not a prerequisite for every preview. The flows are
described in [master-plans/25-releases.md](master-plans/25-releases.md).
