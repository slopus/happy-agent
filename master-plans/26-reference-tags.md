# Master plan 26: Happy links

## Big picture

Agents mention Happy entities and files in their replies, and a person should be able to click
straight through to them. Every mention is an ordinary Markdown link, so any Markdown renderer
parses it and no surface needs a custom tag parser.

An entity is a link to a `happy://` URL: `[Q3 report](happy://artifacts/<id>)`. The hosts are plural
nouns — `artifacts` (with an optional `?version=N`), `agents` (tasks, subtasks, bots' agents),
`projects`, `workspaces`, `workspaces/<id>/services/<id>`, `surfaces`, and `users` — so they never
collide with the Happy mobile app's own `happy://` deep links. The label is the writer's fallback:
the name the agent knows. Clients that can resolve the entity show its live title and state
instead, and an empty label asks the client to fill in the name.

A file in another workspace is a link too, and it has two forms that are equally valid everywhere.
Markdown uses `happy://`: `[Foo.tsx:42](happy://agents/<id>/files/<path>#L42)`. The API uses
`happy-file`: `happy-file://agents/<id>/<path>#L42`. Agents write `happy://` links in their replies;
API fields and the API specification use `happy-file`. Every reader accepts both. A file link's
label is shown as written. A file in the reader's own workspace stays a plain `path:line`.

## Rendering

Every link renders as a plain clickable underlined link, inside a sentence or alone on its line.
There is no chip or card. An entity link shows the live title. When the entity is busy, the client
shows its usual progress treatment on the link text: an agent working, a service running, or
anything still being set up. On desktop that is the shimmer. A link whose entity is unknown,
deleted, or not visible renders as inert text, and so does a malformed `happy://` link. No client
hands a `happy://` or `happy-file://` URL to the operating system.

While a reply streams, a partial trailing link is never shown as raw text. A surface that cannot
render links gets readable plain Markdown: the live title or the label, never a raw URL. That
covers Telegram, the Happy mobile app, and other integrations.

## Legacy tags

Before links, agents wrote `<happy-KIND id="…"/>` reference tags. Nothing emits them any more, but
stored history still holds them, so the shared parser keeps reading them as entity links with an
empty label, clearly marked as legacy.

## One implementation

The URL grammar, the parser, the formatter, the partial-link rule, the legacy tag reader, and the
plain-text fallback live in one place, `@slopus/happy-agent-client`. Desktop, every other client,
and the daemon use that code unchanged. The daemon validates and resolves where it already owns
the catalog and permissions, and it uses the fallback renderer for outbound integrations. `API.md`
specifies the syntax.

## Where we are

`API.md` specifies `happy://` links, both file forms, and the legacy tags, and the shared client
implements them, but agents still write tags. On desktop, artifact, agent, workspace, and project
tags are clickable links, and service tags stay inert.

## Order and criteria

1. The client and the specification. `API.md` specifies `happy://` links, both file forms, and the
   legacy tags, and the shared client parses, formats, and falls back for all of them. Done when
   the client is published.
2. Agents write links. Every tool that returns an entity or a file returns the ready-to-paste
   `happy://` link, and the agent instructions tell agents to mention entities and files with them.
   Done when nothing tells an agent to write a tag.
3. Desktop renders links. Artifacts, agents, workspaces, projects, surfaces, users, and files open
   from chat, entities with their live titles and busy state, and old tags still render. Done when
   a person clicks through from chat for every kind.
4. Services. They are specified and parsed but render inert until a client renders them. Their
   module starts emitting links at that point.
5. Fallback everywhere. Every outbound integration, starting with the Happy mobile app, relays the
   fallback, never a raw link URL or tag. Done when no integration shows one.

## Future direction: choices

A later tier adds `<happy-choice>` follow-up buttons that send a new turn when pressed. This is a
direction only. Do not build it until it is planned.
