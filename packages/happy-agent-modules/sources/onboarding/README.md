# Onboarding

Onboarding happens in Happy's own conversation, and the daemon controls it; clients only draw the
conversation and post presses on its inline actions. `packages/happy-agent/API.md` ("Onboarding in
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
or model, so it is never model input, and a rerun after a restart finds it already written. The
words are in `impl/onboardingCopy.ts`, `impl/connectingCopy.ts`, and `impl/workCopy.ts`, in the
inline action grammar; the desktop's flow on `chat-onboarding` is the reference for their wording.

The daemon also paces them: each is stored whole, and the API streams it the way a model's answer
streams (`#announcePaced` in `ApiModule`), the prose in word-sized chunks, the action blocks with the whole
message. Clients draw what arrives and never pace anything themselves. Other work queued for
Happy's conversation, such as a send or the model's own events, ends the typing at once.

## Happy's model leads once an AI is connected

The first connected AI becomes Happy's model, and its first answer is the verification: Happy is
told `begin` as a hidden system message (`#tell`), and `afterInferenceTransact` marks the provider
verified when that answer lands. If Happy's turn settles without one, onboarding says what failed
and returns to choosing. From then on the model writes every message, following `ONBOARDING_GUIDE`
(`impl/onboardingGuide.ts`) in its instructions; each press does the machine's work and tells the
model what happened as one more hidden event. The module adds two tools while it guides:
`save_profile` and `propose_work`.

## The person's work

`onboarding.discover` reads only what Happy disclosed (`impl/discoverWork.ts`): the connected
assistant's own sessions, the first request of each, and the last 30 days of commit subjects and
branch names of their projects, bounded and read-only. Focus proposes from those findings through
`SpacesModule.proposeWork`, a bounded side inference on the chosen model with Focus's own rules and
no conversation; when the person describes their work instead, Happy's model calls `propose_work`
and the proposal is written after its reply. The proposal is Happy's message, a `data-table`
checklist. Looks right opens a chat per ticked row, places the rows under their topics in one
sidebar change (`SpacesModule.placeWork`), then sends each chat its first message exactly as shown,
read-only. The chat and message IDs are fixed in the step's durable store, so a rerun after a
restart finds what it already made.

## The inline action grammar

`impl/chatActions/` is a copy of the desktop's grammar (`happy-desktop-state/src/chatActions`),
plus the `data-phone-pair` figure. The daemon checks every press against its own copy of the
block with it. Both move into `@slopus/happy-agent-client` with its next release; until then the
copies must stay identical.
