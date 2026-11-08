# Onboarding

Onboarding happens in the Chief of Staff's conversation, and the daemon runs it. Clients draw the
conversation, draw its inline actions with `@slopus/happy-agent-client`, and send each press
through `send`. `packages/happy-agent/API.md` ("Onboarding in a conversation" and "Inline
actions") is the contract.

`OnboardingModule` takes Config, Durable Functions, History, Bots, Profile, Provider CLIs, Provider
Routes, Provider Scan, and the Mobile Connector. The runtime adds it only in standalone mode; a team
server keeps the classic setup and answers the flow routes with `501`. It owns one stored state
(owner `standalone`) and its versioned completion.

## The recipe

What onboarding says and does is data: `recipes/local.json`, checked against
`OnboardingRecipe.ts` and against what this runtime offers (`LOCAL_OFFER` in
`impl/localWords.ts`) when the module is constructed. A recipe that names an effect, outcome,
condition, variable, tool, or requirement this runtime lacks does not start.
`recipes/onboardingRecipe.schema.json` is generated from the TypeBox schema for recipes written
elsewhere, such as Happy Cloud's team recipes; regenerate it with
`node --import tsx scripts/write-onboarding-recipe-schema.ts` in this package, and
`tests/onboarding/onboardingRecipeSchemaFile.test.ts` fails while it is stale.

A recipe has two parts:

- **The bootstrap**, a graph of steps. A step says one message (the first `say` entry whose `when`
  condition holds), offers `onboarding.next` controls toward the steps listed in its `next`, and may
  run an effect whose outcome its `then` maps to the next target: a step, `handoff`, or `finish`.
- **The guide**, the model's instructions once the bootstrap hands off, with the tools the model has
  while it guides.

`{{name}}` in a text is a variable. Plain variables (`botName`, `provider`, `reason`, …) are
HTML-escaped where they are filled. Block variables (`routesTable`, `providerMenu`,
`installCommand`, …) are Markdown or inline action blocks the runtime writes in
`impl/localWords.ts`.

## The bootstrap

Entering a step happens in the transaction that decided it: a start, a press, or an effect's
outcome. It stores the step and the ID its message will have, and invokes the `onboarding.step`
Durable Function. That function writes the step's message as an assistant message in a finished
maintenance run of its own, with no provider or model, so it is never model input. A rerun after a
restart finds the message already written. Then it runs the step's effect.

An effect either has an outcome at once or waits for something outside the conversation:

- a sign-in the flow started, followed through Provider CLIs' updates;
- a sign-in the person runs in their own terminal, looked for every few seconds while it is awaited;
- a daemon restart, after a route was added to `runtime.toml`.

Only the message of the step the flow stands on is live. A press is resolved against the stored
message with the client's shared resolver (in `ApiModule`), then `press` records the choice on the
pressed message, stores the press as the person's words in a finished run of its own, and enters
the step it names. A press needs no mode, because no model answers it. While the recipe disables
typing, a typed message to the conversation is refused with `409`.

A step may take a typed answer (`input`), such as a team server's name step. While the flow stands
on it the composer is enabled, and `ApiModule` asks `answer` before it treats a message as typing.
A message that fits (`impl/typedAnswer.ts`: one line, short enough, one of the listed values when
there are any) is stored and announced like a press, and enters the step the input names with the
trimmed text as its parameter. Anything else follows the recipe's typing rule. The `local` recipe
has no such step.

A start may name the kind of device the person is on. The first start's is kept as `startedOn`,
holds the `onPhone` condition, and reaches the model in `begin`.

The daemon paces each scripted message: it is stored whole, and the API announces it the way a
model's answer streams (`#announcePaced` in `ApiModule`). Other work queued for the conversation
ends the typing at once.

## The hand-off

The model runs on the first model of the first AI the person chose, which becomes the default for
new conversations too. It hears `begin` as a hidden system message, with what is connected, the
model's name and effort, and the profile found in Profile or the person's Git settings. Its first
answer is the verification: `afterInferenceTransact` records the provider as verified. A turn that
settles without an answer returns to the recipe's `handoffFailed` step, which keeps the other AIs
the person chose ticked.

While the model guides, the guide is in its instructions and the recipe's tools are offered:
`save_profile`, `set_default_model`, and `finish_onboarding`. What the person did not do
themselves reaches it as hidden events: `providerAdded` when another AI finishes signing in, and
`phonePaired`. The `local` guide has the model save the profile it was given and say so, ask
before it reads anything, suggest up to three first tasks from the Git metadata of recent projects,
offer the phone while the chosen task runs, and finish only after a first task was offered or the
person stopped. The order is the guide's, not code's. `finish_onboarding` ends the flow once the
requirements are met.

## Completion

`completedVersion` is written by whatever change meets the recipe's last requirement (an AI that
answered, and a profile with a name and an email). The fast path (`summary`) reads the stored row
alone. Nothing is stored before the first `flow/start`, so advertising onboarding changes nothing
for a client that never starts it. That first start records whether the installation was already
in use: the completion marker exists, the profile has a name, or a person has sent a message. An
installation in use counts as finished and never runs onboarding.
