# Presence learnings

## Presence is a notice in the conversation, not part of the system prompt

The effective presence used to be a line of the system prompt, rebuilt before every inference.
Presence changes while agents work: the person sets it, an agent sets it on request, a temporary
state expires, a schedule starts. Each change rewrote the system prompt under a conversation
already in flight. Claude models with preserved thinking bind each thinking block to the system
prompt it was produced under and rejected the next request with "Invalid signature in thinking
block"; every other model lost its whole prompt cache. The direction given was to move everything
that changes out of the system prompt, because the cache must not be lost.

The module now has no `instructions` hook. It appends a system notice with the same guidance text
before a message or an inference, and the history's store remembers what it was last told. The
same state is said once; a change during work reaches the very next request; a compacted history
is told afresh. A history that heard of a presence is told when it is cleared, and one that never
heard of any is told nothing while none is set.
