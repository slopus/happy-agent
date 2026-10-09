# Native provider learnings

Recorded backend responses can carry reasoning token usage independently of
their visible answer. The native decoder dropped that optional value even
though the permission review transcript already permits it. Responses and Chat
Completions now retain their reported reasoning detail in native usage; the
original input, output, cache and total values remain unchanged. Reasoning is a
subset of output, not an additional token total. Old stored usage decodes with
the field absent and serializes to its original shape. A recorded Grok response
checks this through the real HTTP stream and terminal outcome.
