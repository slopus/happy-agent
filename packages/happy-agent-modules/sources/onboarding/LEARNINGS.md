# Onboarding learnings

## The agent controls onboarding; the app renders it

The user wants onboarding "controlled on agent side — special handling, possibly a module for
bootstrapping Happy Agent". The desktop used to script, sequence, and word the whole flow and send
Happy's model read-only messages carrying app events. Now the daemon writes every message in
Happy's conversation and runs the work behind each press. The desktop draws the conversation, runs
what only it can (opening the browser, a sheet, a restart), and keeps its own flow only for daemons
without `capabilities.onboarding`.

## A press is the person's own message

A press was first a separate route that recorded the choice and told Happy's model through a
hidden onboarding event, so the model read the person's choices as the app's narration and a
second input path existed beside sending. Now a press is an action message through the ordinary
send queue: one transaction records the choice on the pressed message, does the work, and stores
what it did as the action block's `outcome`. The model reads `[Pressed "Label" in your message]`
and the outcome as an ordinary person turn. During the bootstrap the same message is answered by
the scripted reply instead of a model. Clients draw no bubble for it: the control shows chosen in
place. Hidden events remain only for what the person did not do, such as a provider CLI signing in
or a phone pairing.

Only the newest offer of an action is live. A model that repeats a step after an interruption
leaves an older copy on screen; pressing it is a conflict, so no step runs twice. A control a
model wrote wrong (an unknown action ID or parameter, or a step that is over) is refused with the
message as it stands, and the person recovers by typing.

Codes and secrets never travel in a message: the provider CLI figure calls its own sign-in code
and cancel routes, and a sheet such as the API key sheet stays in the app.

## Happy speaks as itself, plainly

A copy review found the bootstrap and the guide drifting between "I" and a third-person "Happy" or
"Happy Agent", hedging ("I'd look"), and cheerful filler. Happy now speaks in the first person
everywhere; "Happy" names only the phone app. Messages are direct and concrete, with no exclamation
marks, filler, hedging, or em dashes. Work is organized or placed under topics, never "filed".
Happy makes no pricing or quality claims about an AI: it reuses the subscription the person already
pays for, so there's nothing new to pay for, and suggests the one they already use.

Every setback offers a way on: a failed install offers Try again, doing it themselves, or another
AI; after "I'd rather do it myself", doing it for them is offered again only when it is possible and
never emphasized; an AI that can't be used names the cause and offers its sign-in. The model is
never left to guess the platform: the guide is built with this computer's shortcut for Create.

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
