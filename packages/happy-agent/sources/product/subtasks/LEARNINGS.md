# Native subtasks

A workspace-bound task and its workspace are one archival decision. Core metadata hooks cancel initial delivery, abort the real descendant tree, and persist cleanup intent in the caller's transaction. The workspace's transactional listener marks its resident subtask archived in that same transaction. Each direction skips the already-decided counterpart, so repetition cannot loop. Shared-folder tasks never archive the shared folder.

Subtask archival is final. The generic Core metadata hook rejects restoration and rolls back the caller's transaction, including changes made by earlier hooks. Cleanup completes only after the actual process and service owners confirm shutdown.

Queued user input may precede workspace provisioning. The generic Core before-loop hook waits for real domain readiness before queue acceptance or inference; it follows workspace-bound ancestors so shared-folder descendants also wait. Durable initial delivery rereads the same domain state and uses the original stable opening message identity.

Only the bot → subtask → subtask chain can create interactive tasks. Hidden intermediaries cannot extend that chain. Manually ordered siblings retain decimal-fraction keys, including archived siblings; explicit reorder repairs tied or unkeyed active siblings before recording the parent's updated list.
