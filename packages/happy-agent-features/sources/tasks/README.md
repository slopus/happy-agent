# Tasks

A bounded persistent todo list, kept per agent. It exists for the ordinary case of a model
breaking a piece of work into steps, tracking which are done, and picking the work back up after a
restart or a context reset — without the host having to build storage, paging, or dependency
bookkeeping itself. It is not the conversation and not a goal: a goal is the thing an agent is
pursuing, tasks are the checklist it keeps while pursuing it.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { TasksFeature } from "@slopus/happy-agent-features";

const tasks = new TasksFeature({
    storage: { persistence: (agentId) => hostStorage.persistence(agentId) },
    afterCommit: (ctx, callback) => scheduleAfterCommit(ctx, callback),
});
const agent = await Agent.create(ctx, { ...options, features: [tasks] });
```

`storage` and `afterCommit` are required; everything else — `maxTasks`, `defaultPriority`,
`listener`, `idFactory`, `clock`, `maxOutputCharacters`, `maxPageSize`, `onPostCommitError`,
`eventIdFactory` — is optional and defaulted. One `TasksFeature` instance serves every agent in a
collection; each agent's list lives under that agent's own store, so different agents never see
each other's tasks.

## Tools it provides to the model

`tools()` returns five tools, in this order: `create_task`, `list_tasks`, `get_task`,
`update_task`, `complete_task`. All five are `durable: true` and set
`shouldReviewInAutoMode: () => false` — a task list is the agent's own bookkeeping, not the host
machine, so nothing here needs Auto review.

- **`create_task`** — `{ title, detail?, priority?, dependsOn? }`. Creates one task and returns
  `{ task }`. The feature assigns the task's `id` itself (see Storage) so a call that gets retried
  after an interruption lands on the same task instead of creating a duplicate: calling it again
  with the same effective input returns the existing task; calling it again with different values
  for an id that already exists is refused. Creation is refused past the configured `maxTasks`, for
  an unknown dependency, a self-dependency, or a dependency cycle.
- **`list_tasks`** — `{ offset?, limit? }`, both optional and bounded (`limit` up to `maxPageSize`,
  50 by default, 100 at most). Returns a `TaskPage`: `tasks`, `offset`, `limit`, `total`, and an
  optional `nextOffset` the model should follow until every task has been read. The compact rows in
  the returned page are trimmed further, at read time, so the rendered output never exceeds
  `maxOutputCharacters` (12,000 by default) — the page is a genuine short read, not a promise that
  gets truncated after the fact.
- **`get_task`** — `{ id, detailOffset?, detailLimit?, dependencyOffset?, dependencyLimit? }`.
  Returns a `TaskDetailPage`: the full task plus bounded slices of its `detail` (up to 1,024
  characters at once, out of a 4,000-character maximum) and its `dependsOn` list (up to 64 ids at
  once), each with its own `next*Offset` for continuing the read. An unknown id returns
  `{ task: null }` rather than an error, so a stale id used by the model gets a stable, quiet
  answer instead of a thrown exception.
- **`update_task`** — `{ id, title?, detail?, priority?, status?, dependsOn? }`, requiring at least
  one field beyond `id`. `detail: null` clears the stored detail. Returns `{ task }` with the
  merged result; a call that changes nothing still succeeds and returns the task unchanged.
  Changing `status` to `"completed"` here produces the same `task_completed` event as
  `complete_task`.
- **`complete_task`** — `{ id }`. Marks the task completed and returns `{ task }`. Completing an
  already-completed task is a no-op that returns the same task rather than an error, so a repeated
  call is safe.

Every tool's `toLLM` renders through the feature's own formatting (`formatForModel`,
`formatPageForModel`, `formatDetailPageForModel`), so the text a model reads is exactly what the
structured result says and never exceeds `maxOutputCharacters`. `list_tasks` and `get_task` shrink
their own page — fewer rows, a shorter detail slice, fewer dependency ids — until the rendered text
fits, always keeping at least one task or one character visible so a cursor never repeats forever;
if the bound is configured too small to show even that, they throw rather than return truncated
garbage silently.

## External functions

All methods take `(ctx: Context, agentId: string, ...)` and operate on that one agent's list.

- `list(ctx, agentId) => Promise<readonly Task[]>` — every task, in display order.
- `listPage(ctx, agentId, query?) => Promise<TaskPage>` — the same bounded page `list_tasks` uses.
- `get(ctx, agentId, taskId) => Promise<Task | undefined>` — one task, or `undefined`.
- `getPage(ctx, agentId, taskId, query?) => Promise<TaskDetailPage>` — the same bounded lookup
  `get_task` uses.
- `create(ctx, agentId, input: TaskCreateInput) => Promise<Task>`
- `update(ctx, agentId, taskId, changes: TaskUpdateInput) => Promise<Task>`
- `complete(ctx, agentId, taskId) => Promise<Task>`
- `remove(ctx, agentId, taskId) => Promise<boolean>` — not exposed as a tool. Refused while another
  task still depends on it; returns `false` for an unknown id. Removing a task compacts the
  remaining `ordering` values back to a contiguous range starting at zero.
- `reorder(ctx, agentId, taskIds) => Promise<readonly Task[]>` — not exposed as a tool. Sets an
  exact order; the given list must name every current task exactly once.
- `reset(ctx, agentId) => Promise<number>` — not exposed as a tool. Clears the whole list and
  returns how many tasks were removed.
- `tools(ctx, scope) => readonly AnyAgentTool[]` — the five tools above, bound to
  `scope.agent.id`; this is what a host passes into `Agent.create`'s feature wiring.
- `formatForModel`, `formatPageForModel`, `formatDetailPageForModel` — the bounded text renderers
  described above, usable directly by a host that wants the same summaries outside a tool call.

Every mutating call (`create`, `update`, `complete`, `remove`, `reorder`, `reset`) that actually
changes the list produces one `TaskEvent` — `task_created`, `task_updated`, `task_completed`,
`task_removed`, `tasks_reordered`, or `tasks_reset` — carrying a stable `eventId`, a timestamp, and
the `agentId`. If `listener.onEventTransactional` is set it runs inside the same transaction as the
write, so it can still see the change roll back on failure. `afterCommit` schedules
`listener.onEvent` to run once that transaction has actually committed; a failure there does not
undo the mutation, it is only reported through `onPostCommitError` (best-effort — a failure in that
handler is itself swallowed, since a committed task must never be turned into a failed call by
advisory reporting).

## Storage

The feature owns no database. A host supplies `storage: TaskStorage`, an object whose
`persistence(agentId)` returns an `AgentPersistence` for that agent; `assertTaskPersistence`
validates the returned object against the full Agent Base persistence contract before it is used.
Internally, `taskKV(storage, agentId)` wraps that persistence in an `AgentKV` scoped to
`"feature"` / `"tasks"`, so the feature's keys never collide with another feature's keys in the
same store.

- **Task list** — key `"items"` (the constant `TASKS_KEY`) under that scoped `AgentKV`. The value
  is the complete `Task[]` for the agent, matching `taskListSchema` (at most `MAX_TASKS`, 500,
  items; the configured `maxTasks`, 100 by default, is enforced on top of that). Every mutation
  reads this key, decides the new list, and writes it back inside one `AgentKV` transaction —
  that transaction is the read-decide-write serialization boundary, and the feature keeps no
  authoritative state in memory between calls.
- **Create-id retry cache** — key `"create_task_id"` (`CREATE_ID_KEY`), written into the
  call-scoped `AgentKV` obtained from the current context via `agentKV(ctx)` (present while running
  inside a tool call), not into the feature's own agent-scoped store. When `create_task` is called
  without an explicit `id`, the feature generates one with `idFactory` and durably remembers it
  under this key, so a retried call resolves to the same id instead of minting a new task. Outside
  a call context (no `agentKV(ctx)` available), an id is generated fresh each time with no durable
  memory of it.

A stored `Task` is `{ id, title, detail?, status, priority, dependsOn, createdAt, updatedAt,
ordering }`. Every write is re-validated against `taskListSchema` plus these invariants: task ids
are unique; `ordering` values are unique and contiguous from zero; the dependency graph has no
cycle and every dependency id refers to a task that exists and is not the task itself; `updatedAt`
is never before `createdAt`; and stored `title`/`detail` are exactly their trimmed, bounded form
(`title` 1–500 characters, `detail` up to 4,000 characters, or omitted rather than stored as an
empty string). A stored value that fails any of these checks is treated as corrupt and the read
throws rather than silently returning invalid data.
