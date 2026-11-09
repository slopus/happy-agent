# Onboarding

Onboarding happens in the Chief of Staff's conversation, and the daemon runs it. Clients draw the
conversation and its chat UI with `@slopus/happy-agent-client`, and send each click through
`POST /v0/agents/:agentId/actions`. `packages/happy-agent/API.md` ("Onboarding in a conversation"
and "Chat UI") is the contract.

`OnboardingModule` takes Config, Durable Functions, History, Bots, Profile, Provider CLIs,
Provider Scan, the Mobile Connector, Tasks, and Chat UI. The runtime adds it only in standalone
mode; a team server keeps the classic setup and answers the flow routes with `501`. It owns one
stored state (owner `standalone`) and its versioned completion.

## The recipe

What onboarding says and does is data: `recipes/local.json`, checked against
`OnboardingRecipe.ts` and against what this runtime offers (`LOCAL_OFFER` in
`impl/localWords.ts`) when the module is constructed. A recipe that names a variable, component,
tool, or requirement this runtime lacks does not start. `recipes/onboardingRecipe.schema.json` is
generated from the TypeBox schema for recipes written elsewhere, such as Happy Cloud's team
recipes; regenerate it with `node --import tsx scripts/write-onboarding-recipe-schema.ts` in this
package, and `tests/onboarding/onboardingRecipeSchemaFile.test.ts` fails while it is stale.

A recipe has two parts:

- **The opening** (`bootstrap`, optional): one message the server writes itself, its `say` words
  and below them the chat UI components its `offer` names, filled from the runtime's own state.
  The `local` recipe offers `provider_sign_in`, one per AI that is installed or has an installer.
  `failed` is said instead, with the same components, when a connected AI could not be put to
  work. A recipe without an opening hands the conversation to the model at once.
- **The guide**, the model's instructions once the opening hands off, with the tools the model has
  while it guides. The model asks with `show_ui`, never with markup in its text.

`{{name}}` in a text is a variable (`botName`, `machine`, `provider`, `reason`,
`firstProjectRecipe`), HTML-escaped where it is filled.

## The opening

Opening happens in the transaction that decided it: a start, or a connection that failed. It
stores step `opening` and the ID its message will have, and invokes the `onboarding.opening`
Durable Function. That function writes the message through Chat UI's `post` as an assistant
message in a finished maintenance run of its own, with no provider or model, so it is never model
input. A rerun after a restart finds the message already written.

The opening's components act through Provider CLIs, not through onboarding: install, sign in,
paste a code or a token. Provider CLIs announces a connection (`onConnected`) when the widget's
`sign_in` finds the AI signed in already, or when a sign-in the widget started finishes. A sign-in
the person finishes in their own terminal connects too, once a changed sign-in state is seen from
signed out to signed in; an AI that was signed in all along waits for its widget. Onboarding then
enables that AI's provider and hands over, or opens again with `failed` and the reason. While the
recipe disables typing, a typed message to the conversation is refused with `409` before anything
else about it is checked.

A start may name the kind of device the person is on. The first start's is kept as `startedOn`,
holds the `onPhone` condition, and reaches the model in `begin`.

The daemon paces each scripted message: it is stored whole, and the API announces it the way a
model's answer streams (`#announcePaced` in `ApiModule`). Other work queued for the conversation
ends the typing at once.

## The hand-off

The model runs on the first model of the AI the person connected, which becomes the default for
new conversations too. It hears `begin` as a hidden system message, with what is connected, the
model's name and effort, and the profile found in Profile or the person's Git settings. Its first
answer is the verification: `afterInferenceTransact` records the provider as verified. A turn that
settles without an answer opens again with the recipe's `failed` words and why.

While the model guides, the guide is in its instructions and the recipe's tools are at hand:
`save_profile`, `set_default_model`, `find_recent_projects`, `start_first_task`, and
`finish_onboarding`, which exist only then, and `show_ui`, `set_bot_name`, `create_project`,
`clone_project`, and `send_agent_message`, which their modules offer deferred everywhere and
`overrideTools` loads for that time, so the model renames the bot "<First name>'s Chief of Staff" or to a nickname, sets
up the first task's project, and passes the person's word to the task, without searching.
`find_recent_projects` reads the recent work in the daemon: the folders in Claude Code's and
Codex's session history and their Git metadata through the read-only Git scanner, bounded to a
few seconds, never through the model's shell. `start_first_task` creates the first task through Tasks as a new top-level task owned by
the person, never a subtask of the Chief of Staff. A switch of model from inside the Chief of
Staff's own tool call reaches its composer through the `onboarding.useModel` durable function,
because an agent's metadata cannot be written from inside its own loop.

What the person did not do themselves reaches the model as hidden events: `providerAdded` when
another AI finishes signing in, `phonePaired`, and `taskUpdated` for each task `start_first_task`
started. Those tasks are kept as the flow's `firstTasks`, and each is followed until its run first
finishes or fails, also after onboarding finished:

- `checkedOut`, when a workspace-bound subtask below it is ready (`mark_ready`), once per project.
  It never wakes the Chief of Staff: it waits in the state's `notes` and joins its next turn, through
  `beforeTurn` when the person writes, or ahead of the next waking event.
- `waiting`, when the task or one of its agents asks the person something (`user_input_requested`),
  once per question.
- `finished`, when the task's own run settles with no agent below it still running or not yet
  begun, with the first two sentences of its last message; `failed`, when its run settles with an
  error. Either is the last update about that task.

The `local` guide has the model save the profile it was given and say so, ask before it reads
anything, suggest up to three first tasks from the Git metadata of recent projects, which
`find_recent_projects` reads in the daemon without the model's shell, or, when it
finds none, offer concrete starts (a repository to clone, a new project, a folder they name) so a
first task still starts, offer the phone while the chosen task runs, and hand over when the task
finishes. The order is the guide's, not
code's. `finish_onboarding` ends the flow once the requirements are met.

## Completion

`completedVersion` is written by whatever change meets the recipe's last requirement (an AI that
answered, and a profile with a name and an email). The fast path (`summary`) reads the stored row
alone. Nothing is stored before the first `flow/start`, so advertising onboarding changes nothing
for a client that never starts it. That first start records whether the installation was already
in use: the completion marker exists, the profile has a name, or a person has sent a message. An
installation in use counts as finished and never runs onboarding.
