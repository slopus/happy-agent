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
module adds four tools while it guides: `save_profile`, `discover_work`, `propose_work`, and
`set_default_model`. Their calls are ordinary, visible tool calls.

## The person's work

Pressing Discover allows `discover_work` to read only what Happy disclosed
(`impl/discoverWork.ts`): the connected assistant's own sessions, the first request of each, and
the last 30 days of commit subjects and branch names of their projects, bounded and read-only.
`propose_work` asks Focus through `SpacesModule.proposeWork`, a bounded side inference on the
chosen model with Focus's own rules and no conversation, from those findings and what the person
said. It stores the rows under values that name that proposal alone (`p2-work-1`) and returns the
`data-table` checklist (`impl/workCopy.ts`) that Happy's model shows as returned; a press on an
older proposal is a conflict. Looks right fixes each ticked row's space, task, and agent IDs in the
press and returns them; the step opens each chat, then places the rows under new topic sections at
the end of the sidebar in one change of the person's own (`SpacesModule.placeWork`), committed with
the rows becoming `started`, then sends each chat its first message exactly as shown, read-only.
Start onboarding removes the empty Bots and Tasks headings, so no heading disappears later. Try
Create is the app's own Create; its press names the space it made.

## The inline action grammar

`impl/chatActions/` is a copy of the desktop's grammar (`happy-desktop-state/src/chatActions`),
plus the `data-phone-pair`, `data-provider-cli`, and `data-setting` figures and a checklist
submit's `data-empty-label`. The daemon checks every press against its own copy of the
block with it. Both move into `@slopus/happy-agent-client` with its next release; until then the
copies must stay identical.
