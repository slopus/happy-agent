# Onboarding learnings

## The agent controls onboarding; the app renders it

The user wants onboarding "controlled on agent side — special handling, possibly a module for
bootstrapping Happy Agent". The desktop used to script, sequence, and word the whole flow and send
Happy's model read-only messages carrying app events. Now the daemon writes every message in
Happy's conversation and runs the work behind each press. The desktop draws the conversation, runs
what only it can (opening the browser, a sheet, a restart), and keeps its own flow only for daemons
without `capabilities.onboarding`.

## A press is never a person message

Pressing an inline action never posts a message and never moves into the person's lane: the button
stays where it is, shown chosen, and Happy answers below. App events reach Happy's model as hidden
context, never as something the person said.

## The agent paces Happy's words, and pacing never blocks

Either the agent paces or the desktop does, never both: the agent does. A scripted message is
stored whole and streamed the way real inference streams: 300–500 ms to the first token, then a
word or a few every 30–60 ms with jitter, so a two-sentence message lands in about a second.
Typing two characters at a time, as first built, read as painfully slow and was replaced. History
and reconnects always see the finished message. Typing out first ran on the conversation's event queue for its whole length, so
a person's send waited up to ten seconds behind it; now any other work queued for the conversation
ends the typing at once.

## Only the bootstrap is scripted, and nothing is redrawn

The user asked for onboarding to be generative and in order: every new step appears at the
bottom, and earlier messages are never redrawn. The welcome, subscriptions, install and sign-in,
and "connected" are scripted; after that Happy's model writes every message from the guide and
does the work with visible tools. Progress that used to rewrite a message in place (the connecting
steps, "discovering…" becoming the proposal) is now a live figure the app draws, or the next
message.

Scripted messages carry no provider or model. The desktop relies on that to replace such a message
whole on every update instead of merging it as streamed provider output.

## Proposals come from Focus, not from Happy's model

Happy's model never writes the proposal table. Focus proposes as a bounded side inference with its
own placement rules; `propose_work` returns the table and stores its rows, and Looks right starts
the stored rows, so a model that changed the table cannot change what starts. Happy's model
introduces the proposal and shows the block as returned.

## Accepted work lands where its preview was

The desktop draws a dashed preview of the proposal after the last sidebar item, rows under their
topics in proposal order. Placement matches it exactly: new topic sections at the end of the
sidebar, in proposal order; a topic that already exists takes its rows at its end. The empty
default headings go at Start onboarding, not at Looks right, because a heading vanishing at accept
time moved everything below it.

## Onboarding proves each requirement once

Completion is a verified provider and a profile with a name and an email, stored as a versioned
marker the fast path reads alone. A provider that breaks later does not reopen onboarding; the
person asks Happy. The optional steps (work, Create, phone) never hold completion back.
