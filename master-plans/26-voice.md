# Master plan 26: voice

## Big picture

Voice is a spoken conversation with one desktop window. GPT-Live carries the
audio. It has no direct tools of its own, so it hands every request to Voice
through client delegation.

Voice is one agent per person, a long-running subtask of Happy: created through
`SubtasksModule.create`, unreported, with a conversation of its own, and
recognised by an agent ID stored in the person's bookkeeping. The same Voice serves every call. There is never a new
Voice or a new controller per call, and never more than one per person. It runs
GPT-6.1 Sol at low effort by default; the existing voice settings may override
the provider, model, effort and fast mode.

Voice works only with the agents on the machine where the daemon runs. Remote
connections and peers are out of scope.

## What Voice can do

Voice lists the sidebar and reads any conversation's public user and assistant
text on this machine, on demand. It reads the sidebar but never writes it.

Voice can do everything the person does by clicking in the window of the
active call: open and navigate, create tasks with drafts, stage messages,
append to drafts, and change models. Staging is not sending; a person still
presses Send.

## One queue, never busy

Requests reach Voice one at a time, in the order they arrived, across every
call of that person. A request that arrives while Voice is working waits in the
queue. Voice never refuses it as busy, and the desktop has at most one action
outstanding.

## Context

Both Voice and GPT-Live get the person's current sidebar, and get it again
only when the sidebar itself changes. Nothing else is pushed: no loop started
or settled, no message briefs, no conversation status updates, and no desktop
AppState. Voice no longer tells the person on its own that work finished; it
looks things up when asked.

GPT-Live receives only the sidebar outline and Voice's spoken outcomes, as
text. Tool calls and tool results never reach GPT-Live. Voice's own
conversation keeps its history across calls, like any agent's, and ordinary
compaction bounds it.

## Names, not IDs

Speech uses names, such as the names of sessions and bots. IDs stay internal
and are used for targeting.

## Prompt and effort

The voice model's system prompt follows OpenAI's example prompt for GPT-Live.
GPT-Live documents no reasoning-effort setting for the voice model, so effort
is set only on Voice.

## Not now

- The Decisions API is not used.
- An OpenAI API key will come later. Until then, voice uses the existing Codex
  account and adds no new billing.
- Resetting Voice's context on a schedule.

## Order and criteria

1. Make Voice the person's long-running subtask of Happy, serving every call
   through one queue.
2. Give Voice its read-only sidebar, its conversation reads, and the full set
   of desktop actions for the active call's window.
3. Push the sidebar outline to Voice and GPT-Live at call start and only when
   the sidebar changes, and stop every other background push.
4. Verify with real calls in which Voice calls tools. Opus 5.5 reviews the
   change, cuts and improves it, and has the final say.

This plan is done when:

- every person has exactly one Voice, it persists across calls, and follow-ups
  are queued instead of refused as busy;
- Voice reads the sidebar and conversations on this machine, never writes the
  sidebar, and can do everything the person does by clicking;
- from the start of a call, voice knows the sidebar, and nothing reaches
  GPT-Live in the background except a changed sidebar;
- speech refers to sessions and bots by name;
- a real call in which Voice calls tools in two requests, and a second call in
  which Voice still has the first call's conversation, have passed, and Opus
  5.5 has signed off.
