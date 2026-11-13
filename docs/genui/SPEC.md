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
- `action`: `message`, `open`, `copy`, `tool`, `secret`, `cluster_secret` or `plugin`.

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
| An action the host cannot run | Draw the element disabled (see rule 7) |

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
less. A document's height follows from its width alone, never from images
loading, theme, taps or scrolling, so a host can reserve it before drawing;
see Measuring in `RENDER.md`.

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
| `message` | Sends `text` as the user's next message to the origin agent |
| `open` | Opens the URL or path; non-https schemes are refused |
| `copy` | Copies `text` to the clipboard |
| `tool` | Reserved: no host runs it yet, so it is drawn disabled |
| `secret` | Happy Agent only. Opens the native secret form prefilled from `secret`, and saves it as described under Secret actions |
| `cluster_secret` | Happy Cloud only. Opens the native cluster secret form prefilled from `secret`, and saves it the same way |
| `plugin` | Opens the page of the plugin `plugin.id`, where the person may install it. The tap itself installs nothing |

Actions are untrusted input from the model. A host must apply the same
permission checks as if the model had asked for the action directly, and
must never treat a tap as approval of something the user was not shown.

**The origin agent** of an action is the agent that wrote the version
holding it: the version's `source.agentId`. Wherever the document is shown,
in its chat, a feed, a vault or a side panel, `message` and the secret
actions go to that agent. When the version names no agent, or that agent is
archived, those actions cannot run: clients draw them disabled and the
server refuses them.

**An action the host cannot run is disabled.** A host that does not know an
action's `type`, does not serve it (a Happy Agent host and `cluster_secret`,
a cluster and `secret`), or has no origin agent for it, draws the button
disabled with its label and a pressable element as not tappable. It never
substitutes another action.

**Action types are versioned by name.** The shape and meaning of an action
type never change. A change an existing host would misread gets a new type
name; adding a type or an optional field does not bump `genui`.

### Secret actions

A secret action lets an agent ask the person for a credential without ever
seeing it. The action holds what the form starts with; the person fills in
the values and may change everything else first.

```json
{
  "type": "secret",
  "secret": {
    "id": "stripe",
    "description": "Stripe test-mode keys for the billing service",
    "variables": [
      { "name": "STRIPE_SECRET_KEY", "description": "Dashboard → Developers → API keys, the secret key" },
      { "name": "STRIPE_WEBHOOK_SECRET" }
    ]
  }
}
```

- `secret` is for Happy Agent's secrets: a named bundle of environment
  variables. `cluster_secret` is for Happy Cloud's typed secrets: its
  `secret` holds the secret `type`, `name`, `description`, the type's
  `public` metadata as the cluster's create request takes it, the suggested
  `uses` and `owner`, and an `id` only to change a secret that exists.
- Neither carries a value. A model never writes one, and a host never
  prefills one.
- The person may change every prefilled field before saving: the name, the
  description, and which variables there are and what they are called. The
  form says whether it creates a secret or changes one.
- When `id` names a secret that exists, the form opens on that secret to
  change it, and a value left empty keeps what is stored. Tapping the same
  button after saving therefore changes the secret just made.
- On save, the client sends the element key and the form to the server in
  one request, never the action itself; the server reads the action from
  the stored render document. In one change it stores the secret, gives the
  origin agent access to it, and tells the origin agent in a message which
  secret was added or changed and its variable names, never its values. The
  agent learns of it then; it does not wait on the tap.
- What the view shows after saving, such as that the secret was added,
  comes from that request's response and stays local to the view.

**8. Accessibility.** Every interactive element is reachable and labelled.
Images expose `alt`. Charts expose a text summary built from their labels and
series. Motion (the active step) respects reduced-motion settings.

## Not in v1

Reserved for later versions; documents must not rely on them.

- Input fields and forms (text field, toggle, select, date) with a submit action. The secret
  actions open a form the host owns; the document still has no inputs.
- Patching a node already on screen by its `id`.
- State binding and conditional visibility.
- `presentation` other than inline (fullscreen, picture-in-picture).

## Versioning

`genui` is bumped only for a change that would make an existing valid
document invalid or change its meaning. Adding a component, an optional prop,
an icon or an enum value does not bump it, which is why renderers must skip
unknown types and ignore unknown props and values.
