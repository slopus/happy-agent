# Artifact data — learnings

## The store belongs to the artifact, not to a version or a person

Steve asked for key-value storage that is local to an artifact ID, shared through the daemon, and
shared between users. One store per artifact ID serves every version, so publishing a new version
keeps the app's data, and it serves everyone the daemon serves. A page learns who is looking from
`me`; identity always comes from authentication, never from the page.

## Stores live in their own files, outside the main database

Steve asked for each store to persist in a file in a `_data_` folder rather than the main
database. Each store is one SQLite file at `artifacts/_data_/<artifactId>/kv.sqlite`, which keeps
crash-safe atomic writes without growing the daemon's database. Its operations therefore commit on
their own and cannot join a caller's main-database transaction. Writes are single transactions
with no follow-up work, so the module needs no Durable Functions.

## Versions are UUIDv7 minted from the store's own high-water mark

Every value has a UUIDv7 version so that its time can be read from it. Minting from the persisted
high-water mark keeps versions strictly increasing across restarts and clock rollback. That makes
a version a resume cursor for `changes` and the event stream, and an `If-Match` precondition.

## Reliability is idempotent writes plus a resumable feed

Pages run on flaky networks, and a value must be "tracked" in a way that detects syncs. Writes
carry a client-chosen `writeId`, remembered per user for 24 hours, so a retry after a lost response
never applies twice. Deletions leave tombstones for 30 days, so a resuming client learns of them.
A cursor older than the pruned horizon, or one the store never issued, is refused
(`cursor_unavailable`, or a `reset` event), and the client reads the store again. The SDK keeps
pending writes in memory only, and Steve confirmed that is enough: the daemon's store is the
source of truth, and each version has its own origin, so browser storage would not carry pending
writes across versions anyway. A page closed before its writes are confirmed drops them.

## The API ships with the daemon, and clients forward it blindly

Steve asked for the client to forward `/api/*` transparently so agents can add API without a
client release. The page's `/api/<rest>` maps one-to-one to `/v0/artifacts/<id>/api/<rest>`, and
the SDK itself is served from `/api/v1/client.js`. The routes are versioned under `v1` so they can
grow additively. Realtime uses SSE over a streamed `fetch`, never WebSockets, because client
protocol handlers cannot carry upgrades. The daemon does not refuse publishing files under
`api/`; that would break artifact creation, so the guidance tells agents not to.

## Pages never see private identities

Artifact pages are untrusted code. They get a user's ID, name, split name, and a page-relative
photo URL, never an email, a WorkOS ID, or the standalone profile's private identity. In
standalone mode the user ID is derived from the profile's identity by hashing, so it stays stable
without revealing it.

## Agents read and write app data as authors of their own

Steve asked for tools so agents can use an app's data, not only build its page. `read_artifact_data`
and `write_artifact_data` work on the same stores and limits as pages, and agent writes reach open
pages live. A write's author is an opaque ID derived from the agent's ID, because agent IDs are
unguessable addresses and pages are untrusted code; the store keeps the mapping so `users`
resolves it to a name with `kind: "agent"`. The write tool takes the value as JSON text so every
provider's schema can carry it, and derives its write ID from the call ID so a call repeated after
an interruption is not applied twice.

## The SDK must send exactly the parameters the routes read

The released SDK asked for each next listing page with `after`, while `GET kv` reads only
`pageCursor`, as API.md specifies. Every request answered page one again, so a prefix of more
than 1,000 keys made `list` and `trackPrefix` request forever, grow memory, and stay "syncing".
No test paged, so it went unseen. The SDK now sends `pageCursor`, a gym test pages 1,005 keys
through the served `client.js` and counts its requests, and an audit of every request the SDK
builds (query names, headers, and body fields) against the routes and API.md found no other
mismatch. Any new SDK call needs a test that drives it through the served script.

## Debugging is built in, and the development server is the daemon's code

Steve asked for tools to debug artifact apps without cutting scope. Pages report their own
trouble to a debug log the agent reads with `read_artifact_logs`, because agents cannot see the
person's browser console and people rarely describe failures precisely. Reporting is automatic,
batched, rate-limited on both ends, and dropped rather than retried, so a failing page never adds
load or loops. Each entry records the reporting user, the receive time, and the artifact's newest
version then; the page's own idea of its version is not trusted. The log is a bounded ring in its
own file beside the store, not in the main database.

`happy-agent artifact dev` must behave like the daemon, so it runs the same `ArtifactDataStores`
and `ApiArtifactData`, never a second implementation; only identity differs. Fake people come from
the SDK's `X-Happy-Dev-User` header (taken from `?as=`), then the requesting page's `as` for
scripts and images, then a cookie. Faults are applied outside the routes: offline destroys the
socket, `failNext` answers `503` unapplied, and `dropNext` applies the request and destroys the
socket before any byte is sent, which is the "applied but response lost" case idempotent writes
exist for. The debug log route is never faulted so the log covers outages. `--from` reads a
published artifact's data once through the daemon's own routes and never writes back; a workspace
service cannot reach the daemon, so `artifact snapshot` writes a dump for `--seed`.

## A page looks like the app by default, and the host's values come first

Kirill asked that artifacts by default have exactly the app's fonts, theme, insets, and even
scrollbars, without hardcoding any of it: the model may still style a page its own way. So
`style.css` defines every value a page uses as a `--happy-*` property that resolves through a
host input of the same name, `--happy-host-*`, before its own `light-dark()` fallback. The host
may set its inputs anywhere, an inline style on `<html>` included, because pages never write them;
a page that sets a `--happy-*` property at any specificity still wins. Having the host override
`--happy-*` directly was rejected: it loses to a page's zero-specificity overrides only by source
order, and an inline style would beat the page outright. The colour scheme follows the same rule
through `--happy-host-color-scheme`, so the app's own light or dark choice reaches the page while a
page that declares its own `color-scheme` keeps it. Happy Desktop inserts the sheet itself at user
origin for a page that does not link it, so it must never hold `!important` or a relative `url()`.

Scrollbars are styled at the least specificity from `--happy-scrollbar-size`, `-thumb`, and
`-thumb-hover`, through the WebKit pseudo-elements where they exist and `scrollbar-color`
elsewhere; a page's own `scrollbar-color` turns the pseudo-elements off in Chromium, so either way
of restyling them works. Kirill also asked that the same page sit flush inline but inset beside the
chat or on its own page: the body's padding is `--happy-page-inset`, which the host sets to its
content inset there and to nothing inline, so one page fits every place it is shown.

## Review quotes preserve source lines and leave highlighting to the host

Kirill asked that guided reviews use the app's syntax highlighting for diffs and ordinary code,
keep long lines on one row, and avoid a duplicate first line. The guided-review skill now quotes
published source files with `happy-code` and gives both code and diff elements `nowrap`, preserving
the components' public wrapping default. The host supplies its renderer at `code.js`; the daemon
continues to provide the numbered fallback when that renderer is unavailable. That fallback no
longer prints the hunk's section label as an extra code row: it starts with the actual source and
uses an ellipsis only between separate hunks. Its table cells already have no borders, so review
pages should leave their styling to the standard components. Code excerpts use the same 12px text,
20px line height, and renderer spacing as the app, rather than larger text and wider code-only
insets.
