# Artifacts — learnings

## An artifact is a bundle of files, not one file

The first design held one file per Markdown or HTML artifact and told HTML to inline everything.
Steve corrected it: a Markdown document refers to images generated next to it, and an HTML page
loads images and other assets beside it. Every version is now a small tree of files named by
relative path, with one entry the type decides (`index.md`, `index.html`, or the first file for
the single-file and series types). All of a version's files are served under one URL prefix, so
relative references resolve without rewriting. Single-file types are bundles of one file.

## Versions are patches over the last one, and content is stored once

A new version starts from the latest version's files, adds or replaces paths, removes paths, or
starts over with `replaceAll`. Content is stored once per SHA-256, so a file a version keeps is
never sent or stored again, and the same picture in two artifacts is one file on disk. Manifests
are always in path order, which also orders an image series; agents number frames to choose it.

## A file's media type comes from its path

Uploads carry no name or media type. The daemon decides a file's type from its path's extension,
`application/octet-stream` when unknown, so what a client is served always agrees with the path a
reference uses. Markdown and HTML entries must be UTF-8; every upload records whether it is, so
that is checked when the upload is placed, not while it streams.

## Paths cannot leave the artifact, and serving matches the manifest exactly

Paths are validated segment by segment (`.`, `..`, empty segments, `\`, and control characters are
refused), and a file is served only when its decoded path is exactly a path in the version's
manifest. The filesystem location always comes from the digest, never from the requested path, so
traversal has nothing to reach.

## Uploads are owned before their bytes exist

An upload row and the durable call that removes it commit before any byte is written, so an
interrupted upload is still removed. Creating and changing an artifact only place uploads that
already hold stored content, inside one transaction, so those operations stay ordinary
transactional work. An expiring upload removes its content only when no version file and no other
upload holds the same digest, checked in the same transaction that deletes the row.

## Deletion is a tombstone

Deleting keeps the record readable, stops serving versions and files, and refuses later changes;
content stays on disk. That matches the API's rule that durable data is never erased and lets
every client learn of the deletion by ID. Deletion is final, so `delete_artifact` is always
reviewed in Auto.

## Where an artifact was made is found by walking up the agent tree

An agent's source is decided by walking from the acting agent through its parents: the first agent
that is a bot's or a task's, or belongs to a workspace or a project root, names the place, and the
acting agent stays the source's `agentId`. A conversation that belongs to none of them is an
`agent` source. A project's root workspace has the project's own ID, so it reads as the project.

## HTML artifacts can be apps with data of their own

Steve asked for HTML artifacts to get a realtime key-value API, shared between users and kept in
a file outside the main database. It is a separate Artifact Data module rather than more of this
one: the data lives in `_data_/<artifactId>/` beside this module's content, belongs to the artifact
ID so every version shares it, and stays on disk when the artifact is deleted, like content does.
Pages reach it at `/api/*`, so `create_artifact` and `update_artifact` tell agents to read the
artifact apps recipe and to put no files under `api/`. Publishing such files stays allowed, so
existing clients keep working.

## Agents mention artifacts by tag, never by title

Kirill wanted artifacts mentioned in chat to open as live links, after ChatGPT's entity
components. An agent writes `<happy-artifact id="…"/>` inline and never the title, because a
title the model wrote goes stale when the artifact is renamed. Clients look up the live title and
render a link. Surfaces that cannot do that get the title as plain text. The tools return the exact
tag, and the module adds a short instruction, because the artifact tools are deferred and an agent
may mention an artifact without loading them. Tags are written with the client's
`formatHappyReferenceTag`, so this module never repeats the grammar.

## Writing calls show a card in the chat

The user asked for an artifact an agent creates or updates to appear in the chat as a card that
opens it, without depending on the artifact's content. `create_artifact` and `update_artifact` now
return an `artifact` presentation with the ID, type, title, and the version the call made; History
records it with the call, so live and reloaded history agree. The reply tells the model the user
already sees the card, and only in this chat, so a sub-agent's artifact must be mentioned again
by the agent the user talks to. A repeated update after an interruption reports the artifact's
latest version, which differs only if someone changed it in between.

## Artifacts sit on the host's surface

Kirill saw a white strip flash beside an HTML artifact while the desktop pane resized: the viewer
painted its own paper behind the page, and the page set no background. An artifact's slot now
paints nothing, so the surface around it shows through, and the writing tools tell agents to leave
`html` and `body` transparent with `color-scheme: light dark` and to keep pages flat — no card
inside a card, no coloured stripe down a card's left edge. Those two patterns read as generated
filler; the full rules live in `docs/DESIGN.md`.

Kirill also wanted a way to customize the slot, used sparingly. A version may name a
`background`, a hex colour and nothing else, so no CSS reaches a client through it and native
clients can parse it. It belongs to the version rather than the artifact because it describes the
content: an older version keeps the canvas it was made for, and like unchanged files it carries
over to the next version until a change clears it with `null`. The tools describe it as something
to leave out unless the content needs one fixed canvas.

## Agents write artifacts with artifact tools, straight in the catalog

Kirill's master plan for inline artifacts replaced sending whole files through `create_artifact`
and `update_artifact`: every small change was a rewrite, and models already know how to patch
files. Two designs that let agents edit artifacts as files on their own machine were built and
dropped. The first gave each artifact a directory, `.happy-artifacts/<artifactId>/`, in the
agent's working directory and versioned it after every tool call, with a watch and a fence to find
what changed. Every machine and every agent sharing a folder held its own copy, so the copies had to
be kept in step, and syncing them was error prone. The second routed a reserved path,
`/happy/artifacts/<artifactId>/`, through the file tools Happy Agent hosts. That cannot reach agents
whose tool execution runs in a harness Happy Agent does not control.

So agents now write artifacts with tools of their own that work on the daemon's catalog directly:
`write_artifact_file`, `edit_artifact_file`, and `read_artifact_file`, the same for every agent.
They copy the file tools agents know — `content`, `old_string`, `new_string`, `replace_all`, line
`offset` and `limit`, the same uniqueness rule and messages — so there is little new to learn.
There is one copy and nothing to sync. `create_artifact` still issues the ID, and the `fromPath`
files of `create_artifact` and `update_artifact` still publish files built with the shell. Editing
artifacts as files on a machine may come back later. It is not worth the trouble before the basics
work.

## Every writing call is one version, keyed by the call

Each call that writes makes exactly one minor version, keyed by the call ID. The tools look for
that version before doing anything else, because an edit replayed after a restart would otherwise
fail on text it already changed. An edit names the revision it read, so a version someone made
meanwhile refuses it rather than being undone. Writing a file exactly as it is makes no version.
Content is stored once per digest, so a model stuck editing in a loop costs history rather than
storage. The simple cap Kirill asked for is 100 versions of one artifact per agent per hour; past
that a write fails and asks for fewer, larger calls.

## Versions are labelled major.minor, and only agents choose a major

Kirill wanted minor versions for every change and major versions only on purpose. The integer
`number` stays every version's identity in routes and tags, and each version also carries
`major.minor`. Every change is the next minor; `update_artifact` or `PATCH` naming `major` makes
`major.0`. That must be exactly the next major, and only after at least one minor change, so a
major always marks something new. Versions made before labels existed read as 1.0, 1.1, and so on.

## Writing someone else's artifact is reviewed

Every agent can read every artifact, so reading is never reviewed. An agent writes artifacts it
created as freely as its own files. Writing one someone else made, an agent or a person, publishes
a version everyone sees. Auto reviews that, Workspace write refuses it, and Read only refuses every
artifact write. The catalog is not the agent's machine, so a reviewed write is never lent Full
access. Only a `fromPath` read from outside the workspace is. This replaced reviewing every call of
the old `edit_artifact_files`, which Kirill flagged for letting any agent publish over anyone's
work.

## The chat follows the artifact it shows inline

An artifact shown inline is written after the call that issues it: the versions that matter come
from the `write_artifact_file` and `edit_artifact_file` calls after `create_artifact`. Its
presentation therefore says `shows: "latest"`, and a client keeps that place in the
chat on the artifact's newest version, which is where an HTML artifact appears inline at its full
height. `update_artifact` records one change, so it says `"version"`. A missing `shows` means
`"version"`, so older history keeps its cards. `show_page` presents any web page the same way
inline, through the agent's network; the daemon never fetches it.

The prompt says what an inline page must look like because the default a model reaches for — a
stack of rounded cards, tinted callouts, a coloured stripe down the left edge — is exactly what the
master plan rules out. An inline page is part of the reply: laid on the chat with no frame or
background, never capped and never scrolling inside. Anything that needs its own scrolling is
shown beside the chat instead.

## A few standard components, served with the daemon

The master plan keeps what we hardcode to a diff, code, a tree of changed files, charts, and
diagrams, available to every artifact rather than to reviews only, so models can do everything else
in plain HTML. They are custom elements in `/api/v1/components.js` that read what they show from
the page itself, a file of the artifact or a `<script>` child, so a page needs no script of its own.
They render into the light DOM and their styles live in `/api/v1/style.css` with zero specificity,
so a page restyles any of them in its own stylesheet. Mermaid comes from Beautiful Mermaid, which the
desktop already uses for diagrams; it is 1.5 MB with its layout engine, so `components.js` loads
`diagrams.js` only for a page that holds a `<happy-diagram>`, and the bundle is committed as a
generated module so the daemon and its single binary serve it with nothing installed.

## Diffs and code are drawn by the host's renderer

The first `<happy-diff>` was a hand-written table that only resembled the desktop's diffs. Kirill
asked for diffs and code in artifacts to use the same renderer and styling as the desktop's
full-file diffs and code, inline and usually smaller. Bundling Pierre Diffs and Shiki's grammars
into the daemon was tried and rejected: the desktop already ships them, the daemon ships neither,
and Kirill did not want every grammar shipped twice. So `<happy-diff>` and `<happy-code>` import
`/api/v1/code.js` from the page's host, an ES module with `renderDiff` and `renderCode` (API.md
gives the contract), which Happy Desktop serves from its own build with the options of its
changed-file pane and code blocks. Everywhere else, the daemon and `happy-agent artifact dev`
included, the import fails and they draw plain numbered monospace lines with tinted additions and
deletions, which stays readable without highlighting.

The diff is still parsed by the component itself, so `path` and `lines` keep working and
`<happy-files>` still finds each file's section; each file is handed to the renderer as a git patch
of only the hunks it shows. The page's style sheet, not the renderer, maps the desktop's `--diffs-*`
variables onto the page's `--happy-*` colours, so a page restyles both renderings in one place. The
desktop's two diff colours are `--happy-diff-added` and `--happy-diff-removed`, kept apart from the
text colours `--happy-added` and `--happy-removed`, which must stay readable as text. Long lines
wrap by default, because an inline page never scrolls inside, and `nowrap` scrolls them instead.
