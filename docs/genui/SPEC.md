# Gen UI v1: format and renderer rules

## Document

```json
{
  "genui": 1,
  "fallback": "Q3 revenue was $1.24M, up 18%.",
  "root": {
    "type": "card",
    "title": "Q3 at a glance",
    "children": [
      { "type": "stat", "label": "Revenue", "value": "$1.24M", "delta": "+18%", "trend": "up" }
    ],
    "actions": [
      { "type": "button", "label": "Break down by plan", "action": { "type": "message", "text": "Break down by plan" } }
    ]
  }
}
```

- `genui`: format version, the integer `1`.
- `fallback`: plain text that says the same thing. Shown where Gen UI cannot be rendered, and used for search, notifications and screen readers. Optional but strongly recommended.
- `root`: the root node.

A node is an object with a `type` and that component's props beside it:

- `type`: a component from the catalog.
- props: the component's own properties, directly on the node.
- `children`: an array of nodes, nested inline. Only containers (`card`, `stack`, `row`, `section`) take children.
- `actions`: on `card` only, an array of up to 3 `button` nodes for the footer.
- `id`: optional on any node. A stable name matching `^[A-Za-z0-9_-]{1,64}$`, unique in the document. Use it on a node a later edit or action needs to refer to.

The document is plain nesting because that is the shape models write most
reliably. Stable keys for streaming and patching are assigned by the
compiler in the render document (see `RENDER.md`), not by the author.

Limits: 200 nodes, depth 6, 256 KiB.

## Catalog

19 components. Each has a page in `components/`.

| Group | Components |
|---|---|
| Containers | `card`, `stack`, `row`, `section` |
| Content | `text`, `badge`, `stat`, `keyvalue`, `callout`, `code` |
| Data | `chart`, `table`, `list`, `steps`, `progress` |
| Media | `gallery`, `image` |
| Input | `button`, `choices` |

Shared value types, defined in `catalog.json` under `definitions`:

- `tone`: a semantic tone, `neutral`, `accent`, `success`, `warning` or `danger`, or a colour name.
- `color`: one of 12 colour names, `red`, `orange`, `yellow`, `green`, `teal`, `cyan`, `blue`, `indigo`, `purple`, `pink`, `brown`, `gray`. The shared theme owns each hue.
- `icon`: one of 39 names, each drawn from the shared icon set in `icons/`.
- `image`: `{ src, alt }`.
- `badge`: `{ text, tone?, icon? }`.
- `action`: `message`, `open`, `copy` or `tool`.

The vocabulary is closed. A document cannot define components, and has no
props for colour values, size in points, font, padding or alignment.

## Rules for renderers

**1. Never fail.** Any JSON value is a renderable input. A renderer never
throws, crashes or shows a raw error for a bad document.

| Input | Result |
|---|---|
| Not an object, wrong `genui`, missing `root` | Show `fallback` as text if it is a string, otherwise nothing |
| Element with an unknown `type` | Skip the element and its subtree |
| Unknown prop | Ignore it |
| Prop of the wrong type, or an enum value not in the list | Treat as absent and use the default |
| Missing required prop | Skip the element |
| A child that is not an object | Skip it |
| Depth over the limit | Stop descending |
| Array longer than its maximum | Ignore the extra items |
| Array item of the wrong shape | Drop the item; if the array is then below its minimum, treat the prop as absent |
| A `root` that is itself skipped | Show `fallback` |
| Two nodes with the same `id` | Render both; the `id` refers to the first |
| Children on a component that takes none | Ignore them |

Validation is strict; rendering is lenient. `genui.schema.json` rejects
everything in this table, so authors and tools catch mistakes, while a
renderer shows as much as it safely can.

**2. Native, from platform tokens.** Draw with the platform's own components,
type scale, spacing and colour tokens, in light and dark. Tones and colour
names take their colours from the shared theme (`theme.json`), and tone
colours used for text must meet 4.5:1 contrast. Chart series use the shared
chart palette in order unless they name a colour.

**3. Same meaning, platform-appropriate layout.** Layout may change with
width (a table becomes stacked blocks on a phone; buttons stack). Content,
order and emphasis may not. Each component page says what is fixed.

**4. Width.** The root is laid out at the width of the chat column. "Wide"
in component pages means 560pt or more of available width; "phone" means
less.

**5. Text.** Strings are shown as written: no case changes, no reformatting
of numbers, no unit conversion. `text` and `callout.text` accept inline
Markdown (bold, italic, code, links); everything else is plain text.

**6. Images.** `src` is a path relative to the document, naming a file stored
with it; remote URLs are refused in v1. The host resolves and loads it; a renderer reserves the final size first, shows a
tinted placeholder while loading, and keeps the placeholder on failure.

**7. Actions.** A renderer does not execute actions. It reports
`(node, action)` to the host, naming the node by its `id` when it has one and by its path otherwise, which decides what happens.

| Action | Host does |
|---|---|
| `message` | Sends `text` as the user's next message |
| `open` | Opens the URL or path; non-https schemes are refused |
| `copy` | Copies `text` to the clipboard |
| `tool` | Asks to run the named tool with `input`, under the host's normal permission rules |

Actions are untrusted input from the model. A host must apply the same
permission checks as if the model had asked for the action directly, and
must never treat a tap as approval of something the user was not shown.

**8. Accessibility.** Every interactive element is reachable and labelled.
Images expose `alt`. Charts expose a text summary built from their labels and
series. Motion (the active step) respects reduced-motion settings.

## Not in v1

Reserved for later versions; documents must not rely on them.

- Input fields and forms (text field, toggle, select, date) with a submit action.
- Patching a node already on screen by its `id`.
- State binding and conditional visibility.
- `presentation` other than inline (fullscreen, picture-in-picture).

## Versioning

`genui` is bumped only for a change that would make an existing valid
document invalid or change its meaning. Adding a component, an optional prop,
an icon or an enum value does not bump it, which is why renderers must skip
unknown types and ignore unknown props and values.
