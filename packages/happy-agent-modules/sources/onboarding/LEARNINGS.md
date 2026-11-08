# Onboarding learnings

## The daemon runs onboarding; clients draw it

Kirill wanted onboarding controlled on the agent side. The desktop used to script, word, and
sequence the whole flow. Now the daemon writes every message in the Chief of Staff's conversation
and does the work behind each press. Clients draw the conversation, run only what a client can
(opening a page, restarting the daemon), and keep their own flow for daemons without
`capabilities.chatOnboarding`.

## What onboarding says is a recipe, not code

The first chat onboarding hardcoded its words and its order in TypeScript, so Happy Cloud could not
run its own team onboarding without copying the daemon. Kirill asked for recipes as data. The
bootstrap is now a step graph in `recipes/local.json`, and each runtime implements only the effects,
conditions, and variables it offers. The module refuses a recipe that names anything else when it
is constructed, rather than failing at the step that needs it. The JSON Schema generated from
`OnboardingRecipe.ts` is the shared format.

## A press is the person's plain words

The first version stored a press as an `action` block with labels and outcomes. Once chat
onboarding was removed, history needed migration 004 to keep those conversations readable. A
press is now stored as the words on the control, as if typed. The pressed message records the
choice in `actionChoices`. Presses resolve with the client's shared resolver, so a server never
trusts a label or parameter from the request.

## Only the bootstrap is scripted, and nothing is redrawn

Every new step appears at the bottom, and earlier messages are never rewritten. Install and
sign-in progress is a live `data-provider-cli` figure the app draws, not a message edited in place.
There is no scripted "Connected" line: the model's first message opens with it.

## The bot speaks as itself, under its live name

A copy review found the words drifting between "I" and a third-person name, hedging, and cheerful
filler. The bot speaks in the first person, under whatever name the Chief of Staff has now. It
never calls itself Happy; Happy names only the phone app. Messages are direct, with no exclamation
marks, filler, hedging, or em dashes. They make no pricing or quality claims about an AI: the
person's existing subscription is reused, so there is nothing new to pay for.

Every setback offers a way on. After "I'd rather do it myself", doing it for them is offered again
only when it is possible, and never emphasized. `tests/onboarding/localRecipe.test.ts` holds these
rules.

## An older or already-used installation never counts as owed

An installation that was in use before onboarding existed must never be sent through it after an
upgrade. A preview that stored onboarding in an older shape must not break startup either. The
first start with this module therefore decides once. A completion marker, a named profile, or any
message from a person counts as finished. Migration `002-onboarding-recipes` clears a preview's
row so that same check runs again. Clients never read a missing capability as completion.

## A sign-in in the person's own terminal is looked for

Nothing the daemon started reports a sign-in the person runs themselves, and no figure is on
screen to refresh Provider CLIs. The manual step would wait forever. While it waits, the module
checks that assistant every few seconds and stops as soon as the flow moves on.

## Signed in but unusable is not a failed sign-in

A Claude that signed in but has no provider here first came back as `failed`. That showed "That
didn't work" right after a sign-in that worked. Effects now return `unusable`, which the recipe
sends to "I couldn't switch to Claude", naming the cause.

## A failed first answer offers the other AIs chosen

With two AIs chosen, the person could not fall back to the second when the first failed to
answer. The failure step repeats the routes table with the failed one unticked and the others still
ticked.

## The composer says why it is locked

During the bootstrap a disabled composer still read "Message…" and looked open. The recipe gives
the bootstrap its own placeholder ("Choose an answer above"). The guided part keeps "Or just tell
me in your own words…".

## Onboarding's own tools are loaded, never searched for

`save_profile`, `set_default_model`, and `finish_onboarding` reach the model only while it guides,
and it calls them as soon as the person answers. They are `defer: false` with no search keywords. A
deferred copy would make the model search for a tool it needs at that moment.

## A step types at once, even while it is still working out what to say

The providers step must detect routes before it can write its table, and on a Mac the sign-in
checks behind that can take seconds; the conversation sat silent after Start. A scripted message's
run now starts, and is announced, before its words are rendered. The API then counts the time spent
rendering toward the usual 300–500 ms before the first words, so a fast step looks the same as
before.

## The routes table ticks what will actually be used

With `CLAUDE_CODE_OAUTH_TOKEN` set, the table ticked the Claude Code sign-in while the token's own
row said it was used instead. The provider routes now leave a replaced route unticked with its own
explanation, the token row reads "Token" rather than "API key", a key for a built-in AI is named as
that AI, and two ticked routes to one provider make a single connection.
