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

## Agents mention artifacts by Happy link, and clients show the live title

Kirill wanted artifacts mentioned in chat to open as live links, after ChatGPT's entity
components. Steve then asked for ordinary Markdown links instead of custom `<happy-artifact/>`
tags, so any Markdown renderer parses them. An agent writes `[title](happy://artifacts/<id>)`;
the title it writes is only a fallback, because it goes stale when the artifact is renamed, so
clients look up the live title and show that. Surfaces that cannot do that get the title as plain
text. The tools return the exact link, and the module adds a short instruction, because the
artifact tools are deferred and an agent may mention an artifact without loading them. Links are
written with the client's `formatHappyMarkdownLink`, through `formatArtifactLink`, so this module
never repeats the grammar.

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

## The host centres pages; pages do not centre themselves

Generated pages were often left-aligned, or centred each in a width of their own. Steve asked for
one content width across Happy, artifacts included, so Happy Desktop now centres every artifact
page beside the chat and on its own in a 912px column (the 880px content column plus 16px gutters)
with root `padding-inline`, and leaves inline pages to the chat column. The writing tools and
`docs/DESIGN.md` §1.7 tell agents not to add their own `max-width` and `margin: auto`, which would
only narrow the page, and to opt a full-width app out with
`<meta name="happy-page-width" content="full">` before reaching for `100vw`.

## Games and canvases opt into app mode; the host owns the exit

Steve asked for an opt-in that makes an HTML artifact full screen and app-like, for games, canvases,
and other pages where scrolling fights the input. A page declares
`<meta name="happy-page-mode" content="app">`; the clients then open it full screen from a card
rather than inline, edge to edge with no scrolling or zoom, pass the safe-area insets also as
`--happy-app-inset-*`, and draw their own close control (a "×" top-start on mobile, back on Android,
Full screen and Esc on desktop). The writing tools and `docs/DESIGN.md` §1.8 reserve it for such
apps, not documents or dashboards, which use `happy-page-width: full`, and tell agents to fill the
viewport, keep clear of the insets, take touch and keyboard, and never build an exit of their own,
because one the page draws can be missing or broken while the host's always works.

Games then needed the corner the "×" took, and some wanted an exit in their own menus. The page
moves the button with `<meta name="happy-app-close">` (`top-start` by default, any corner, or
`none`), learns where it is from `data-happy-app-close`, the 48px it reserves in the inset on its
edge, and the `--happy-app-close-x`/`-y`/`-width`/`-height` box, and closes itself with
`window.happyApp.close()`. The docs steer agents to move the button rather than hide it: `none` is
only for a page with its own always-visible exit, and the host still keeps back, Esc and ⌘W, the
desktop header, and a swipe down from the top edge that brings the "×" back.

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

## Initial text can be published in the creation call

Requiring a title-only artifact before writing its entry cost an extra tool call and exposed an
unfinished first version. Steve asked to create an artifact with its contents. `create_artifact`
now accepts optional `content` for Markdown and HTML. Steve then asked to supply supporting files
as `{ path, content }` too, so a whole multi-file artifact can be published in one call without
writing temporary local files. Creation accepts inline UTF-8 files mixed with `fromPath` copies,
publishing the entry and assets together in version 1.0. Each file has exactly one source, every
destination is unique, and only copies need machine access. Top-level content and a file entry
cannot both supply the same path, and live URLs cannot take either kind of file. Omitting content
still supports the title seed or an entry in `files`; later text changes continue through the
artifact file tools, while `update_artifact` keeps its copy-only `files` contract.

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

An artifact shown inline can change after the call that issues it, through
`write_artifact_file` and `edit_artifact_file` calls after `create_artifact`. Its
presentation therefore says `shows: "latest"`, and a client keeps that place in the
chat on the artifact's newest version, which is where an HTML artifact appears inline at its full
height. `update_artifact` records one change, so it says `"version"`. A missing `shows` means
`"version"`, so older history keeps its cards. Live pages now use the same artifact presentation.

The prompt says what an inline page must look like because the default a model reaches for — a
stack of rounded cards, tinted callouts, a coloured stripe down the left edge — is exactly what the
master plan rules out. An inline page is part of the reply: laid on the chat with no frame or
background, never capped and never scrolling as a whole. Anything that needs its own scrolling is
shown beside the chat instead.

## An inline page keeps the height of its first render

Kirill found it jarring that toggling a tab, expanding a section, or filtering a list in an inline
artifact resized its frame and shifted the whole chat. The prompt now says the first render decides
the height and every state must fit it: tabs sized to the tallest panel by stacking panels in one
grid cell, details in a popover instead of an accordion, a long or changing list or log in one
scrolling region of fixed height (the one exception to an inline page never scrolling), and room
reserved for loading data, images, and empty and error states. A constant height held by padding
is worse: content at the top over a big blank area reads as a broken, empty part of the chat. So
large fixed or minimum heights and viewport units are ruled out, and a state that cannot be
redesigned to a similar size lets the page shrink. `docs/DESIGN.md` §1.6 has the fuller rules.

