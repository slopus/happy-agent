# Chat media

Images, videos, documents, and other files shown inline in a chat: images the generation tools
make, images an agent reads, and files it presents with `present_files`.

```ts
const chatMedia = new ChatMediaModule(config, history);
const computeModule = new ComputeModule(config, secrets, runners, botSettings, chatMedia);
const imageGeneration = new ImageGenerationModule(config, chatMedia);
const gemini = new GeminiModule(config, computeModule, chatMedia);
```

Configuration owns the private media folder and History owns the durable call record an item is
served by. Reading files from the agent's machine is compute's work, so the tools that do it,
`present_files` and the image readers, belong to compute and ask this module to snapshot what they
show. Chat media therefore comes before compute, and depends on nothing that reads a machine.

## What is stored where

```text
tool result { presentation: { type: "media", items: [{ kind, name, mimeType, size, sha256, … }] } }
        │                                   │
        │ History records it with the call   │ bytes, once per digest
        ▼                                   ▼
durable tool_result block           <agentHome>/media/<sha[0..2]>/<sha256>
        │
        ▼
GET /v0/agents/:agentId/tool-calls/:toolCallId/media/:index
```

History never holds the bytes. `snapshot(bytes, name, source?)` classifies one file by its name, measures
it, writes it under its SHA-256, and returns the item. A name with an `image/*` type becomes an
`image` only when the shared image pipeline decodes it to PNG, JPEG, GIF, WebP, or AVIF; the
item then carries its displayed width and height after EXIF orientation, the decoded format's
media type, and a base64 ThumbHash. Anything else that claims to be an image is a `file`.
`video/*` names are videos, PDFs are documents, and everything else is a file. Content already
held under its digest is not written again; new content is published by rename.
`source`, `{ path, absolutePath }`, records the file the bytes came from as the agent wrote it and
as it resolved, so a layout block in the agent's reply can name the item; generated images use the
generated file's path for both. A path too long for the protocol leaves the item without one.

`presentation(items, layout?)` wraps items as the tool result's `presentation`, which History
records with the successful call. The API removes `sha256` from the public presentation and serves an item
through `storedItem(ctx, agentId, callId, index)`, which reads the recorded presentation through
History and returns the snapshot path only when the snapshot is still present.
`storedItems(ctx, agentId, callId)` returns every item of one call whose snapshot is still
present; the exported bots module sends those with an exported bot's reply.

## Layouts

A presentation's optional `layout` tells clients how to arrange its items. Absent, a client uses
its automatic layout. Image generation asks for one column, image reads for two, and
`present_files` for none unless the agent writes one:

```text
layout HTML ──parseMediaLayoutHtml (client)──▶ { type: "tree", root: MediaLayoutNode[] }
(agent-written)   │  parse5, lenient walk       element · item(index) · text · break
                  ├─ img src ──exactly one of filepaths──▶ that item's index
                  ├─ style ──mediaLayoutStyleValue per declaration──▶ MediaLayoutStyle
                  ├─ what it could not use ──▶ ignored[]  (reported to the model)
                  └─ files it left out ──▶ appended[]     (placed at the end)
```

`parseLayout(html, filepaths)` uses the client package's `parseMediaLayoutHtml`, the same parser
desktop runs on layout blocks in an agent's reply, so the daemon and clients cannot disagree on
what a layout means. It parses with parse5, so tags, attributes, and entities mean what a browser
would make of them, and keeps only what the protocol can carry. A layout never fails the
call; whatever is dropped is listed in `ignored` so `present_files` can tell the model in one
sentence. The kept tags are `div`, `section`, `figure`, `figcaption`, `p`, `span`, `strong`, `em`,
and `code`, plus `img` as an item, `br` as a break, and the widget tags `happy-chart`,
`happy-diagram`, `happy-code`, and `happy-files`, each becoming one typed widget node whose body is
data read from its `<script>` child or own text, never layout content. A layout that places no
file but holds a widget is still used. An unknown tag is unwrapped and its text
kept; a tag that embeds, loads, or runs something, such as `script`, `style`, `iframe`, `svg`, or
a form control, is dropped with its contents, as is anything parse5 puts in `head`. The
attributes are `style` everywhere but `br`, and `src` and `alt` on `img`. Each `img src` must equal
one of the call's `filepaths` exactly and becomes that item's index; an `img` with any other `src`,
or a second one for the same file, is dropped. Files the layout leaves out are appended at the end,
so every item is placed exactly once, and a layout that places none is dropped whole.

`style` declarations are checked one at a time against the client's `mediaLayoutStyleValue`, the
same grammar every client checks again: a closed subset of CSS covering flexbox, grid, sizing,
spacing, alignment, `object-fit`, and text, with `tone` and named font sizes instead of colours.
An unknown property or a value outside its grammar drops that declaration only. A style holding a
backslash or a quote is dropped whole, which keeps escapes, strings, and `url()` out. The input is
at most 32 KiB, kept elements deeper than 12 are unwrapped, HTML nested deeper than 32 is dropped,
every element and text counts toward 500 nodes, and a tree holds at most 8,000 characters of text
and alt. Clients receive only the typed tree, never HTML.

An image item carries `scale` when its PNG `pHYs`, JPEG JFIF, or EXIF density says 144 or 216 DPI,
so a Retina screenshot shows at its natural CSS size. Clients show an image without explicit
sizing at that natural size at most, in every layout.

## The tools

This module owns no tools. Compute gives every agent with a machine `present_files`, which takes
`filepaths`, one to ten paths, and an optional `layout`, measures every file before reading it, and snapshots each through this module; the image
readers snapshot the original image they read the same way, and show nothing when that fails.

Live pages belong to the Artifacts module. Use `create_artifact` with `type: "html"` and `url`.

Every agent is told, through this module's instructions, that generated images, images it reads,
artifact cards, and presented files appear inline in its own chat only, not in parent or child
chats, and that an image it has read is already shown. The instructions also give one sentence and one tiny
example of arranging images already shown with plain HTML in the reply; clients find those blocks
with the client package's `splitMediaLayoutBlocks` and place each `img src` by the item's
`source`.
