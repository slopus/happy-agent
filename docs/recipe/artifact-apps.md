# Build a live, shared HTML artifact

Use this recipe when an `html` artifact should remember things or be shared: a to-do list, a poll,
a sign-up sheet, a scoreboard, a small game, or a dashboard that people annotate. Every HTML
artifact has its own key-value store. The daemon serves the store to the page at `/api/*` of the
page's own origin, and it pushes every change to every open copy of the page as it happens.

The exact HTTP contract is the "Artifact data" section of the installed release's `API.md` (in the
source checkout, `packages/happy-agent/API.md`). This recipe teaches the browser SDK, which wraps
that contract and is the right choice for almost every page.

## What you get

- **One store per artifact.** Every version of the artifact uses the same store, so publishing a
  new version by changing its files keeps the data. Everyone using this Happy Agent shares it:
  each of the user's devices, and in team mode every member.
- **Who is looking.** `happy.user` is the viewer: a stable `id`, plus `name`, `firstName`,
  `lastName`, and `photoUrl`, each of which may be `null`. Every write records its author in
  `updatedBy`, and `happy.users.load(ids)` turns those IDs into names and photos. Identity always
  comes from the signed-in person; a page cannot claim to be someone else.
- **You can read and write it too.** `read_artifact_data` shows an artifact's data with who wrote
  each key, and `write_artifact_data` sets or deletes a key as you. Use them to report results
  ("who voted for what"), seed starting data, or fix a bad value. Your writes reach every open
  page at once. Their author has `kind: "agent"` and your bot's name, or `"Agent"`.
- **Versions you can read time from.** Every write gets a UUIDv7 `version`, greater than every
  earlier one in the store. `happy.timeOf(version)` returns its `Date`.
- **Realtime changes.** Each change from anyone reaches every tracked value within moments.
- **Network failures are handled for you.** Writes apply on the page at once and queue while the
  daemon is unreachable. They retry with backoff, and each carries an idempotency ID, so a retry
  after a lost response never applies twice. The change stream reconnects by itself and resumes
  from the last version it saw.
- **Problems are reported to you.** The SDK sends uncaught errors, unhandled rejections,
  `console.error`, `console.warn`, and its own sync trouble to the artifact's debug log, which
  `read_artifact_logs` shows you with who hit them and on which version.

## Rules that are easy to get wrong

1. Load the SDK with exactly `<script src="/api/v1/client.js"></script>`. The daemon serves it, so
   it upgrades with Happy Agent; never copy it into the artifact.
2. Always use absolute `/api/...` URLs. A relative `api/...` resolves against the page's own path
   and does not reach the API.
3. Put no files under `api/` in the artifact. The client showing the page sends `/api/*` to the
   daemon, so such files are never served.
4. Keep everything else in the artifact: no CDNs or other network resources. The page may be
   opened where the internet is unreachable.
5. Treat the store as shared and untrusted. Any copy of the page, including older versions, can
   write any key. Validate what you read, and render text with `textContent`, never `innerHTML`.
6. Design keys so that people rarely write the same key. Give each item its own key
   (`todos/<id>`) rather than one big array, and give each person their own key where you can
   (`votes/<userId>`). Use `happy.kv.update` for anything genuinely shared, such as a counter.
7. Unconfirmed writes live only in the page's memory and are dropped if the page closes; the
   daemon's store is the source of truth.
8. Start the page with `<link rel="stylesheet" href="/api/v1/style.css">` and leave `html` and
   `body` without a background, so the page sits on the surface of whatever shows it, in light and
   dark. An app shown inline is drawn at its full height in the reply, so give it no fixed height
   and nothing that scrolls inside it. Keep the layout flat: no card inside a card, no stack of
   rounded cards, and no coloured stripe down a card's left edge. The Happy design system in
   `../DESIGN.md` has the rest.
9. Write the page in order: CSS, then HTML, then scripts at the end of the body, which run only on
   the complete page.

## Standard styles and components

Every artifact page can load two more files the daemon serves beside the SDK, so they upgrade
with Happy Agent too:

