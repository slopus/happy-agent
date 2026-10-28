# Onboarding

Onboarding happens in Happy's own conversation, and the daemon controls it; clients only draw the
conversation and post presses on its inline actions. `packages/happy-agent/API.md` ("Onboarding in
Happy's conversation" and "Inline actions") is the contract.

`OnboardingModule` takes Durable Functions, History, Bots, and Profile. It owns one stored state
per owner (`standalone`; team members keep the classic onboarding) and its versioned completion.

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
words are in `impl/onboardingCopy.ts`, in the inline action grammar; the desktop's flow on
`chat-onboarding` is the reference for their wording.

## The inline action grammar

`impl/chatActions/` is a copy of the desktop's grammar (`happy-desktop-state/src/chatActions`),
plus the `data-phone-pair` figure. The daemon checks every press against its own copy of the
block with it. Both move into `@slopus/happy-agent-client` with its next release; until then the
copies must stay identical.
