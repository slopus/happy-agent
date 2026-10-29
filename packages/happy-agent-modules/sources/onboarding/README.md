# Onboarding

Onboarding happens in Happy's own conversation, and the daemon controls it; clients only draw the
conversation and send presses on its inline actions as the person's own action messages. `packages/happy-agent/API.md` ("Onboarding in
Happy's conversation" and "Inline actions") is the contract.

`OnboardingModule` takes Config, Durable Functions, History, Bots, Profile, Provider CLIs, Provider
Routes, Provider Scan, Tasks, Spaces, and the Mobile Connector. It owns one stored state per owner
(`standalone`; team members keep the classic onboarding) and its versioned completion.

## State and completion

```text
not_started ─start─▶ welcome ─Start onboarding─▶ providers ─▶ connecting ─▶ verifying ─▶ guided ─▶ finished
                                                     ▲                          │ fails
                                                     └──────────────────────────┘
```

The row stores what cannot be derived cheaply: the step, the provider whose first onboarding answer
proved it works, the example-sidebar and restart flags, and `completedVersion`. The profile
requirement is read from Profile. `completedVersion` is written by the change that meets the last
requirement of `ONBOARDING_VERSION`; Profile's change events re-check it. The fast path
(`summary`) reads the row alone.

## Happy's own messages

Before a provider is connected Happy's messages are the daemon's: `onboarding.say` is a Durable
Function invoked in the transaction that decides to speak, with its message and run IDs chosen
there. It writes one assistant message in a finished maintenance run of its own, with no provider
or model, so it is never model input, and a rerun after a restart finds it already written. None
is ever rewritten: install and sign-in progress is a `data-provider-cli` figure the app draws live
from Provider CLIs. The words are in `impl/onboardingCopy.ts` and `impl/connectingCopy.ts`, in the
inline action grammar; the desktop's flow on `chat-onboarding` is the reference for their wording.

The daemon also paces them: each is stored whole, and the API streams it the way a model's answer
streams (`#announcePaced` in `ApiModule`), the prose in word-sized chunks, the action blocks with the whole
message. Clients draw what arrives and never pace anything themselves. Other work queued for
Happy's conversation, such as a send or the model's own events, ends the typing at once.

## Happy's model leads once an AI is connected

The first connected AI becomes Happy's model and the default model for new conversations, and its
first answer is the verification: Happy is told `begin`, with that model's name and effort, as a
hidden system message (`#tell`), and `afterInferenceTransact` marks the provider
verified when that answer lands. If Happy's turn settles without one, onboarding says what failed
and returns to choosing. From then on the model writes every message, following `onboardingGuide`
(`impl/onboardingGuide.ts`) in its instructions. A press is an action message on the ordinary send
queue (`pressAction`): its transaction records the choice, does the work, and queues the message
with the work's outcome (`impl/pressOutcome.ts`), which the model reads as the person's turn. During
the bootstrap the same message is recorded in a finished run and answered by the scripted reply.
Only the newest offer of an action is live. Hidden events (`#tell`) remain only for what the
person did not do: `begin`, a provider added, a connection that failed, a phone paired. The
module adds two tools while it guides, `save_profile` and `set_default_model`; Happy talks to Focus
with the ordinary `send_agent_message`. Their calls are ordinary, visible tool calls. The recipe is
in Happy's instructions from the start, so the person may type at any step instead of pressing. A
press is stored with the `label` the person saw and, for a checklist, the `ticked` labels, so
clients draw it as the person's own bubble. While onboarding runs, Happy's agent carries
`composerPlaceholder` ("Or just tell me in your own words…"); finishing clears it. No scripted
Connected line is said: Happy's first model message opens with it.

## The person's work

Focus (the Spaces module's Prioritizing) does the organizing; onboarding only starts it. Discover
is the person's consent: in the press's transaction `SpacesModule.allowDiscovery` lets Focus's
consent-gated `discover_work` read what Happy disclosed, and `SpacesModule.startFocus` creates Focus
as Happy's subtask with its task ("Organize Ada's work from the places above, most important
first.") as its first message, shows its row under Happy with the `goals` icon as the daemon's
sidebar change, and returns its ID and model. When the press is accepted into Happy's conversation,
`messageAcceptedTransact` writes the finished `create_agent` call any sub-agent shows, with the
`agent_spawn` presentation carrying Focus's model and agent ID, right after the press in its run.
Happy's model never creates or messages Focus at Discover; it introduces Focus and waits. I'll tell
you starts Focus without a task, and Happy hands over the person's words with `send_agent_message`.

Focus proposes with `propose_sidebar`, offering chats the person does not have yet as `newRows`.
When its turn that answered Happy ends, Spaces messages Happy with the open proposal's ID and what
Focus said; that message starts Happy's next turn, which shows the
`<figure data-sidebar-proposal>` card and the Good to go menu. The card is a preview with no
controls: Good to go (`sidebar.proposalAccept`, pressable in Happy's chat and in Focus's) accepts
it, creating the new rows read-only, and its outcome lists each started chat by space ID for
`onboarding.workOpen`. Changes are typed; Focus revises the same proposal. Start onboarding
removes the empty Bots and Tasks headings, so no heading disappears later. Try Create is the app's
own Create; its press names the space it made.

## The inline action grammar

`impl/chatActions/` is a copy of the desktop's grammar (`happy-desktop-state/src/chatActions`),
plus the `data-phone-pair`, `data-provider-cli`, and `data-setting` figures and a checklist
submit's `data-empty-label`. The daemon checks every press against its own copy of the
block with it. Both move into `@slopus/happy-agent-client` with its next release; until then the
copies must stay identical.
