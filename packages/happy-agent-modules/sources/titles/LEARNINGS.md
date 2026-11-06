# Titles — learnings

## Titles follow accepted user-role messages, not transports

The message-accepted transactional hook counts text-bearing messages whose actual message role is
`user`; provenance metadata is irrelevant, so API messages, tool-submitted messages, and other
in-process callers follow one path. The first such message generates a title and, for an eligible
placeholder workspace, a slug from that message alone and in one request. The second triggers one
title refinement from committed history, which already includes the new user message. Later user
messages do not generate naming requests.

The hook writes the per-agent counter and snapshots a bounded history excerpt for the second
message before registering post-commit work. Taking that snapshot in the acceptance transaction
keeps a very fast response to the second message out of the refinement input. Inference and
metadata updates then run on a detached module-owned context through an `AsyncResource` created
outside every agent turn. Both boundaries are necessary: detaching the structured context prevents
reuse of a committed database transaction, while the async resource prevents agent-loop
async-local state from making the eventual metadata update look like a self-deadlocking in-turn
mutation. Initial naming and second-message refinement stay detached and never delay real work.
The API module must not participate in naming, and the agent does not wait for a workspace or Git
branch rename: both are applied asynchronously when the initial naming result arrives.

Every task rechecks metadata before writing, so a title chosen while it runs always wins. Initial
naming and refinement are serialized per agent, allowing a quickly arriving second user message to
wait for initial naming without delaying the agent itself.

Refinement needs durable generated-title provenance, not merely the presence of a title. Store the
exact title automatic naming wrote and refine only while the current metadata still matches it. A
title supplied during creation or changed later by a user or agent has no matching provenance and
must remain final. Write provenance after metadata; a crash between the two safely gives up a
refinement instead of misclassifying a deliberate title as generated.

Initial naming must use the combined `nameFromFirstMessage` operation. The title-only suggestion
path loses workspace propagation. The module resolves direct workspace placement and then walks
agent ancestry, so a collaborator inherits the same eligible workspace as its parent. Workspace
resolution failure must not suppress an otherwise valid session title.

## A failed naming request still titles the chat

Every chat on a Codex account whose WebSocket handshake OpenAI answers with `426` stayed
"Untitled": naming runs with a zero retry budget, the provider then refused its WebSocket-to-SSE
fallback, and the failure was only logged at debug level. The provider now treats 426 as a
transport choice, but any provider can fail or answer nothing usable. Initial naming therefore
falls back to the bounded first-message excerpt that tasks and bots already use, and records it as
a generated title so the second user message can still refine it. A chat with a user message
never stays untitled because one optional request failed.

## Placeholder names must remain distinguishable from chosen names

Clients sometimes create a workspace with a temporary display name before its first chat exists.
Workspace creation therefore carries whether the supplied name was deliberately chosen. Omission
means chosen for compatibility; an explicit false keeps the workspace eligible for first-message
naming. Names supplied by the workspace-creation agent tool are deliberate. Eligibility is checked
again by the workspaces catalog when the generated slug is applied, so a user rename that races
naming still wins.

## Short titles share the naming request, are one capitalized word, and are never cut

Kirill asked for a very short label for tasks and bots, for compact places, then that it be words
only (an earlier "one word plus an emoji" shape such as "Onboarding 🚀" was dropped), then that it
be shorter still. It is asked in the same request as the title, so it costs no extra model call,
and the prompt says only: one or two capitalized words, at most 10 characters. Kirill asked for one
super short instruction, so emoji and casing are left to the parser rather than spelled out in the
prompt, and API.md states only the budget. Its purpose is deliberately not described. Emoji the
model adds anyway are removed (with their variation selectors, skin-tone modifiers, and joiners),
and an all-lowercase word is capitalized, before the budget is checked; other casing such as
"iPhone" or "API" is kept. The budget is 10 UTF-16 code units, the length of "Your Story", as
Kirill set it; the earlier 13 (the most the desktop's 78 px label fits) still gave long labels.
An answer over budget is discarded rather than shortened, and the excerpt fallback supplies none;
clients fall back to the full name. A rename clears it, since it described the old name. Existing
tasks and bots get no backfill: Kirill asked for no compatibility work.
