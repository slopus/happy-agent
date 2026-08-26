# Gemini — learnings

## Image generation follows the codex_imagegen approach

`gemini_imagegen` originally wrote to a model-chosen `output_path` through the compute module, so
an agent without a resolved machine lost image generation entirely — on a Bedrock-only
installation with a Gemini key, the agent had Gemini web search but no image tool. The user's
direction is that the two vendor image tools share one approach rather than two: like
`codex_imagegen`, the Gemini tool is gated only on its credential, proves the answer is a real PNG
via the shared `impl/images` helpers, publishes into the shared generated-files folder under the
tool call's name, and hands the model both the path and the image. The tools stay separate
vendor-shaped definitions in their own modules — unifying behavior does not mean merging one
module's tool into the other. Music generation and media analysis still work through the agent's
machine and keep the compute gate.

## The module must be installed, not merely written

The whole Gemini module was never constructed in `startHappyAgentRuntime`, so it never booted and
no agent ever saw a single Gemini tool — the module was complete, tested in isolation, and dead in
the product. Composing a module in the runtime record is not enough; it must also appear in the
ordered install list. `tests/runtime/runtimeModules.test.ts` now boots the real runtime, creates an
agent, and asserts that every composed value carrying a `beforeStart` is reachable through
`agent.module(name)`, so a module that is written but never installed fails immediately.
