# Happy Agent gym scenarios

This package holds the end-to-end scenarios for the Happy Agent daemon. Every scenario starts the
real daemon through `createAgentGym` from [`@slopus/happy-agent-gym`](../happy-agent-gym/README.md)
and drives it over the daemon's own socket with `@slopus/happy-agent-client`. Only model inference
is scripted and the machine is emulated; the daemon, routes, agent loop, tools, permissions,
persistence and event journal are the product.

Read the `@slopus/happy-agent-gym` README for the harness API: `createAgentGym` options, scripting
the model, fixtures, waiting for state, and disposal.

## Layout

```text
packages/happy-agent-gym-tests/
├── runGym.ts                   Runs every scenario, isolating timing-sensitive files
├── scripts/runHappyApiSuite.ts Runs the exhaustive Happy Agent API gate
└── tests/                      One behavior per file, named after the behavior
```

Files named `happy_api_*` cover the Happy Agent API contract in
[`packages/happy-agent/API.md`](../happy-agent/API.md). The `happy_api_chaos_*` files replay
deterministic chaos seeds; each seed runs in its own process.

## Running scenarios

The daemon consumes two built packages, so build them first:

```sh
pnpm --filter @slopus/happy-agent-modules build
pnpm --filter @slopus/happy-agent-compute build
```

Run one file while developing:

```sh
pnpm --filter @slopus/happy-agent-gym-tests exec vitest run tests/happy_api_subtasks.test.ts
```

Run one chaos seed:

```sh
API_CHAOS_SEED=S007 pnpm --filter @slopus/happy-agent-gym-tests exec vitest run tests/happy_api_chaos_sync.test.ts
```

Run every scenario with `pnpm test:gym`. The exhaustive API gate, `pnpm test:gym:api`, also
verifies the minimum scenario count and every chaos seed; it takes a long time and runs only when a
human asks for it or a release or API-contract milestone closes.

## Writing a scenario

- Name the file after the behavior it proves, for example
  `happy_api_tasks_follow_per_user_order.test.ts`.
- Register each gym for disposal immediately after creating it.
- Wait for observable state instead of sleeping.
- Assert on API responses, events, files and inference requests rather than daemon internals.
- When fixing a bug, reproduce it here first, then make the same scenario pass unchanged.
