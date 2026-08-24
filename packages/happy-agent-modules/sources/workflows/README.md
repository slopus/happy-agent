# Workflows

A workflow is a Python script that decides which agents to run and in what order. The module runs
that script itself, inside a `@pydantic/monty` sandbox with no filesystem, shell, environment or
network of its own, and starts every agent the script asks for as an ordinary collaborator. There
is no host runtime behind it: execution, checkpointing, and the durable run catalog all live here.

```ts
const workflows = new WorkflowsModule(config, collaboration, computeModule);
```

`config` says whether workflows are turned on at all — `[features] workflows` — and the module reads
it rather than being told. `collaboration` is the module that starts the agents. `compute` is used
for one thing only: reading a script the model named by path.

A run outlives the tool call that started it, so it cannot execute on that call's context. The
module derives its own lifetime the first time a run starts: it detaches the context it was handed,
names it `workflow-run`, and carries the agent database across. Starting a run without an agent
database in context is an error, because there would be nothing for the run to be written to.

Bounds are constants here, not settings: a page holds at most 50 runs, a log read at most 200 lines,
and a script's output is elided past 12,000 characters.

## Events

`onEventTransactional(listener)` runs the listener inside the mutation transaction, so throwing from
it rejects the change. `onEvent(listener)` runs after the change has committed and is advisory: a
failure there is logged with a bounded reason and the run carries on. Both return the function that
ends that one subscription; calling it twice is harmless.

## How a run executes

The script's `agent`, `parallel` and `pipeline` externals block until their agent has finished. The
sandbox is checkpointed and unloaded at every external-call boundary and freshly restored
afterwards, so model thinking time does not consume the script's own execution budget, and the
checkpoint is written to the database as it is taken.

An agent call creates a collaborator with `reportToCreator: false` and workflow metadata naming the
run and the call index. That flag is what keeps a 200-agent workflow from putting 200 messages into
the calling agent's chat: the workflow collects the answer itself, through its own
`onEventTransact`, `onEvent` and `afterAgentSettledTransact` hooks. The answer is recorded in the
settling transaction, before anything in memory is told about it, so it survives a restart.

Inline scripts are capped at 524,288 characters, arguments are finite-depth JSON capped at 65,536
encoded bytes, and a run may start at most 1,000 agents.

## Restart recovery and resuming

`afterStart` runs after Agent Base has restored every active collaborator. It finds each workflow
still marked running, restores the script from its latest durable checkpoint, reuses calls that
already answered, and reattaches unanswered calls to their original collaborator identities. A
daemon restart therefore leaves the workflow running without paying for the active agents again.

A legacy run that has no stored executable launch cannot be reconstructed automatically and is
marked `paused` instead. `resume_workflow` continues a paused run when its launch is available.
`resumeFromRunId` reuses a prior run's checkpoint and answered calls across runs, for a script that
has not changed.

## Tools

- `run_workflow` starts a workflow from `script` or `scriptPath`.
- `list_workflows` returns a bounded page of runs.
- `workflow_status` reads one run.
- `cancel_workflow` cancels a non-terminal run.
- `resume_workflow` continues a paused run.
- `wait_workflow` waits for a run to settle.
- `workflow_logs` returns a bounded page of the notes a script wrote.

Every tool is scoped to `scope.agent.id`. An inline script is text the model already holds, so
starting one crosses no boundary and Auto does not review it. A `scriptPath` is a file on the
machine, so it is described, reviewed and elevated exactly like any other filesystem read.

## Persistence and migrations

The current tables are:

- `happy_agent_module_workflow_runs`
- `happy_agent_module_workflow_logs`
- `happy_agent_module_workflow_checkpoints`
- `happy_agent_module_workflow_agent_calls`
- `happy_agent_module_workflow_launches`

Migrations `001-workflows-runs` and `002-workflows-drop-replay-evidence` remain immutable.
`003-workflows-execution` adds the checkpoint, agent-call and launch tables this module needs to
run and resume a script itself.
