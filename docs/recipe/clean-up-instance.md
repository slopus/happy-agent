# Clean up an installation

Use this recipe when the user wants to tidy an installation that has piled up old bots, tasks,
subtasks, projects, workspaces, and folders: find what is stale, decide with them what goes, and
remove it. Archiving hides something and keeps everything about it. Deleting removes it for good,
and **that includes every conversation**. Nothing deleted can be brought back.

Only an active admin bot, such as the Chief of Staff, has the cleanup tools: `search_instance`,
`find_folder_owners`, `find_orphan_folders`, `preview_delete`, and `delete_permanently`. They are
deferred, so find them with tool search. There is no HTTP route for them. Execute the recipe end
to end, as the [recipe rules](README.md) describe.

## 1. Agree the scope

Ask only what the user has not already said:

- **What counts as stale.** For example, no activity for 30 days, or everything archived before a
  date.
- **Archive or delete.** Archiving is the default. Delete only what the user asks to delete, or
  what they approve from your list in step 3. The user can also ask for active items to be
  deleted; those need no archiving first.
- **What must stay.** Bots, projects, or folders they want left alone whatever their activity.

## 2. Find stale items

Call `search_instance`. Every row shows its kind, ID, status, when it was created, and its last
activity. Last activity rolls up from everything under the row: a bot or task includes its
subtasks at any depth and their hidden subagents, a workspace includes its agents and child
workspaces, and a project includes its workspaces and root agents. A row that is running now
counts as active at this moment. Rows also show the owner of tasks, child counts, the folder, and a
workspace's branch.

- Stalest first: `{ "sort": "stale", "inactiveSince": "2026-09-01T00:00:00Z" }`.
- Only archived leftovers: `{ "status": "archived", "sort": "stale" }`.
- One kind: `{ "kinds": ["workspace"], "inactiveSince": "…" }`.
- By name, folder, branch, username, or parent: `{ "query": "payments api" }`, ranked by
  relevance.
- One person's tasks: `{ "kinds": ["task", "subtask"], "ownerUserId": "…" }`.

An empty query lists everything by recency. Follow `nextCursor` until there is none, so nothing
is missed.

## 3. Review with the user

Show the candidates as a short list: name, kind, status, last activity, folder, and what sits
under each. Group subtasks under their task or bot and workspaces under their project, because
deleting a parent deletes everything under it.

When you are not sure what a folder is or whether something still uses it, call
`find_folder_owners` with its absolute path. It lists the bots, tasks, subtasks, projects, and
workspaces whose folder it is, that hold it, or that lie inside it, and every agent working there,
each marked running, idle, or archived. Running or recently idle work should not be deleted without
the user saying so for that item.

Get an explicit decision for each item: keep, archive, or delete.

## 4. Archive what should only be archived

Archive through each item's own archive operation, the same as the person would: the bot, task,
project, and workspace archive routes in [Drive Happy Agent over its REST API](happy-rest-api.md),
or `archive_workspace` for a workspace you can reach. A subtask is archived by its coordinator with
`archive_subtask`, so ask that agent, or archive the subtask's workspace, which archives it too.
Archived items keep their history, and bots, tasks, and agents can be unarchived.

## 5. Delete, one item at a time

The order matters only for what you preview: deleting a parent takes everything under it, so
preview the outermost item the user chose and skip the children it already covers. Delete
subtasks and workspaces on their own only when their parent stays.

1. Call `preview_delete` with the item's kind and ID. Nothing changes. The preview lists
   everything the deletion takes with it: the item and its subtasks, workspaces, and projects,
   every agent whose conversation is erased (running ones flagged), every folder and Git branch
   removed, and any project folder that is kept because a person registered it.
2. Show the preview to the user unless they already approved exactly this list. If it is larger
   than they expected, stop and ask.
3. Call `delete_permanently` with the same kind and ID and the preview's `confirmation` code. In
   Auto it is reviewed against what the user asked for.

`delete_permanently` is refused when:

- the confirmation does not match the current preview, because something was added or removed
  since. Preview again and review the new list. If a running task keeps starting new subagents,
  archive it first, which stops it, and then preview again;
- the deletion would reach you or anything you run inside;
- the target is the home project.

Confirming stops every agent involved at once and archives anything still active, so it leaves
every list immediately. The removal then finishes in the background and survives a restart: agents
and their conversations are erased first, then workspaces and their worktrees and branches, then
tasks and bots with their folders, and projects last. A folder Happy Agent cloned a project into
is removed; a folder a person registered as a project is never touched.

## 6. Find leftover folders

Call `find_orphan_folders`. It scans the bots, tasks, workspaces, and projects folders on this
machine, and on the default runner when runners are enabled, and lists every folder that no bot,
task, subtask, project, workspace, or agent names. Check each with `find_folder_owners` before
doing anything. These folders belong to nothing, so no tool deletes them: show them to the user
and remove only the ones they approve, with an ordinary shell command.

## 7. Verify

- `search_instance` with the deleted names or IDs returns nothing for them.
- `find_folder_owners` on each removed folder reports that nothing owns it, and the folder is gone
  from disk. Removal is background work: if a row or folder is still there, wait a little and
  check again before reporting a failure.
- `find_orphan_folders` shows no new leftovers from this cleanup.

Report what was archived, what was deleted with how many conversations, which folders and branches
went, which registered project folders were kept, and anything the user chose to keep.
