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

## Every step says what it unlocks before it asks

Kirill found the copy flat: steps asked for things without saying why. He wants the bot to be a
good storyteller that sells each step without being obnoxious. A design pass then wrote the final
script for every setup, and `recipes/local.json` holds its local part word for word. Each message
opens with one or two plain sentences on what the step unlocks, then asks one thing; it holds at
most one set of controls, after any figure and last. The guide restates every rule, because a model
drops any rule its guide does not repeat.

There is no separate welcome step with a Start button: the first step introduces the Chief of Staff
and asks for the AI in the same message, so the person makes a real choice on the first screen.

## The bot speaks as itself, and recommends no AI

A copy review found the words drifting between "I" and a third-person name, hedging, and cheerful
filler. The bot speaks in the first person: with the default name it is "your Chief of Staff",
never "I'm Chief of Staff". It never calls itself Happy; Happy names only the phone app. Messages
have no exclamation marks, em dashes, emoji, filler, hype, hedging, or sign-offs, and make no
pricing or quality claims about an AI: the person's existing subscription is reused, so there is
nothing new to pay for. A menu that picks an AI emphasizes none of them, so no vendor is
recommended over another; elsewhere at most one control, the recommended next step, is emphasized.

Every setback says what happened and offers a way on in the same message. After "I'll do it
myself", doing it for them is offered again only when it is possible, and never emphasized.
`tests/onboarding/localRecipe.test.ts` holds these rules.

## The profile is said, not asked

Asking "is this you?" about the name and email already in Git settings was a stop that decided
nothing. The model saves the profile it is given with `save_profile` first, then says what it put
there, where it came from, and that it can be changed. It asks only when there is none.

## The first task is suggested from evidence, after consent

A first project offered as a list of folders left the person to work out what to do with it. With
the person's consent, the model reads only Git metadata of their recent projects (uncommitted
changes, recent commits and branches, TODOs added lately) and suggests up to three concrete tasks,
each with the evidence behind it, never a generic one. Picking one starts it, and the phone step
follows with that running task as the reason to get the app. Onboarding finishes at the handover
when that task finishes, or when the person says they are done. These are rules in the guide and
the first-project recipe, not code: the model decides.

On a fresh computer discovery finds nothing, and the round 3 guide then only asked what they were
working on, with "I'll name a folder" and "Skip for now"; in a recording onboarding went straight
past the first task and finished after the phone step. Real work starting early is the point, so
an empty discovery still leads to a first task: the model asks what they want done in a line of
their own words and offers concrete starts that fit the machine ("Clone a repo" when Git is
installed, "Start a new project", "I'll name a folder"), sets the project up with `clone_project`
or a new folder and `create_project`, and starts it with `start_first_task`. Both project tools
are in the recipe's `tools`, loaded while the model guides, and the guide's list of onboarding
tools names exactly the recipe's `tools`.

Both project tools return before setup finishes, and the `list_projects` check their descriptions
suggest is not loaded during onboarding, so the task's opening message says setup may still be
running: the task waits for the project and reports a failed setup, which reaches the person as
the stopped beat. A new folder has no Git history, so its task works in a copy of the folder, not
on a fresh branch, and the Started beat says so.
A clone with no work named gets a concrete one: getting it to build and its tests to run. Clone
addresses can carry tokens, so the local guide carries the secrets rule too: never repeat one, and
ask for the address without it.

A handover that said "The files are in their own copy of the project, not in ~/weather-today,
which is still empty" confused a first-time person. The guide now says in one plain sentence where
the work is and how it reaches their folder: open the task to look it over, or tell it to merge the
change, or to copy the files over. It never explains copies, checkouts or commits. No action
merges or applies a task's work yet, so the handover offers no button for it; when the person asks
the Chief of Staff instead, it passes that to the task with `send_agent_message`, which the recipe
loads.

## Recent work is read by the daemon, never through the shell

The discovery helper the first-project recipe runs cannot see `~/.claude` or `~/.codex` from
Happy's shell sandbox, which hides them, so onboarding had the model run it, ask for a reviewed run
outside the sandbox, hunt for a newer Node when the login shell's was too old, and run Git per
project: 25 to 71 seconds of shell work and reviews before the first-task menu, on a home folder
with no history at all. A person's first minutes must not include a sandbox escape.

