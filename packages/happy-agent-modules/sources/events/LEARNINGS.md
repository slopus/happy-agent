# Events learnings

## Oversized tool arguments belong in History, not repeated replay projections

An explicit tool request can contain arguments larger than the event journal permits. Repeating
them in raw events, tool presentations, and active-run partials can prevent dispatch from committing
before Agent Base can record an ordinary failed tool result. Bound argument copies in completed
tool-call and dispatch events with a readable reference to the original History message. Keep call
and run identities unchanged and leave the exact input in canonical History and execution context.
