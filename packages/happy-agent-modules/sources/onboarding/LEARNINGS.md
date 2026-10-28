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
stored whole and announced at about 300 words a minute, so history and reconnects always see the
finished message. Typing out first ran on the conversation's event queue for its whole length, so
a person's send waited up to ten seconds behind it; now any other work queued for the conversation
ends the typing at once.

## Proposals come from Focus, not from Happy's model

Happy's model never writes the proposal table. Focus proposes as a bounded side inference with its
own placement rules, and the module writes the table as Happy's message, so the rows, topics, and
first messages the person ticks are exactly what Looks right starts. Happy's model only asks for a
proposal (`propose_work`) and introduces it in one sentence.

## Onboarding proves each requirement once

Completion is a verified provider and a profile with a name and an email, stored as a versioned
marker the fast path reads alone. A provider that breaks later does not reopen onboarding; the
person asks Happy. The optional steps (work, New, phone) never hold completion back.
