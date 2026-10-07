# Master plan 3: workspaces and Git

This plan is about Git in general, not only worktrees.

## Workspaces

A workspace is a folder. If it is a Git folder, the workspace is a worktree.

A worktree must always be a branch. It is created as a branch: make the Git
copy, then create a branch and give it some name.

Auto-generated branch names determine the folder we use. A branch name starts
with a three-digit prefix, a dash, and some workspace name; by default that
name is probably just "workspace".

The branch name is mandatory. A lot of software now depends on it: tools look
at the branch name and, for example, launch a server on a domain tied to that
name.

We must track that the branch exists and when it changes — that is already
known from the previous protocol.

## Naming after the first message

After the first message in a chat we generate the session title. We should
generate the workspace name, the chat name, and the branch name — probably
best generated separately.

On the first message we synchronously run inference and get a kebab-case name,
then rename the whole folder. The three-digit NNN prefix is kept; we change
only the part after it. Only after that do we launch the real inference
— the actual agent for the session and so on. Renaming later would not work,
because agents would already be working in the folder.

The model for this must be chosen cleverly: take the cheapest model from the
same provider, build some model priority, and just call inference for it.
Today we do this with the same model as the session, which is probably not
great.

If the user has already renamed the worktree by that point, we must not rename
it ourselves. Same rule wider: if someone renamed the session or the
workspace, we no longer assign a name automatically — someone already did.

## When there is no Git

If there is no Git and we cannot make a worktree, the good idea is to simply
copy the whole folder into the workspace.

The delete behavior differs between the two: with a worktree we can delete the
whole folder, while with a copy, archiving leaves it behind. These should be
two separate local settings: keep or not keep worktrees, and keep or not keep
the copied folders on archive.

You make a root template folder and then just clone it everywhere — that would
be genuinely useful to many people.

## Archiving

Archiving a workspace is an immediate, irreversible logical action. The moment
the user chooses it, stop the workspace and everything running inside it, mark
it for archival, and remove it from the active workspace list. It must not
reappear during a refresh, reconnect, or background state update.

Deleting the folder is background cleanup, not the archival decision. Archival
never fails and is never rolled back because cleanup failed. If Rig cannot
remove something, keep the workspace logically archived and write the cleanup
failure to the log.

Workspace creation has the same one-entity rule: the local result, request
response, live event, refresh, and reconnect all reconcile to one workspace.
Creating one workspace must never produce two sidebar entries.

## Tracking changes

The changed-file list and deltas for the current branch cover every change
made since the branch diverged from the default branch. The baseline is the
first of these that exists: the merge base with `origin/<default branch>`;
when the remote has none, the merge base with the local default branch;
otherwise HEAD itself (uncommitted work only); and for a repository with no
commits, the empty tree, so every file shows as new. A remote baseline always
wins when it exists, so a moved local `main` never replaces it.

With Git we must track file changes line by line. We must detect file types —
detect binary files versus text, and detect and not show large files. The file
extension is probably even sufficient for this.

If we display a delta of binary files such as images, we must store both the
old and the new versions so we can show the old and the new image.

All of this must be available through the API.

The main problem here is watching the files — that can be quite nontrivial.
The goal is not to eat resources and not to get in the user's way on their
Mac, and for all of it to work on Linux. On Linux the expected use is a
server, possibly in Docker, where there may be some limitations.
