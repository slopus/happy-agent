---
name: rich-replies
description: Read before writing a chart, diagram, code quote, or changed-files list directly in a reply as HTML — the <happy-chart>, <happy-diagram>, <happy-code>, and <happy-files> widget tags the chat draws natively, with zero tool calls. Also covers the HTML layout subset replies may use around them.
---

# Rich replies: widgets written straight into the answer

A reply's Markdown may carry small HTML blocks the chat draws natively: a
chart, a Mermaid diagram, a code quote, or a changed-files list, plus plain
layout around them and around images you already showed. No tool call, no
artifact, no scripts — the block is parsed into typed data and drawn by the
app. Use a widget when one picture of the data answers the question better
than a paragraph: a measurement compared, a flow explained, the three lines
that matter, the shape of a change.

Prefer this over an artifact when the content is one or two small pieces that
belong inside the sentence flow of the answer. Build an **artifact** instead
when the content is a document of its own: a full review, many sections,
anything interactive, or anything you will keep editing.

## The widgets

Write each as a block starting at the first column, its root tag closed
explicitly (never `<happy-…/>`). Inside a widget, put the body in a `<script>`
child of the right type: it carries JSON and code through the HTML parser
verbatim, so `<`, `&`, and quotes never need escaping. A widget whose body is
empty, over a bound, or invalid JSON makes the whole block stay as plain text
in the reply — nothing is hidden, but nothing is drawn either, so get the JSON
right.

**Chart** — `type` is `bar`, `hbar`, `line`, or `area` (default `bar`). Body:
`labels` (≤100, each ≤200 chars), `series` (≤10 of `{ "name"?, "values" }`,
values ≤100 numbers, `null` for a missing point), optional `unit` (≤24 chars,
such as `ms` or `%`).

```html
<happy-chart type="hbar"><script type="application/json">
{ "labels": ["Parse", "Layout", "Paint"],
  "series": [{ "name": "Before", "values": [412, 96, 31] },
             { "name": "After",  "values": [118, 94, 30] }],
  "unit": "ms" }
</script></happy-chart>
```

**Diagram** — Mermaid source, ≤8,000 chars, in `text/x-mermaid` (or
`text/plain`). The app renders it; a source it cannot draw is shown as a code
block, so keep the Mermaid simple and valid.

```html
<happy-diagram><script type="text/x-mermaid">
flowchart LR
    reply[Reply HTML] --> parser[Shared parser] --> tree[Typed tree] --> chat[Drawn natively]
</script></happy-diagram>
```

**Code quote** — ≤8,000 chars in `text/plain`; optional `language` (≤40 chars)
and `path` (≤512 chars, a display label only — nothing is read from disk).
Shared indentation and blank first/last lines are removed, so indent the body
freely.

```html
<happy-code language="ts" path="src/retry.ts"><script type="text/plain">
    const delay = Math.min(cap, base * 2 ** attempt);
    await sleep(delay + jitter());
</script></happy-code>
```

**Changed files** — a JSON array, ≤200 rows of `{ "path", "status"?, "added"?,
"removed"? }`; `status` is `added`, `deleted`, `renamed`, or `modified`. Inline
data only — write the numbers yourself, from what you actually changed.

```html
<happy-files><script type="application/json">
[ { "path": "src/retry.ts", "status": "modified", "added": 14, "removed": 3 },
  { "path": "src/retry.test.ts", "status": "added", "added": 52 } ]
</script></happy-files>
```

## Layout around them

The same blocks may hold the nine layout tags (`div`, `section`, `figure`,
`figcaption`, `p`, `span`, `strong`, `em`, `code`), `<img src>` naming an image
you already showed by the path you read, presented, or generated it at, and
`<br>`. `style` takes a closed CSS subset: flexbox and grid, `gap`, sizing,
margins and padding, `aspect-ratio`, `object-fit`, text alignment and weight,
plus two theme fields instead of colours — `tone: default | muted | accent`
and `font-size: small | normal | large | title`. No colours, backgrounds,
borders, positioning, URLs, `calc()`, or `var()`; such declarations are simply
dropped. Up to 16 widgets per block; bodies share an 8,000-character budget.

```html
<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px">
  <figure><happy-chart>…</happy-chart><figcaption style="tone: muted">p50</figcaption></figure>
  <figure><happy-chart>…</happy-chart><figcaption style="tone: muted">p99</figcaption></figure>
</div>
```

## What good looks like

The widget sits on the chat's own surface, already matching the app's theme.
Do not decorate: no cards around widgets, no wrappers whose only job is
spacing, no borders, no headings bolted above a chart that the sentence before
it already provides. Absolutely never the default Claude look — many cards,
rounded corners, a highlighted left edge. One widget in the right place beats
three in a row; write the sentence that states the finding, then the one
widget that shows it. Keep charts honest: real numbers from the work you did,
units named, no invented data. For code, quote only the lines that carry the
idea — the file link beside it opens the rest.

Everything here is desktop-chat only: parents, subagents, and exported bots
never see these blocks, so when a widget carries the answer, also state its
point in one sentence of prose.

After a context compaction, re-read this skill before writing rich reply HTML
again: the exact tags, script types, and JSON shapes matter, and a guessed
shape degrades the block to plain text.
