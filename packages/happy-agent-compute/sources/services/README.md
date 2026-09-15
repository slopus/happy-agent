# Native service sessions

This optional compute capability fixes each execution's sandbox at launch and shares the shell's
native process I/O machinery. It does not implement the product's HTTP authorization or tools.

```text
controller → validate inputs, delegation, permissions → private policy file
                                                      ↓
                                   native supervisor → isolated command
                                                      ↕
                      independent output readers / input / authenticated bridge
                                                      ↓
                              native exit → teardown proof → remove controls
```

Startup admission comes from private native control data. Teardown verifies stable native process
identities, the empty resource group, and closed bridge before removing an execution directory.
Restart reconciliation never replays a command. The selected inputs remain live and read-only;
named-pipe IPC in those trees is an accepted boundary edge, while input device files are denied.

Active executions retain their managed-process handles until completion or independent teardown
proof. Reconciliation of the exact execution also releases retained process-group ownership and
capacity after a prior completion failure; a failed disposal may be retried, with admission still
closed. Service output uses `readOutputDelta`, avoiding full-capture copies on every reader poll.