`find_recent_projects`, one of the onboarding tools, does it in the daemon instead. It reads only
the first lines of the newest Claude Code and Codex session logs for the `cwd` they record, keeps
at most five existing folders (never the home folder, a filesystem root, or Happy's own folders),
and reads each one's Git metadata through `GitModule.readOnly`, the hardened read-only scanner.
History gets one second and Git two more; what is left unread is said. It returns names, paths,
dates, branches and commit subjects, never file contents or conversation text, takes only an
optional folder the person named, and needs no review. With no history it answers in tens of
milliseconds. The guide tells the model to call it and never to read history, run the shell, or
ask to leave the sandbox for this, and no longer sends it to read the recipe file at all.

## An older or already-used installation never counts as owed

An installation that was in use before onboarding existed must never be sent through it after an
upgrade. A preview that stored onboarding in an older shape must not break startup either. The
first `flow/start` therefore decides once. A completion marker, a named profile, or any message
from a person counts as finished. Migration `002-onboarding-recipes` clears a preview's row so
that same check runs again. Clients never read a missing capability as completion.

## The first task is a new top-level task

In Kirill's recordings the Chief of Staff started the first task as a sub-agent under itself: the
guide said "start one agent", and the tools at hand for that were `create_subtask` and
`create_agent`, while `create_task` was deferred and had to be searched for. A first task must be
its own conversation in the person's sidebar, which outlives onboarding and checks out the project
in subtasks of its own. Onboarding now offers `start_first_task`, loaded like its other tools, which
creates a top-level task through the Tasks module, and the guide and the first-project recipe say to
use it and never `create_subtask` or `create_agent` for this.

## Advertising onboarding changes nothing until a client starts it

Kirill keeps chat onboarding behind an experimental client flag in production, so a client with
the flag off, or one that predates it, must see exactly the classic behavior. The decision above
used to be stored when the daemon first started, which made `completed` true for an installation
with a named profile but no completion marker even for clients that never asked for chat
onboarding. Nothing is stored now until the first `flow/start`: before it, the flow reads as not
started with a stable version, and every hook does nothing. The decision is made at that start
instead, so an installation used with the flag off is never sent through onboarding when the flag
is turned on later.

## Typed answers stay in the script, and the device is said once

On a team server, typing a name at the first step ended the scripted part (`typing: "handoff"`), so
the model took over before anything was set up. A step can now take a typed answer: text that fits
is handled exactly like a press and keeps the script going, and only text that does not fit
follows the typing rule. Phones need some steps worded differently, so a start may name the device;
only the start that began onboarding counts, so someone who starts on a phone and continues on a
computer keeps the wording already sent. Both are part of the shared recipe format, so Happy Cloud
implements the same rules.

## A sign-in in the person's own terminal is looked for

Nothing the daemon started reports a sign-in the person runs themselves, and no figure is on
screen to refresh Provider CLIs. The manual step would wait forever. While it waits, the module
checks that assistant every few seconds and stops as soon as the flow moves on.

## Signed in but unusable is not a failed sign-in

A Claude that signed in but has no provider here first came back as `failed`. That showed "That
didn't work" right after a sign-in that worked. Effects now return `unusable`, which the recipe
sends to "I couldn't put Claude to work yet", naming the cause.

## A failed first answer offers the other AIs chosen

With two AIs chosen, the person could not fall back to the second when the first failed to
answer. The failure step repeats the routes table with the failed one unticked and the others still
ticked.

## The composer says why it is locked

During the bootstrap a disabled composer still read "Message…" and looked open. The recipe gives
the bootstrap its own placeholder ("Choose an answer above"). The guided part keeps "Or just tell
me in your own words…".

## The flow says when the person can skip

Locally nothing works before an AI is connected, so the desktop must not offer "Skip setup" during
the script, while team flows can offer it at once. Reading `step` for that would make clients
depend on the recipe's steps. The flow carries `skippable` instead: `false` during the bootstrap
(including after a failed hand-off sends it back), `true` once the model has the conversation or
onboarding finished.

## The tools onboarding needs are loaded, never searched for

`save_profile`, `set_default_model`, `find_recent_projects`, `start_first_task`, and
`finish_onboarding` reach the model
only while it guides, and it calls them as soon as the person answers. They are `defer: false` with
no search keywords. A deferred copy would make the model search for a tool it needs at that moment.
The rename after the person's name needs `set_bot_name`, which Bots offers deferred everywhere; a
recipe's `tools` may name it, and the module's `overrideTools` loads it while the model guides
instead of offering a second copy, because two tools with one name are refused. `create_project`,
`clone_project` and `send_agent_message` are loaded the same way.

## The Chief of Staff is named after the person

Kirill wants the bot to read as theirs: "Ada's Chief of Staff" as soon as the first name is known,
and a nickname replaces it when one is given. The guide calls `set_bot_name` right after
`save_profile`, or after the typed answer when there was no profile, and says so in a few words.
The rename is the model's call through the guide; no code renames the bot.

## A bot's or conversation's own metadata changes after its tool call

Agent Base refuses to write an agent's metadata from inside that agent's own loop, so
`set_bot_name` renaming the calling bot, and `set_default_model` showing the new model in the
Chief of Staff's composer, both failed. Each now records its change durably and the conversation's
metadata follows through a durable function once the tool call returns, run outside the agent's
async context. The bot record changes in the tool's transaction; only the title follows.

## The Chief of Staff hears how the first task goes, and claims nothing else

The guide hands over when the first task finishes and must never claim progress it was not told.
The daemon follows each task `start_first_task` started and tells the model with a hidden
`taskUpdated` event: `waiting` once per question, then `finished` or `failed` once, after which
nothing more is told about that task, also when onboarding already finished. A checkout is worth
mentioning but not worth a message of its own, so `checkedOut` never wakes the bot: it joins the
next turn, after the person's words or ahead of the next waking event. A task whose own turn ends
while a subtask works, or before that subtask has even begun because its checkout is still being
made, is not finished. There are no timers and no progress pings. The flow lists the tasks as
`firstTasks`, so the desktop can leave the focused layout as soon as the first one starts.

## A step types at once, even while it is still working out what to say

The providers step must detect routes before it can write its table, and on a Mac the sign-in
checks behind that can take seconds; the conversation sat silent until they finished. A scripted
message's run now starts, and is announced, before its words are rendered. The API then counts the
time spent rendering toward the usual 300–500 ms before the first words, so a fast step looks the
same as before.

## The routes table ticks what will actually be used

With `CLAUDE_CODE_OAUTH_TOKEN` set, the table ticked the Claude Code sign-in while the token's own
row said it was used instead. The provider routes now leave a replaced route unticked with its own
explanation, the token row reads "Token" rather than "API key", a key for a built-in AI is named as
that AI, and two ticked routes to one provider make a single connection.
