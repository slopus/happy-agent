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

## The whole image surface, and the API facts behind it

`gemini_imagegen` offers every Gemini image model and every documented parameter: `model`,
`reference_image_paths` (the API takes them as `{type:"image", mime_type, data}` blocks in the same
`input` array as the prompt), `aspect_ratio`, `image_size`, and `output_format`. Reading and
normalizing local reference files is shared image-pipeline work in `sources/impl/images/`, not
either vendor module's own, so Codex and Gemini prepare them identically and only the final
request shape differs.

Three facts settled from Google's Interactions API reference, having been guessed wrong before:
`response_format.mime_type` is real and accepts both `image/png` and `image/jpeg`; the aspect
ratios and resolutions differ per model, so arguments are validated against that model's published
table before a billed request; and every REST example pins `Api-Revision`, which Rig now sends.
The model catalog is hardcoded in `GeminiImageModels.ts` — Rig never asks a provider what it
offers.

Nothing in this module has ever run against the real Gemini API: every test drives a scripted
`fetch`. The key available during this work was rejected as invalid, so the surface above is built
from documentation and remains unverified end to end.

## The module must be installed, not merely written

The whole Gemini module was never constructed in `startHappyAgentRuntime`, so it never booted and
no agent ever saw a single Gemini tool — the module was complete, tested in isolation, and dead in
the product. Composing a module in the runtime record is not enough; it must also appear in the
ordered install list. `tests/runtime/runtimeModules.test.ts` now boots the real runtime, creates an
agent, and asserts that every composed value carrying a `beforeStart` is reachable through
`agent.module(name)`, so a module that is written but never installed fails immediately.
