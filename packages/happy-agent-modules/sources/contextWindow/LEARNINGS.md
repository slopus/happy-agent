# Context-window learnings

## Check only while preparing inference

Automatic compaction uses each model's curated threshold. The context-window module checks the
persisted provider measurement at one boundary only: after queued input has joined its active run
and immediately before a possible provider request. It does not request compaction at turn start
or after a response. When the threshold is reached, preparation requests compaction, the settled
context is replaced, and preparation is checked again before the durable inference stage opens.
This ordering keeps the compaction in the accepted message's run without letting a provider
request slip through on the oversized context.