- `/api/v1/style.css`, first. It sets the chat's typeface and sizes, a transparent page that
  follows light and dark, and plain styles for text, links, code, tables, and rules. The body is
  inset by `--happy-page-inset` beside the chat, and by nothing inline, where the page lines up
  with the reply, so give the page no margin of its own. Every rule has zero specificity, so your
  own CSS always wins. Use its colour variables instead of fixed colours:
  `--happy-text`, `--happy-muted`, `--happy-faint`, `--happy-border`, `--happy-surface`,
  `--happy-accent`, `--happy-added`, `--happy-removed`, `--happy-diff-added`,
  `--happy-diff-removed`, and `--happy-chart-1` to `--happy-chart-6`, with `--happy-font` and
  `--happy-mono` for type.
- `/api/v1/components.js`, last. It defines five elements that read what they show from the page.
  In Happy Desktop, diffs and code are drawn with the renderer and styling it uses for them;
  elsewhere they are plain numbered lines without highlighting:

```html
<!-- A unified diff, such as git diff writes, saved as a file of the artifact. -->
<happy-diff src="changes.diff"></happy-diff>
<!-- One file of it, and only lines 40–52 of the changed file. -->
<happy-diff src="changes.diff" path="src/app.ts" lines="40-52"></happy-diff>

<!-- Code from a file of the artifact: a header naming it, and only lines 40–52, numbered. -->
<happy-code src="src/app.ts" path="src/app.ts" lines="40-52"></happy-code>
<!-- A snippet written in the page; language names it, otherwise path or src does. -->
<happy-code language="python">
    <script type="text/plain">
        def greet(name):
            return f"Hello, {name}!"
    </script>
</happy-code>
<!-- Long lines wrap; nowrap on either element scrolls them instead. -->
<happy-code src="src/app.ts" nowrap></happy-code>

<!-- The files a diff changes as a tree, with status and counts; clicking one scrolls to its diff. -->
<happy-files src="changes.diff"></happy-files>
<happy-files>
    <script type="application/json">
        [{ "path": "src/app.ts", "status": "modified", "added": 12, "removed": 3 }]
    </script>
</happy-files>

<!-- "bar", "hbar", "line", or "area", drawn at the element's width; height="…" sets a plot's. -->
<happy-chart type="bar">
    <script type="application/json">
        {
            "labels": ["Mon", "Tue"],
            "series": [{ "name": "Requests", "values": [120, 340] }],
            "unit": "rpm"
        }
    </script>
</happy-chart>

<!-- Mermaid flowcharts, sequence, state, class, and entity-relationship diagrams. -->
<happy-diagram>
    <script type="text/x-mermaid">
        flowchart LR
            Write --> Version
    </script>
</happy-diagram>
```

A page's script may set an element's `source` property instead — the diff text, the file list or
diff text, the chart object, or the diagram text — and the element redraws, so a live app can feed
a chart from its store. An element that cannot show what it was given says why in its own place.
Anything else is yours to draw: an SVG in the `--happy-*` colours fits right in.

## The SDK

`window.happy` exists as soon as the script runs.

