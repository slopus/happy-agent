# Master plan 26: voice

## Big picture

Voice is per agent, like mobile: the agent whose phone is pressed hosts the
call and acts only on its own work. GPT-Live carries the audio. It has no direct
tools of its own, so it answers from its context when it can and hands every
other request to Voice through client delegation.

Voice is one agent per person, a long-running subtask of Happy: created through
`SubtasksModule.create`, unreported, with a conversation of its own, and
recognised by an agent ID stored in the person's bookkeeping. The same Voice serves every call. There is never a new
Voice or a new controller per call, and never more than one per person. It runs
GPT-6.2 Sol at low effort by default, at Ultrafast where the account's plan
allows it and otherwise the fastest speed the plan allows. The voice settings
may override the provider, model, effort and speed (Regular, Fast or
Ultrafast, as the model picker names them).

Voice works only with the agents on the machine where the daemon runs. Remote
connections and peers are out of scope.

## What Voice can do

Voice lists the sidebar and reads any conversation's public user and assistant
text on this machine, on demand. It reads the sidebar but never writes it.

Voice can do everything the person does by clicking in the window of the
active call: open and navigate, create tasks with drafts, send messages,
append to drafts, and change models. Send really sends, like mobile, and the
screen stays where it is.

## One queue, never busy

Requests reach Voice one at a time, in the order they arrived, across every
call of that person. A request that arrives while Voice is working waits in the
queue. Voice never refuses it as busy, and the desktop has at most one action
outstanding.

## Context

Do what mobile does for most context management. GPT-Live's first context
holds the time the call started on the person's clock, the recap of recent
calls, the conversation on screen with its last turns and their times, and the
directory of conversations with references, status and last activity. During
the call it gets mobile's silent updates: directory changes, the focus with its
unseen turns, and replies and errors from the last four conversations visited
or messaged, each piece once, never replayed, never prompting speech. Voice
gets the same context, so it skips list and read steps.

The voice model takes the cheapest path that answers: from its context
directly, otherwise it says "One moment" at once and hands off to Voice.
Tool calls and tool results never reach GPT-Live. Voice's own conversation
keeps its history across calls, like any agent's, and ordinary compaction
bounds it.

## The call

Happy speaks first: it says hello when the call connects. The person can mute.
There is no silence warning. On disconnect the desktop plays a sound.

## Names, not IDs

Speech uses names, such as the names of sessions and bots. IDs stay internal
and are used for targeting.

## Prompt and effort

The voice model's system prompt aligns with mobile's prompt, keeping only the
differences GPT-Live forces, under OpenAI's required GPT-Live headings.
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
3. Give GPT-Live and Voice mobile's context: the first context and its silent
   updates.
4. Verify with real calls in which Voice calls tools. Opus 5.5 reviews the
   change, cuts and improves it, and has the final say.

This plan is done when:

- every person has exactly one Voice, it persists across calls, and follow-ups
  are queued instead of refused as busy;
- Voice reads the sidebar and conversations on this machine, never writes the
  sidebar, and can do everything the person does by clicking;
- from the start of a call, voice knows the time, the recap, the conversation
  on screen and the directory with status and activity, and during the call
  only silent context updates reach it in the background;
- a send really sends and leaves the screen where it is;
- speech refers to sessions and bots by name;
- a real call in which Voice calls tools in two requests, and a second call in
  which Voice still has the first call's conversation, have passed, and Opus
  5.5 has signed off.