## A live page is an artifact, not a separate presentation

Kirill replaced standalone page presentations with HTML artifacts whose content is a URL.
The artifact and every version carry `live: { url, networkId }`; the original agent's network is
captured at creation and never changes, even when another agent changes the URL. Only HTTP(S)
without embedded credentials is accepted. The daemon never fetches the page. Every create or
update is reviewed in Auto, including an owner's metadata-only update, without granting Full
access. Clients use an artifact-scoped browser profile, never workspace or other-artifact cookies.

The published API still requires file entries, so a live version retains one fixed inert HTML
notice. It contains no artifact title, live address, redirect, iframe, or script. Kirill chose a
title-independent notice so renaming remains a catalog-only transaction: it neither stages new
bytes nor needs background materialization. The notice is staged once before creation; versions
keep it unchanged, and identical notices share their content-addressed copy. File edits are
refused at the module boundary. Live pages use the ordinary artifact creation tool; the separate
page tool and its deprecated alias are gone. Legacy page presentations remain readable in history.

Review descriptions are synchronous in Agent Base. The async review predicate resolves a target
snapshot, weakly keyed by that invocation's arguments, for the description to read. Execution
checks the reviewed network or revision again, and a changed target requires another review;
concurrent invocations do not share a mutable last-target slot.

## Live pages use one destination-policy boundary

An unrestricted network tunnel let a remote page reach the agent's loopback, private LAN, or
cloud metadata. Kirill chose one artifact-owned connector for both HTTP requests and nested
CONNECT, exposed through the artifact proxy route. Each new connection reads the artifact's
current URL. Only public addresses are allowed, except the exact recorded localhost or literal
loopback host and port; private LAN and link-local addresses never receive an exception.

The address classifier and numeric-host normalization come from the published client package,
shared by the daemon and Desktop; `impl/artifactNetwork.ts` remains the one connection-policy
boundary and owns no duplicate classifier. An IPv6 blocklist missed
reserved and special-purpose space, and treating every embedded IPv4 as loopback granted
transition addresses the local exception. Public IPv6 now requires `2000::/3` outside
`2001::/23`, `2001:db8::/32`, `2002::/16`, and `3fff::/20`, or a public IPv4 embedded in a mapped,
translated, or well-known NAT64 address. Only `::1` and mapped/translated `127/8` are IPv6 loopback.

Hostnames are normalized only for classification; exception equality preserves their requested
spelling. DNS runs on the daemon's host and the existing compute connector receives checked IP
literals, never a hostname. Every public answer is retained and tried in order on connection
errors under the proxy's single connection deadline, so an unreachable IPv6 route does not hide
a working IPv4 answer. Exact localhost skips DNS and tries IPv6 only after IPv4 refuses. This
deliberately does not support names known only inside a runner or container. No compute or
supervisor resolver was added.

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

## A cover is an image the artifact draws, in one of two shapes

Steve wanted the Feed to show a good artifact as a post with a picture of what it found, not a
type glyph. A version may name a `cover`, one of its own files, and a `summary`; clients
draw only the image, so the headline, key number, or chart lives in the picture itself. The daemon
decodes the cover and records its size, so clients lay a post out without measuring. Steve then
fixed the shapes to `wide` (16:9) and `square` (1:1), within 2%, with minimum sizes and a 4096px
cap, so posts look the same everywhere; anything else is refused with both recommended sizes.

SVG covers are refused rather than rasterized. iOS and Android cannot draw SVG, and the released
daemon is a Bun executable whose image processor is `Bun.Image`, which does not read SVG and has no
Sharp to fall back on. Steve chose to have agents render charts and diagrams to PNG themselves,
with whatever their machine has, so the prompts say how, and the daemon renders nothing.

Covers carry over like a background, but a kept cover is checked again on every version, because
`write_artifact_file` or `files` can replace its file; losing the file refuses the version. An
image's or series' default cover is marked as a default so it follows the picture when the file is
replaced, instead of failing the way a named cover would. A live-URL artifact holds no files, so it
refuses a cover.

The summary began as one 280-character line. Steve made it a short post instead, like a tweet:
what the artifact is and its key takeaway, in a few sentences. It is plain text up to 5,000
characters with `\n` line breaks; the module turns CRLF into `\n` and trims it before checking,
so the stored text is what every client shows, and it is never Markdown.

## Withdrawn types are removed from storage

`sidebar` and `sidebar_proposal` artifacts belonged to the Spaces sidebar, and `story` artifacts to
Stories; both were removed before a stable release. Leaving their rows would make every read that
validates a record throw, so a migration deletes those artifacts with their versions and files,
and inline text no remaining file uses. Content files on disk stay, as they do for any deleted
artifact. History still parses an older call's presentation of a withdrawn type, and the API shows
that call as a plain tool instead of a card no client can open.