| Member                                              | What it does                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `happy.ready`                                       | A promise that resolves once the viewer is known and the change stream has connected for the first time. It rejects when this Happy Agent has no data API, which older releases do not.                                                    |
| `happy.user`                                        | The viewer, or `null` before `ready`.                                                                                                                                                                                                      |
| `happy.status`, `happy.onStatus(fn)`                | `"connecting"`, `"online"`, `"syncing"` (connected, with writes or reads in flight), `"offline"` (reconnecting), or `"unavailable"` (the artifact was deleted, or the API is missing). `onStatus` returns an unsubscribe function.         |
| `happy.pending`, `happy.flush()`                    | How many writes are not yet confirmed, and a promise that resolves when none are.                                                                                                                                                          |
| `happy.timeOf(version)`                             | The `Date` a version was written.                                                                                                                                                                                                          |
| `happy.users.load(ids)`, `.get(id)`, `.cached(id)`  | People by user ID, cached. Each has `id`, `kind` (`"user"`, or `"agent"` for an agent's writes), `name`, `firstName`, `lastName`, and `photoUrl` (use it directly as an `<img src>`). Unknown IDs are left out.                            |
| `happy.kv.trackPrefix(prefix)`                      | A live view of every key under a prefix: `entries` (in key order, live keys only), `get(key)`, `loaded`, `pending`, `synced`, `subscribe(fn)` (called at once and on every change; returns an unsubscribe function), and `stop()`.         |
| `happy.kv.track(key)`                               | A live view of one key: `exists`, `value`, `version`, `updatedBy`, `updatedAt`, `pending`, `loaded`, `synced`, `subscribe(fn)`, `set(value, options)`, `delete(options)`, and `stop()`.                                                    |
| `happy.kv.set(key, value, options)`                 | Writes a JSON value. Trackers show it at once with `pending: true`. Resolves with the confirmed entry. Options: `{ ifVersion }` writes only while the key is still at that version, and `{ ifAbsent: true }` only while it holds no value. |
| `happy.kv.delete(key, options)`                     | Deletes a key, with the same options.                                                                                                                                                                                                      |
| `happy.kv.update(key, change)`                      | Read, change, and compare-and-set, retried on conflict up to 8 times. `change(current)` receives the current value, or `undefined`, and returns the next one; returning `undefined` deletes the key.                                       |
| `happy.kv.get(key)`, `.entry(key)`, `.list(prefix)` | One-off reads: a value as this page sees it, a confirmed entry or `null`, and every confirmed entry under a prefix.                                                                                                                        |
| `happy.kv.onChange(fn)`                             | Every confirmed change this page hears, from anyone, as an entry. A deletion has `deleted: true`.                                                                                                                                          |
| `happy.debug.log(message, data, level)`             | Adds an entry to the artifact's debug log with source `app`. `data` is optional JSON; `level` is `"info"` (the default), `"warn"`, or `"error"`. Use it for the events you will want when someone reports a problem.                       |
| `happy.debug.disable()`, `happy.debug.flush()`      | Stop all reporting from this page, or send what is queued now instead of within two seconds.                                                                                                                                               |

An entry is `{ key, value, deleted, version, updatedBy, updatedAt, writeId }`. A tracked view adds
`exists` and `pending`. In a view, `updatedBy` is the viewer's ID while a write is pending.

A refused write rejects its promise with an `Error` carrying `status` and `code`, and the trackers
drop the optimistic value. `code` is `"conflict"` when an `ifVersion` or `ifAbsent` condition
failed, and `error.current` then holds the key as it is now. `"too_large"` means a value is over
256 KiB, and `"storage_full"` that the store is over 100,000 keys or 64 MiB. A write that fails
because of the network is never refused: it waits and retries.

Keys are 1–512 characters without control characters. Values are any JSON. A deleted key is
remembered for 30 days so that pages coming back online learn of it; a page offline for longer
reads the store again, which the SDK does by itself.

## A complete example: a shared to-do list

This page lists to-dos from everyone, with each author's photo and name, shows the sync state,
and works offline. Create it with `create_artifact` as an `html` artifact and write its
`index.html` with `write_artifact_file` as exactly this:

```html
<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Shared to-dos</title>
        <script src="/api/v1/client.js"></script>
        <style>
            :root {
                color-scheme: light dark;
            }
            body {
                font:
                    15px/1.4 system-ui,
                    sans-serif;
                max-width: 34rem;
                margin: 2rem auto;
                padding: 0 1rem;
            }
            header {
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            #status {
                font-size: 12px;
                padding: 2px 8px;
                border-radius: 99px;
                background: color-mix(in srgb, currentColor 10%, transparent);
            }
            #status[data-status="online"] {
                background: color-mix(in srgb, green 20%, transparent);
            }
            #status[data-status="offline"],
            #status[data-status="unavailable"] {
                background: color-mix(in srgb, red 20%, transparent);
            }
            form {
                display: flex;
                gap: 8px;
                margin: 1rem 0;
            }
            input[type="text"] {
                flex: 1;
                padding: 6px 8px;
            }
            li {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 0;
                list-style: none;
            }
            li.pending {
                opacity: 0.6;
            }
            li.done .title {
                text-decoration: line-through;
                opacity: 0.6;
            }
            .title {
                flex: 1;
            }
            .avatar {
                width: 22px;
                height: 22px;
                border-radius: 50%;
                object-fit: cover;
                background: color-mix(in srgb, currentColor 20%, transparent);
            }
            .meta {
                font-size: 12px;
                opacity: 0.7;
            }
            ul {
                padding: 0;
            }
        </style>
    </head>
    <body>
        <header>
            <h1>Shared to-dos</h1>
            <span id="status">Connecting…</span>
        </header>
        <form id="add">
            <input id="text" type="text" placeholder="Add a to-do" maxlength="200" required />
            <button>Add</button>
        </form>
        <ul id="list"></ul>
        <script>
            const statusLabels = {
                connecting: "Connecting…",
                online: "Synced",
                syncing: "Syncing…",
                offline: "Offline, changes are saved here",
                unavailable: "Unavailable",
            };
            const status = document.getElementById("status");
            function showStatus(value) {
                status.dataset.status = value;
                status.textContent = statusLabels[value] || value;
            }
            showStatus(happy.status);
            happy.onStatus(showStatus);

            const todos = happy.kv.trackPrefix("todos/");

            document.getElementById("add").addEventListener("submit", (event) => {
                event.preventDefault();
                const input = document.getElementById("text");
                const title = input.value.trim();
                if (title === "") return;
                // One key per item, so two people adding at once never conflict.
                happy.kv.set("todos/" + crypto.randomUUID(), {
                    title,
                    done: false,
                    by: happy.user && happy.user.id,
                    at: Date.now(),
                });
                input.value = "";
            });

            // Load each author once, and draw again when their names and photos arrive.
            const requested = new Set();
            function loadAuthors(ids) {
                const missing = ids.filter((id) => typeof id === "string" && !requested.has(id));
                if (missing.length === 0) return;
                missing.forEach((id) => requested.add(id));
                happy.users
                    .load(missing)
                    .then(render, () => missing.forEach((id) => requested.delete(id)));
            }

            function render() {
                const list = document.getElementById("list");
                list.replaceChildren();
                const entries = todos.entries
                    .filter((entry) => entry.value && typeof entry.value.title === "string")
                    .sort((a, b) => (a.value.at || 0) - (b.value.at || 0));
                loadAuthors(entries.map((entry) => entry.value.by));
                for (const entry of entries) {
                    const item = document.createElement("li");
                    item.className =
                        (entry.value.done ? "done " : "") + (entry.pending ? "pending" : "");

                    const box = document.createElement("input");
                    box.type = "checkbox";
                    box.checked = entry.value.done === true;
                    box.addEventListener("change", () => {
                        happy.kv.update(entry.key, (current) =>
                            current === undefined ? undefined : { ...current, done: box.checked },
                        );
                    });

                    const author = happy.users.cached(entry.value.by);
                    const avatar = document.createElement("img");
                    avatar.className = "avatar";
                    avatar.alt = "";
                    if (author && author.photoUrl) avatar.src = author.photoUrl;

                    const title = document.createElement("span");
                    title.className = "title";
                    title.textContent = entry.value.title;

                    const meta = document.createElement("span");
                    meta.className = "meta";
                    const when = entry.version ? happy.timeOf(entry.version) : null;
                    meta.textContent =
                        (author && author.firstName ? author.firstName : "Someone") +
                        (when
                            ? " · " +
                              when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                            : "");

                    const remove = document.createElement("button");
                    remove.textContent = "✕";
                    remove.title = "Delete";
                    remove.addEventListener("click", () => happy.kv.delete(entry.key));

                    item.append(box, avatar, title, meta, remove);
                    list.append(item);
                }
            }
            todos.subscribe(render);

            happy.ready.then(render, () => showStatus("unavailable"));
        </script>
    </body>
</html>
```

Open it in two windows, or on two devices, and add a to-do in one: it appears in the other at
once. Turn the network off, add and tick items, and turn it back on: they sync without
duplicates.

## Other patterns

- **Poll or reactions:** one key per voter, `votes/<happy.user.id>`, with the choice as the value.
  Track the `votes/` prefix and count. Nobody can overwrite anyone else's vote by accident.
- **Counter or shared total:** `happy.kv.update("score", (n) => (n || 0) + 1)`.
- **Single shared document, such as a board's layout:** track the key and write with
  `{ ifVersion: tracker.version }`. On a `"conflict"` rejection, show `error.current` and let the
  person merge or retry.
- **Presence ("who is here"):** write `presence/<userId>` with `{ at: Date.now() }` every 30
  seconds while the page is visible, and show entries whose `updatedAt` is recent. Presence keys
  accumulate, so delete your own on `pagehide`.
- **Recent activity:** subscribe with `happy.kv.onChange` and show `updatedBy` and
  `happy.timeOf(entry.version)`.
- **Ordering by creation time:** put a UUIDv7-style or timestamp prefix in the key, or sort by
  `happy.timeOf(entry.version)`, which reflects the latest write.

## Without the SDK

Every SDK call is a plain HTTP request to `/api/v1/...` on the page's origin, as `API.md` describes:
`GET /api/v1/kv?prefix=`, `GET`, `PUT`, and `DELETE /api/v1/kv/entry?key=`,
`GET /api/v1/kv/changes?since=`, and Server-Sent Events from `GET /api/v1/kv/events?since=`. Give a
write a `writeId` to make retries safe, use `If-Match: "<version>"` or `If-None-Match: *` for
compare-and-set, and after a `reset` event read the store again before streaming from its new
cursor.

## Working with the data yourself

- Seed an app after publishing it: `write_artifact_data` with the keys and value shapes the page's
  script reads, such as `todos/<id>` with `{"title":"…","done":false,"at":<ms>}`. Pass `value` as
  JSON text. Use `ifAbsent: true` so you never replace something a person already made.
- Report on it: `read_artifact_data` with a `prefix` lists keys with their values, versions,
  authors, and times; page with `pageCursor`.
- Change a value people may also be changing: read it, then write with `ifVersion` set to the
  version you read. If the write is refused, read again and decide; never retry blindly.
- Prefer changing the page when the data's shape must change. Old and new versions share one
  store, so a new version must still understand the data the old one wrote.

## Debugging your app

Reporting is automatic. Each page batches what goes wrong and sends it to
`/api/v1/debug/log` every two seconds, at most 60 entries a minute; while the browser is offline,
and when a send fails, the batch is dropped rather than retried. The SDK's own `sync` entries say
when the change stream ended and reconnected, when a write conflicted or was refused, when the
page had to read its data again, and when the data became unavailable. The daemon keeps the newest
1,000 entries of the last 7 days per artifact, beside its data.

### Develop with `happy-agent artifact dev`

Build and test the app before publishing it, against a local copy of the data API:

```sh
happy-agent artifact dev ./my-app --scratch .context/my-app-data
```

It serves the folder at `http://127.0.0.1:4173/`, answers `/api/*` with the same code, limits, and
SDK as the daemon, and keeps data and the debug log in the `--scratch` folder (without it, in a
temporary folder removed on exit). It never touches the daemon's data. Start it through an
ordinary shell command or workspace terminal, then open the preview through the agent's workspace
proxy, which opens every connection from that agent's own machine. Listeners inside a restricted
command's private sandbox are isolated from the workspace proxy.

Everything the server can do is under `/__happy/`: an HTML panel at `/__happy/`, and JSON routes
for scripts and for you:

| Route                                       | What it does                                                                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/?as=Alice`                                | Opens the app as a made-up person, with a name and a generated photo. Each tab can be someone else; without `as`, the page is "You".                                |
| `GET /__happy/state`                        | The folder, the faults in force, open change streams, and everyone known.                                                                                           |
| `POST /__happy/faults`                      | Any of `{ "offline": true }`, `{ "latencyMs": 800 }`, `{ "failNext": 3 }` (answer `503` without applying), and `{ "dropNext": 1 }` (apply, then lose the response). |
| `POST /__happy/streams/cut`                 | Cuts every open change stream, as a dropped connection does.                                                                                                        |
| `POST /__happy/data/write`                  | `{ "as": "Bob", "key": "todos/1", "value": {…} }`, or `"delete": true`: a write by someone else, live to every page.                                                |
| `POST /__happy/data/seed`                   | `{ "values": { "key": value, … }, "as": "Bob" }` writes several keys.                                                                                               |
| `GET` / `PUT /__happy/data`                 | Dumps every entry, tombstones and authors included, or replaces the data with such a dump.                                                                          |
| `POST /__happy/data/reset`                  | Forgets every entry; open pages read their data again.                                                                                                              |
| `GET /__happy/logs`, `DELETE /__happy/logs` | The debug log, newest first, with `level`, `user` (a name), `limit`, and `pageCursor`; or clears it.                                                                |
| `GET /__happy/requests`, `DELETE`           | The last 500 data requests, newest first: who made them, status, time taken, and any fault applied.                                                                 |

The debug log route itself is never faulted, so the log shows what pages reported during an
outage. The loop that finds most bugs:

1. Start `artifact dev` and open the app; open it again with `?as=Bob`.
2. Make changes as both people, then make the network bad: go offline, add latency, fail or drop a
   few writes, cut the streams. Check that both pages end up showing the same thing and that
   `GET /__happy/data` holds what you expect, with no doubled items.
3. Read `GET /__happy/logs?level=warn` and `GET /__happy/requests` for anything surprising.
4. Publish the app's files in one `update_artifact` call, each as a `fromPath` file such as
   `{ "fromPath": "my-app/index.html", "path": "index.html" }`, so the call makes one new version.
   `create_artifact` takes the same `files` for a new artifact. After people use it, read
   `read_artifact_logs`, filtered by `level`, `userId`, or `since`, to see what broke for whom.

### Reproduce a bug with real data

Start the server from a copy of a published artifact's data:

```sh
happy-agent artifact dev ./my-app --from <artifactId>
```

It reads the artifact's data through the daemon, once, with its versions and authors' names, and
never writes back. Where the server cannot reach the daemon, save the copy first and start from
the file:

```sh
happy-agent artifact snapshot <artifactId> --out .context/my-app-data.json
happy-agent artifact dev my-app --seed .context/my-app-data.json --scratch .context/my-app-data
```

`--seed` also takes a plain JSON object of keys and values.

### Drive it with a browser

For a repeatable check, script real browsers against the dev server with Playwright and headless
Chromium. Nothing is bundled: install `playwright-core` (or `playwright`) in a scratch folder with
the project's package manager, and use a Chromium already on the machine
(its `playwright install chromium` command otherwise). A useful script:

- opens one page per person, `page.goto(base + "/?as=Alice")`, and waits for
  `window.happy.status === "online"`;
- records `page.on("console")` errors and warnings, `page.on("pageerror")`, and
  `page.on("requestfailed")`;
- plays a scenario, calling `POST /__happy/faults` between steps, and waits for each page's text to
  converge with `page.waitForFunction`;
- ends with screenshots, each page's visible text, `GET /__happy/data`, and
  `GET /__happy/logs`, so you can tell what each person saw and what the store holds.

Failed requests and console errors during injected faults are expected; anything else is a bug.

## Checks before you publish

- The page loads `/api/v1/client.js` with an absolute path, and the artifact holds no files under
  `api/` and loads nothing from the internet.
- Item keys are per item or per person, and shared values use `update` or `ifVersion`.
- The page shows `happy.status` and pending items.
- Everything read from the store is validated, and text is rendered with `textContent`.
- You ran it in `happy-agent artifact dev` as two people, offline and with lost responses, and
  both pages converged with no doubled items and nothing unexpected in the debug log.
