# Gemini

Gemini's media tools, run by the module itself. There is no injected backend and no host
boundary: the module makes the Gemini HTTP calls, and reaches the agent's machine through the
compute module so a generated file lands where every other file tool would put it.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { ComputeModule, ConfigModule, GeminiModule } from "@slopus/happy-agent-modules";

const config = await ConfigModule.load();
const gemini = new GeminiModule(config, new ComputeModule(config));
const agent = await Agent.create(ctx, { ...options, modules: [gemini] });
```

`config` is where the key comes from: Gemini is not one of the accounts a chat runs on, so it has no
provider entry, and `ConfigModule.geminiApiKey` resolves the `[gemini] api_key` setting in the user
`happy.toml`, falling back to `GEMINI_API_KEY`, on behalf of every module that needs it. `compute` is the compute module itself: it is how this module finds one agent's
machine and works through that machine's boundary — permissions, resolved paths, whether a path
needs review — rather than a host integration.

The module is always safe to install. An installation with no Gemini key gets no Gemini tools. An
agent with no compute configured still gets image generation — it publishes into the shared
generated-files folder the way `codex_imagegen` does — but not the music and analysis tools, which
work through the agent's own machine. One instance serves every agent.

`GeminiModule.transport()` is the module's one seam, and it exists for tests: it answers with
nothing, which means the global `fetch`, and a test subclass overrides it to answer without a
network (see `tests/gemini/support/geminiTools.ts`). There is no constructor option for it and the
product never overrides it.

## Tools

- **`gemini_imagegen`** — a PNG from Gemini 3.1 Flash Image, published the same way
  `codex_imagegen` publishes: proven to be a real PNG, written into the shared generated-files
  folder under the tool call's name, and handed back to the model as both the path and the image
  itself. `aspect_ratio` and `image_size` are optional; whatever Gemini wrote about the image comes
  back as its description.
- **`gemini_generate_music`** — an MP3 from Lyria 3, saved to `output_path`, which must end in
  `.mp3`. `mode` defaults to `clip` for a short preview; `song` generates a longer full track and
  may cost more. Lyrics and structure come back with the result when Gemini writes them.
- **`gemini_analyze_media`** — one local image, audio, video, or PDF file up to 15 MiB, sent
  inline with the question asked about it. The media type is decided by the file's extension, so a
  file whose kind cannot be named is refused before its bytes leave the machine.

All three are `durable: false`: a generation is billed work that leaves a file behind, so an
interrupted call is reported rather than run a second time. All three require Auto or Full access
and always request Auto review, because they reach an external API outside the local sandbox. The
approval text quotes the model's own prompt and path exactly, with terminal and bidi controls made
visible. For the music and analysis tools, writing or reading outside the workspace, or writing a
protected path, additionally runs the approved call in Full access; image generation writes only
into the shared generated-files folder and needs no elevation.

## Files

Generated music and analyzed media go through the compute filesystem: the path is resolved the way
the machine resolves it, missing directories are created, and the finished file is remembered. An
existing file may be overwritten without a prior read. Once this module has read or written a path,
later generations check that remembered timestamp both before and after the external request so an
intervening change is not silently discarded. A generated image bypasses all of this: it lands in
the shared generated-files folder under a temporary name and is published by rename, exactly as
`codex_imagegen` publishes.

## Storage

The module persists nothing but that read log. There is no catalog of what was generated, no
event, and no host API: a tool calls Gemini, writes the file, and answers with its path.
