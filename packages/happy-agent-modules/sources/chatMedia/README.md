# Chat media

Images, videos, documents, and other files shown inline in a chat: images the generation tools
make, and files an agent presents with `present_files`.

```ts
const chatMedia = new ChatMediaModule(config, computeModule, history);
const imageGeneration = new ImageGenerationModule(config, chatMedia);
const gemini = new GeminiModule(config, computeModule, chatMedia);
```

Configuration owns the private media folder, compute owns the agent's machine and its file
boundary, and History owns the durable call record an item is served by.

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

History never holds the bytes. `snapshot(bytes, name)` classifies one file by its name, measures
it, writes it under its SHA-256, and returns the item. A name with an `image/*` type becomes an
`image` only when the shared image pipeline decodes it to PNG, JPEG, GIF, WebP, or AVIF; the
item then carries its displayed width and height after EXIF orientation, the decoded format's
media type, and a base64 ThumbHash. Anything else that claims to be an image is a `file`.
`video/*` names are videos, PDFs are documents, and everything else is a file. Content already
held under its digest is not written again; new content is published by rename.

`presentation(items)` wraps items as the tool result's `presentation`, which History records
with the successful call. The API removes `sha256` from the public presentation and serves an item
through `storedItem(ctx, agentId, callId, index)`, which reads the recorded presentation through
History and returns the snapshot path only when the snapshot is still present.
`storedItems(ctx, agentId, callId)` returns every item of one call whose snapshot is still
present; the exported bots module sends those with an exported bot's reply.

## The tools

`present_files` is a common tool every agent receives. It takes `filepaths`, one to ten paths on
the agent's machine, and reads them through compute under the call's permissions, so runners and
containers work like any other file tool. Each file is measured before it is read: a directory, an
empty file, an image over 32 MiB, a video over 256 MiB, another file over 64 MiB, or more than
256 MiB in one call fails the call. A path outside the workspace is reviewed in Auto and runs with
Full access only when allowed, through compute's shared path-boundary helpers. The tool is
durable: a repeated call reads the same files and records the same items.

`show_page` presents a web page inline by its `url`, `title`, and `display`. It records only the
presentation; the daemon never fetches the page, and the client opens it through the agent's
network. Every call is reviewed in Auto, with the URL and title shown to the reviewer.

Every agent is told, through this module's instructions, that generated images, artifact cards,
and presented files appear inline in its own chat only, not in parent or child chats.
