# Happy agent gym

The Happy agent gym is the end-to-end harness for `@slopus/happy-agent`. It starts the real daemon
on a throwaway Happy installation, serves it a scripted model, and gives the agent an emulated
machine instead of this computer. A scenario then drives it through
`@slopus/happy-agent-client` over the daemon's own Unix socket.

## What is real and what is not

| Part                                | Behavior in the gym                                    |
| ----------------------------------- | ------------------------------------------------------ |
| Daemon, socket, token, `/v0` routes | Real                                                   |
| Agent loop, turns, steering, abort  | Real                                                   |
| Every module and its tools          | Real                                                   |
| Permissions and the auto reviewer   | Real                                                   |
| Databases and durable events        | Real SQLite, in a temporary folder                     |
| Model inference                     | Scripted in process                                    |
| The machine the agent works on      | just-bash, mounted over the gym's own workspace folder |

Only two things are substituted. The model is scripted, because a test cannot depend on a live
provider. The machine is emulated, because a test must not run commands on the computer running it:
commands execute inside just-bash over one folder, so files really change and `gym.readFile` sees
them, but no host process is ever started and nothing outside that folder exists.

The emulated machine shares this computer's loopback network. A fixture server a test starts on
`127.0.0.1` is reachable from the agent's machine, for example through the agent's workspace
proxy, and `gym.machineConnections` lists every connection a machine opened with that machine's
working directory, so a scenario can prove which machine a connection came from.

Everything between those two substitutions — the loop, tool dispatch, permissions, persistence,
the HTTP layer and the event journal — is the product.

## Running the tests

The gym runs on Bun, the runtime Happy Agent ships on, at the version `mise.toml` pins; its
`test` script starts Vitest there with `--bun`. Every Vitest worker checks its runtime before a
test starts and fails under Node or another Bun, unless `HAPPY_GYM_RUNTIME=node` declares a
deliberate Node run. The gym consumes three built packages:

```sh
pnpm --filter @slopus/happy-agent build:native:monty
pnpm --filter @slopus/happy-agent-modules build
pnpm --filter @slopus/happy-agent-compute build
pnpm --filter @slopus/happy-agent build
pnpm --filter @slopus/happy-agent-gym test
```

One file at a time:

```sh
pnpm --filter @slopus/happy-agent-gym test tests/agent_answers_a_user_message.test.ts
```

