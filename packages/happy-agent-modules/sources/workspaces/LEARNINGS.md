# Workspaces — learnings

Feedback and decisions gathered while building this module.

## Setup failure does not erase a valid checkout

Workspace setup commands run only after the worktree or copied folder exists. An install failure
therefore means the project is not fully prepared, not that workspace creation failed. The module
logs the setup error and marks the workspace ready so the person or agent can inspect and repair it.
Failures that prevent the folder or checkout from existing remain initialization failures, and
archive or shutdown cancellation still stops setup without marking the workspace ready.
