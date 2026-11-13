# Stable prompt

`StablePromptModule` keeps one system prompt for the life of a history and appends whatever changes
afterwards to the conversation.

```ts
const stablePrompt = new StablePromptModule(systemPrompt);
```

It takes the system-prompt module and nothing else, and it must be the last module in the list.

## Why the prompt does not change

Every module's instructions are rebuilt before every request, and many describe things that change:
the permission mode, the model in force, what is installed, who the agent is. Two things go wrong
when the provider-facing prompt follows them.

- A provider caches the system prompt together with everything after it. A changed prompt throws
  the whole conversation's cache away.
- Claude models with preserved thinking (Fable 5.2, Mythos 5.2, Fable 5.1, Opus 5.5, Sonnet 5.5,
  Haiku 5.5) bind each thinking block to the system prompt, the tools, and the messages before it.
  A request that replays a thinking block under a different prompt is rejected with `Invalid
signature in thinking block`, and the conversation cannot continue because its stored history
  still holds that block.

## What it does

```text
first request of a history     every later request               first request after a message
──────────────────────────     ──────────────────────────         ─────────────────────────────
instructions as built now  →   the stored prompt, verbatim         instructions as built now
stored as the prompt           (inference and compaction)          compared with what was told
                                                                   → one "# Instructions changed"
                                                                     notice with the lines that differ
```

- **Freeze.** `overrideInstructions` is the last word on the provider-facing prompt. The first
  prompt a history is sent is stored in that history's own store (`historyKV`) and returned for
  every later inference and compaction, across turns and daemon restarts.
- **Capture again only where history is rebuilt.** Agent Base empties the history store on a
  completed compaction, an incompatible model, provider, or profile change, and a context
  overflow reset. Nothing earlier is replayed after any of them, so the next request takes the
  current instructions as its prompt. A compatible model change keeps the history, so it keeps
  the prompt too and the new model line arrives as a change.
- **Append changes.** Each accepted message marks the history as due. The next request compares
  the instructions as built now with what the history was last told, through its prompt or an
  earlier notice, and appends one system notice with the lines that differ. The notice lands
  directly after the message it arrived with.
- **Never mid-turn.** A change that lands while the agent works waits for the next message, and a
  change never starts a turn. Several changes between two messages are one notice of the outcome;
  a change that was undone says nothing.

The notice quotes what stopped applying and what applies now:

```text
# Instructions changed
Your instructions changed after this conversation began. The system prompt stays as it was first
sent, so it still shows the earlier text; this notice supersedes it. ...

<removed>
You are working in Auto mode. ...
</removed>
<added>
You are working in Read only mode. ...
</added>
```

Changes are found line by line over the final prompt, ignoring blank lines. A line is the unit
because instructions are written one rule to a line, and the final prompt is what is compared
because it is exactly what the model was sent, whichever module or override wrote it. A notice is
bounded at `MAX_INSTRUCTIONS_CHANGE_CHARACTERS`; past that it says that more changed than is shown.

AGENTS.md is left out of the comparison. The system-prompt module already delivers the current
documents again in full whenever they change, so this module asks it for that part of the prompt
(`agentsMdDocumentsInPrompt`) and ignores it.

## What still belongs to each module

A module that knows a better moment or a better wording keeps its own notice and stays out of the
instructions altogether: presence tells a working agent the moment it changes, collaborators are
listed again after compaction, and task and bot names arrive as a name notice. Anything else a
module writes into its instructions is covered here without that module doing anything.

Tools are not covered. The provider-facing tool list still follows what is offered now, so a tool
that appears or disappears still changes what precedes earlier thinking blocks.

## Storage and concurrency

Three values live in the history store and vanish with the history: the prompt, the instructions
last told, and the due mark. The instructions resolved for a request being built are held in
memory from the override to the notification hook of that same request, and dropped when the run
settles. There are no tools, no database tables, and no background work.