The scenarios that must also pass under Node live in
[`@slopus/happy-agent-gym-tests`](../happy-agent-gym-tests/README.md#the-node-lane).

On a deeply nested checkout, set `HAPPY_AGENT_GYM_SCRATCH_DIRECTORY` to a shorter ignored
directory inside the checkout. The default remains `.local`; socket-length checks and fixture
isolation are unchanged. For example, an ignored `.g` directory saves four socket-path bytes.

## Basic scenario

```ts
import { afterEach, describe, expect, it } from "vitest";

import { createAgentGym, type AgentGym } from "../sources/index.js";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("the agent answers a user message", () => {
    it("records the answer and shows the model what was asked", async () => {
        const gym = await createAgentGym({
            inference: [{ content: [{ text: "Done.", type: "text" }] }],
        });
        running.add(gym);

        await gym.send("Track this request.");

        expect(gym.inference.userTexts()).toContain("Track this request.");
        expect(JSON.stringify(await gym.sessionEvents())).toContain("Done.");
        expect(gym.errors).toEqual([]);
    });
});
```

Register the gym for disposal immediately after creating it. A leaked gym leaves a daemon, a socket
and a database behind, and the next scenario pays for it.

## `createAgentGym` options

```ts
interface AgentGymOptions {
    config?: string;
    compaction?: GymCompactionHandler;
    files?: Record<string, GymFixture>;
    inference?: readonly GymTurn[] | GymInferenceHandler;
    models?: readonly AgentModel[];
    routeConfiguredProviders?: boolean;
    liveProviders?: readonly string[];
    permissionMode?: "read_only" | "workspace_write" | "auto" | "full_access";
    timeoutMs?: number;
    version?: string;
}
```

| Option                     | Default           | Purpose                                                                                                            |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `config`                   | none              | Extra TOML appended to the installation's `Happy/Config/happy.toml` on macOS or `happy/config/happy.toml` on Linux |
| `compaction`               | empty completion  | How a scripted compaction answers                                                                                  |
| `files`                    | `{}`              | Files written into the agent's working directory before it starts                                                  |
| `inference`                | `[]`              | The scripted turns, or a handler answering each request                                                            |
| `models`                   | two gym models    | Replaces the catalog the gym serves                                                                                |
| `routeConfiguredProviders` | `false`           | Builds configured smart routes over scripted accounts instead of replacing the provider registry                   |
| `liveProviders`            | none              | Configured provider IDs that keep their real implementation and serve live inference; for opt-in live scenarios    |
| `permissionMode`           | the agent default | Writes `[defaults] permission_mode` into the configuration                                                         |
| `timeoutMs`                | `10_000`          | The default budget for every `waitFor` in this gym                                                                 |
| `version`                  | `"gym"`           | The version the daemon reports                                                                                     |

A fixture is a string, a `Uint8Array`, or `{ content, mode }`. Paths are relative to the workspace
and may not leave it.

Team-mode scenarios configure the real JWT verifier in `config` and supply `teamUser: { token,
name }` with a test-issued token. The gym uses the daemon's actual TCP endpoint and ordinary
profile onboarding before registering its workspace; it never creates users directly or bypasses
authentication. Bind test deployments to `host = "127.0.0.1"`, `port = 0`. Typed API and SSE
helpers work normally. Raw Unix-socket probes remain standalone-only. Team fixtures never need
external credentials or an identity-provider network request when using a test-owned public key.

## Scripting the model

A turn describes what the model produced, and nothing about what the agent should do with it.

```ts
const inference = [
    {
        content: [
            { type: "reasoning", text: "The readme is the place to look." },
            { type: "tool_call", name: "exec_command", arguments: { cmd: "cat README.md" } },
        ],
    },
    { content: [{ type: "text", text: "The readme describes a fixture repository." }] },
];
```

A turn with a tool call ends as `tool_call`; the agent runs the tool and asks again, consuming the
next turn. Every other turn ends normally.

A fixed array scripts only the real agent loop. Detached automatic-title sessions receive a
deterministic gym title and stay out of the fixed script's request log, so their background race
cannot consume an entry, change a call index, or reorder the scenario. A handler receives and logs
every inference request, including sessions whose ID starts with `naming:`, and can script naming
explicitly when that behavior is what the scenario exercises.

Fields a turn may set:

- `content` — text, reasoning, and tool-call blocks, in order.
- `events` — exact `SessionEvent`s instead of `content`, for streams no ordinary turn produces.
- `delayMs`, `textDeltaChunkSize`, `textDeltaDelayMs` — deterministic streaming and delays that
  stop early when the turn is aborted.
- `retries` — provider-owned retry progress reported before any content.
- `usage` — token accounting; omitted usage is zeroed.
- `error` — end the turn as a provider failure (`{ message, kind?, providerError? }`).
- `endTurn` — report the model as having nothing further to add.

A handler answers each request instead:

```ts
const gym = await createAgentGym({
    inference(request) {
        if (request.callIndex === 0) {
            expect(request.messages.at(-1)).toMatchObject({ role: "user" });
            return { content: [{ type: "text", text: "First." }] };
        }
        return { content: [{ type: "text", text: "Second." }] };
    },
});
```

When a fixed script runs out, the gym ends the turn with an explanatory provider error and records
the request in `gym.inference.unscripted`. Assert `unscripted` is empty in scenarios that are meant
to stay inside their script.

### Reading what the model was asked

```ts
gym.inference.requests; // every run request, oldest first
gym.inference.last; // the most recent one
gym.inference.compactions; // every compaction request
gym.inference.userTexts(); // user text, in order
gym.inference.toolResults(); // tool results returned to the model
gym.inference.lastTools(); // tool names offered during the last run
```

## Driving the agent

```ts
await gym.send("Do the thing."); // waits for the run to settle
await gym.send("Later.", { wait: false }); // returns as soon as it is accepted
await gym.steer("Actually, stop at the readme."); // joins the run already going
await gym.abort();
await gym.compact();
const agent = await gym.createSession({ cwd: gym.workspacePath });
await gym.send("In the new agent.", { sessionId: agent.id });
```

`gym.defaultSessionId` is the default agent the gym opens in its root workspace. Every message
names the provider, model, effort and tier from `gym.selection` unless the scenario overrides
them.

Anything the helpers do not cover goes through the client directly, which never throws on an
unsuccessful status:

```ts
const response = await gym.http.post(`/v0/agents/${gym.defaultSessionId}/send`, body);
expect(response.status).toBe(400);
expect(response.text).toContain("not served by provider");
```

`gym.http.ok(method, path, body?)` returns the body of a request that had to succeed.

## Events

Three vocabularies exist, and a scenario should assert against the one it means.

**Durable events** are the API journal: `agent.created`, `run.started`, `run.boundary`,
`run.finished`, `message.created`, `message.updated`, and `message.delta`.

```ts
const settled = await gym.waitForEvent(
    (event) => event.type === "run.finished",
    "the run to settle",
);
expect(settled.payload).toMatchObject({ run: { reason: "completed" } });
```

`gym.waitForRun(runId)` is the same wait for one specific run, and `gym.send` uses it.

`gym.sessionEvents()` filters that same public journal to one agent; it does not use a separate
projection endpoint.

**Server-Sent Events** use `/v0/events/stream`. It sends a `hello` frame, then names each frame
after the event's own type. `frameEvent(frame)` returns the event envelope.

```ts
const stream = gym.stream("/v0/events/stream");
try {
    await stream.opened();
    await gym.send("Stream this.");
    await stream.waitFor((frame) => frameEvent(frame)?.type === "run.finished");
} finally {
    stream.close();
}
```

Open the stream before the action it should observe. Frames are kept from the moment it opens, so
waiting afterwards cannot miss anything.

## The workspace

`gym.workspacePath` is the agent's working directory and the folder the emulated machine is mounted
over.

```ts
await expect(gym.readFile("copy.md")).resolves.toBe("fixture repository\n");
await gym.writeFile("notes.md", "changed while the agent was running\n");
expect(await gym.listFiles()).toContain("README.md");
```

The installation's configuration lives in `Config/happy.toml` inside that same folder, so a
directory listing legitimately contains it.

## Restarting

`gym.restart()` closes the daemon and starts another one on the same folder. Use it for durability:
history, installation identity, the root chat, event ordering, and unfinished work after a crash.
Each daemon start receives fresh scripted provider instances, as it would in a new process. The
script, its cursor, models, and log survive the restart, and each provider's run and compaction
call indexes continue. A script may therefore span both processes without retaining provider
decorations from the previous daemon. Configured routes share that start's provider set.

`gym.restart({ whileStopped })` runs `whileStopped` while no daemon is running. With
`runGymSql(gym.happyHome, statements)` a scenario rewrites stored data the way an earlier release
left it, then starts the current build on it to test an upgrade. `recordGymMigration` does the same
for a newer release's migration ledger.

## Runners

`gym.startRunner({ home, token })` starts the real `happy-agent runner` process from the built
`@slopus/happy-agent` and points it at the daemon's socket. Configure the runner first, and place
its home inside the gym's directory:

```ts
const gym = await createAgentGym({
    config: `[runners]\ndefault = "local"\n\n[runners.box]\nname = "Box"\ntoken = "${TOKEN}"\n`,
});
const runner = await gym.startRunner({
    home: join(dirname(gym.workspacePath), "runner-home"),
    token: TOKEN,
});
await gym.client.registerProject({ path: join(runner.home, "repository"), runnerId: "box" });
```

Unlike the agent's emulated machine, a runner is a real process on this computer serving real
files, Git, and processes from its home, because that is what a runner is. `runner.stop()` stops it
with `SIGTERM`, which says goodbye; `runner.kill()` ends it without one; `runner.output` holds the
tail of its log. The gym kills every runner it started when it is disposed. Runner scenarios need
`git` on the machine running the tests.

## Waiting

Wait for state, never for time. `gym.waitUntil(check, description, timeoutMs)` polls until `check`
returns something other than `undefined`, and reports what it saw when it gives up. `setTimeout` in
a scenario is a bug: it is slow on a fast machine and flaky on a slow one.

## Naming scenarios

One coherent behavior per file, named after that behavior:

- `agent_runs_a_command_on_the_emulated_machine.test.ts`
- `agent_survives_a_restart_and_streams_live_events.test.ts`
- `message_with_an_unserved_model_is_refused.test.ts`

Avoid `agent.test.ts`, `integration.test.ts`, or a bare issue number.

## Assertion guidance

A strong scenario asserts more than the last sentence the model produced:

- **What the client sees** — the agent events, agent record, or HTTP status.
- **What the model was shown** — exact user text, tool results, conversation order, offered tools.
- **What really happened** — files in the workspace, durable events, the run's stop reason.
- **That it still works** — a second turn after the first.
- **That nothing broke quietly** — `gym.errors` is empty and `gym.inference.unscripted` is empty.

## Common mistakes

- Forgetting to dispose a gym, or disposing only on success.
- Sharing a mutable inference array between gyms.
- Sleeping instead of waiting for state.
- Asserting on `frame.event` for the live stream, which names every frame `update`.
- Waiting for a steering message's run to settle, when steering joins a run already under way.
- Treating an emulated-machine failure as a host-machine failure: this gym has no host boundary,
  and a scenario that needs one belongs somewhere else.

## Session speed benchmark

`perf/ciBench.ts` seeds a throwaway installation through the daemon API — a few sessions with long
histories and a few hundred without — then restarts the daemon (`perf/serve.ts`, in a child
process) and records medians: restart until ready, the first desktop bootstrap and history read
after it, the warm desktop bootstrap, and opening a long session. `perf/ciCompare.ts` compares two
results and prints warnings for what got slower; it never fails.

```sh
cd packages/happy-agent-gym
PERF_OUT=/tmp/head.json node --import tsx perf/ciBench.ts
node --import tsx perf/ciCompare.ts /tmp/base.json /tmp/head.json
```

The `Session speed` workflow runs both on a pull request's base and head and reports in the job
summary. It is not a required check and never blocks a merge or a release.
