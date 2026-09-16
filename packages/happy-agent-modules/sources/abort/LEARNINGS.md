# Abort learnings

## Commit publishes stop signals, not a process-exit wait

Waiting for strict service teardown inside an after-commit observer held Agent Base's shared
database queue. Archive progress and unrelated reads could then stall behind a stopped service.
Abort now releases every signal immediately outside temporary database ownership, while Compute
keeps cleanup on its independently owned process context. The service runtime and filesystem
removal barriers retain responsibility for confirming teardown. Aborting never claims that the
service or sandbox has already exited, and failure never authorizes deleting its workspace.
