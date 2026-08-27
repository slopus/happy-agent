# Observation module

`ObservationModule` is what the agent records about itself: logs, traces, and a
readable copy of its history. Three audiences, one module, because all three
answer the same question — what was this agent actually doing — and all three
need the same things: somewhere on disk, a lifetime, and to be started before
any work happens.

```text
~/.happy/agent/observation/
├── agent.log            # one JSON line per record, one previous generation kept
├── agent.log.1
└── history/
    ├── <agentId>.jsonl  # one JSON object per history record, in commit order
    └── <agentId>.jsonl.1
```

## Starting it

`ObservationModule.start` takes the `ConfigModule` — it reads the paths,
settings, and version it needs from there rather than being handed a
configuration — and opens only what those settings ask for. The root it returns
from `install` is the root every other lifetime must be derived from:

```ts
const observation = await ObservationModule.start(config);
const ctx = observation.install(rootContext);
```

A second, optional argument labels the traces with the deployment they came
from; it defaults to `"production"`.

Contexts are immutable, so this ordering is the whole design. `ctx.log` and
`ctx.span` exist on every context and do nothing at all until a logger and a
tracer are installed on the root the rest descend from — a module started on
the _old_ root would log nowhere, for ever.

Nothing else in the codebase has to know this module exists. A module logs with
`withLogContext(ctx, { agentId }).log.info("…")` and traces with
`ctx.span(name, work)`; whether anyone is listening is settled here.

## Settings

`[observation]` in `happy.toml`, or `runtime.toml`, is the source of truth. The
`HAPPY_OBSERVATION_*` environment variables override it for the one-off
debugging run where editing a file would be absurd. An override that cannot be
understood fails loudly rather than being ignored, because a person who set it
believes it took effect.

| Setting           | Environment                         | Default                           |
| ----------------- | ----------------------------------- | --------------------------------- |
| `history_dump`    | `HAPPY_OBSERVATION_HISTORY_DUMP`    | `false`                           |
| `log_level`       | `HAPPY_OBSERVATION_LOG_LEVEL`       | `info`                            |
| `logs`            | `HAPPY_OBSERVATION_LOGS`            | `true`                            |
| `traces`          | `HAPPY_OBSERVATION_TRACES`          | `false`                           |
| `traces_endpoint` | `HAPPY_OBSERVATION_TRACES_ENDPOINT` | `http://127.0.0.1:4318/v1/traces` |

Logging is on because a daemon that records nothing about itself cannot be
supported. Tracing and the history dump are off because both need somewhere to
go — a collector, or disk the user agreed to spend — and neither is worth
turning on for someone who never asked.

The section is deliberately **not** read from the project `happy.toml` layer. A
checked-in file that enabled tracing and named its own endpoint would send this
machine's traces wherever the repository asked.

## Logs

pino writes JSON lines into a `RotatingFileWriter`. Writes never block their
caller: a line is queued, the append happens on a serialized queue, the file
rolls over to one previous generation at its size limit, and a queue that has
fallen too far behind drops lines and counts them. A truthful gap beats
unbounded memory, and a log that cannot be written must never become the
failure it was recording.

Only scalar log-context fields are recorded, up to 64 per line. A context may
carry anything a caller had to hand, including objects with cycles or getters
that throw; a log line is not the place to discover that.

Error arguments retain their stack trace in the message. This keeps a stable
human-readable log label useful without discarding the failure site needed to
diagnose unexpected errors.

Every module startup and ordinary agent hook runs with its stable module name
in the log context. At `trace`, ordinary hook boundaries record their start,
finish, and duration. Raw provider-event hooks stay allocation-free and omit
per-delta boundaries so one streamed response cannot flood or slow the agent;
the observation module records their significant phase changes instead.
Ordinary and transactional hook failures are always recorded, and hooks slower
than 250 ms are also summarized at `debug`.

The observation module adds focused phase records at `debug`: compaction start
and finish, inference start, stream open, first provider activity, retries,
stream resets, inference finish, and tool duration. These records contain IDs
and durations in the message itself, so a filtered log remains understandable.

For one debugging daemon, enable the complete module timeline and reload the
daemon so it inherits the environment:

```sh
HAPPY_OBSERVATION_LOGS=true HAPPY_OBSERVATION_LOG_LEVEL=trace rig daemon reload
```

For a persistent setting, put this in `~/Happy/Config/happy.toml` and reload the
daemon:

```toml
[observation]
logs = true
log_level = "trace"
```

The default log is `~/.happy/agent/observation/agent.log`; when
`HAPPY_HOME_DIR` is set, replace `~/.happy` with that directory. To render the
JSONL as the compact time/module/message view used for interactive debugging:

```sh
tail -F ~/.happy/agent/observation/agent.log | jq -r '\(.time[11:19]) \((.module // "runtime") + "            " | .[0:12])  \(.msg)'
```

## Traces

When `traces` is on, the module starts a `NodeTracerProvider` with a batching
OTLP/HTTP exporter and installs it as a stdlib `Tracer`. It owns that provider
rather than registering the process-global one: a library that quietly took the
global would decide tracing for every host that ever embeds the agent.

Spans themselves belong to the code being measured, through `ctx.span`, not to
this module. Shutdown settles the exporter rather than awaiting it, so a
collector that has gone away cannot fail an otherwise clean shutdown.

## History dump

The durable history already lives in the agent's database, where the model
reads it back through a tool. The dump is for the other audience: a person
tailing a file to see what their agent said and did, without a query, a client,
or a running daemon.

It subscribes to the history module — `history.onAppend(observation.recordHistory)`,
after both modules exist — and that subscription runs _after_ the history
transaction commits, so the file describes exactly what the agent durably
remembers. Agent IDs are validated before they become file names. A message
that will not serialize is skipped rather than replaced with a placeholder,
because a placeholder would be a lie about what the agent said.
