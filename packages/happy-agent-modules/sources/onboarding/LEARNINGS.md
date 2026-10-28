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

## Onboarding proves each requirement once

Completion is a verified provider and a profile with a name and an email, stored as a versioned
marker the fast path reads alone. A provider that breaks later does not reopen onboarding; the
person asks Happy. The optional steps (work, New, phone) never hold completion back.
