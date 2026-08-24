# Workflow learnings

## Daemon restart recovery

Agent Base restores active workflow collaborators before module `afterStart` runs. Workflow
startup must restore every durable running script and reattach each unanswered external call to
its persisted collaborator ID. Marking the run paused or creating a replacement agent loses the
live restoration edge and pays for the same call twice.

Register the recovered call's in-memory waiter before rereading its durable result. The restored
agent may settle while workflow startup is still rebuilding the script; the post-registration
read and settlement callback together cover both sides of that race without polling.
