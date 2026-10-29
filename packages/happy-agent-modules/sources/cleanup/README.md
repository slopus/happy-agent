# Cleanup

Lets an admin bot find what an installation holds and remove it for good. It searches every bot,
task, subtask, project, and workspace with activity rolled up from everything under each, tells
which records own a folder, lists folders under the Happy roots that nothing owns, and permanently
deletes one item with everything that belongs to it.

```ts
const cleanup = new CleanupModule(
    config,
    runners,
    bots,
    tasks,
    subtasks,
    projects,
    workspaces,
    history,
    abort,
    durableFunctions,
);
```

## Tools

Only an active admin bot is offered the tools, and every call checks that again. All are deferred.

- `search_instance` — BM25 over each row's kind, name, folder, branch, parent name, bot username,
  task folder name, and project description; prefix matching for query words of three or more
  characters. Filters by kind, status, owner, `activeSince`, `inactiveSince`, `createdAfter`, and
  `createdBefore`; sorts by `relevance`, `recent`, or `stale`; pages with a cursor. An empty query
  lists by recency. Not reviewed in Auto.
- `find_folder_owners` — the rows and agents whose folder a path is, that hold it, or that lie
  inside it, each with whether it is running, idle, or archived. Not reviewed in Auto.
- `find_orphan_folders` — directories under the bots, tasks, workspaces, and projects roots of this
  machine and the default runner that no row or agent names. A directory that holds a known folder
  is looked into rather than reported. Not reviewed in Auto.
- `preview_delete` — everything deleting one item would remove, and the confirmation code that
  names exactly that set. Changes nothing. Not reviewed in Auto.
- `delete_permanently` — carries out a previewed deletion. Durable, transactional, and reviewed in
  Auto.

## Rows and activity

`collectCleanupEntries` reads every bot, task, project, and workspace, archived ones included, and
every subtask below a bot or task at any depth. An agent's own activity is the latest time one of
its runs started or settled, from `HistoryModule.runActivity`, and never earlier than its creation.
A row's activity is the latest of every agent under it through Agent Base parentage, so hidden
subagents count. A workspace adds its placed agents, resident subtask, and child workspaces; a
project adds its root agents and every workspace cut from it. A row with an open run is active
now. Disk usage is not computed: walking folders is not cheap.

## Deletion

`planCleanupDeletion` closes over ownership from the target. A bot or task takes its agent. An
agent takes every agent below it, the workspace it is the resident subtask of, and the bot or task
it is the conversation of. A workspace takes its child workspaces, its placed agents, and its
resident subtask. A project takes every workspace cut from it and its root agents. Agents and
workspaces are listed descendants first. Folders removed are bot and task folders, workspace
folders, and the folder a project was cloned into; a registered project folder is listed as kept.
The plan refuses to include the acting agent or any agent above it, and the home project.

The confirmation is a hash of the identities, folders, and branches in the plan, not of statuses,
so archiving or a run finishing between preview and confirmation does not invalidate it; an agent
started meanwhile does.

`delete` re-plans inside the deciding transaction and refuses a confirmation that no longer
matches. It then aborts the top of every erased agent tree, archives every still-active project,
workspace (parents first), task, and bot through its owner, and invokes the `cleanup-delete`
durable function with the plan's identities. Everything leaves the active lists when the
transaction commits.

`runCleanupDeletion` performs the removal in checkpointed steps, each retried with backoff until
it holds: erase agents with `AgentSystemRef.erase`, descendants first; purge workspaces, children
first, which waits for each archival to finish; purge tasks and bots; purge projects. Erasing an
agent removes its conversation through History's `agentErasedTransact`, its placements through the
workspaces and projects catalogs, and journals `agent.erased`, which the API announces as
`agent.removed`.
