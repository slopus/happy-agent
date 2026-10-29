# Cleanup — learnings

## Search is real ranking, not a listing

The first version listed stale items by last activity only. The request was a search modeled on
history search, so rows are ranked with BM25 over their cheap text. No BM25 history search existed
to reuse, so the ranking is the shared `utils/rankBm25` helper. An empty query still lists by
recency or staleness, because "what has nobody touched" is the most common cleanup question.

## Last activity rolls up through every descendant

A bot whose own conversation was quiet for months can still have a subtask's hidden subagent
working yesterday. Activity is therefore the latest run of any agent under the row, through Agent
Base parentage, read from History's run lifecycle rows in one grouped query rather than from
messages. An open run counts as activity now.

## Deletion means everything, conversations included

People asked that deletion remove conversations as well as folders, and that the admin decide
whether active work goes too. Deletion therefore erases agents with their whole history and does
not require archiving first. To keep it safe, every deletion is previewed, confirmed with a code
naming the exact set, stops every agent involved in the deciding transaction, and refuses to reach
the admin itself or anything it runs inside.

## Admins need to know who owns a folder

Folders outlive the records that made them, and an admin cleaning up has to tell a live checkout
from a leftover. `find_folder_owners` answers what owns or works in a path and whether it is
alive; `find_orphan_folders` lists what nothing owns. Orphans are only reported: they belong to no
record, so no tool deletes them.

## Erasure must not leave retries chasing a missing agent

Archive work retries stopping each agent until it succeeds. Erasing an agent while such a retry
was pending made the retry fail forever. Aborting an agent that no longer exists is now a no-op in
the abort module, and the workspace and project catalogs drop an erased agent's placement in the
erasing transaction, so their later archive passes never see it.
