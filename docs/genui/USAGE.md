# How to write Gen UI

Use Gen UI when structure helps the reader: numbers to compare, a set of
options to pick from, a list of things with status, a chart, pictures, steps
in progress. Use plain text for explanations and anything a sentence says
well. Do not wrap prose in a card.

## The shape

A document is one tree of nodes.

```json
{
  "genui": 1,
  "fallback": "Deploy of v2.41.0 is running: build and tests passed, database migration in progress.",
  "root": {
    "type": "card",
    "title": "Deploy to production",
    "icon": "bolt",
    "badge": { "text": "In progress", "tone": "accent" },
    "children": [
      { "type": "steps", "items": [
        { "title": "Build image", "status": "done", "time": "1m 08s" },
        { "title": "Run tests", "status": "done", "time": "3m 41s" },
        { "title": "Migrate database", "status": "active" } ] }
    ],
    "actions": [
      { "type": "button", "label": "Pause rollout", "action": { "type": "message", "text": "Pause the rollout" } }
    ]
  }
}
```

Rules that make a document valid:

1. `genui` is `1`. `root` is a node. Every node has a `type`.
2. Props sit directly on the node, beside `type`. Children are nested inline in `children`.
3. Only `card`, `stack`, `row` and `section` have `children`. Only `card` has `actions`, and it holds up to 3 buttons.
4. Use only the props listed for the component. There are no style props.
5. `id` is optional. Add one (`"id": "steps"`) only to a node you expect to update or refer to later.

Always write `fallback`: one or two sentences that carry the same
information, for clients that cannot draw the UI.

## Picking a component

| You want to show | Use |
|---|---|
| A few headline numbers | `row` of 2–3 `stat` |
| A trend or comparison over categories | `chart` (`line`, `area`, `bar`) |
| Parts of a whole | `chart` with `kind: "donut"` |
| Facts about one thing | `keyvalue` |
| Several things with status, each maybe tappable | `list` |
| The same fields for several things | `table` |
| A process with stages | `steps` |
| How far along something is | `progress` |
| Pictures to look at | `gallery` with `layout: "grid"` |
| Options with pictures to choose between | `gallery` with `layout: "carousel"` |
| One picture | `image` |
| A question with 2–8 answers | `choices` |
| One or two next steps | `card` `actions` |
| A warning or note the reader must not miss | `callout` |
| Code or a command | `code` |

Start with a `card` when the content is one thing with a title. Use a `stack`
as the root when a sentence of `text` introduces a `gallery` or `list` and no
frame is needed.

## Writing it well

- **Format values yourself.** `stat.value`, `keyvalue` values and table cells are strings shown exactly as written: write `$1.24M`, `8,412`, `4m 12s`. Round them. Chart `values` are the only raw numbers; give their unit with `format` (`{ "prefix": "$" }`, `{ "suffix": " ms" }`).
- **Say what a change compares to.** Give `stat.delta` a `deltaLabel` such as `vs Q2`.
- **Tone carries meaning, not decoration.** `success` = good, `warning` = needs attention, `danger` = bad or destructive, `accent` = the highlighted item. Leave it out otherwise. When a falling number is good news, set `tone: "success"` with `trend: "down"`.
- **Colour names tell categories apart.** Use `red`, `blue`, `teal` and the other colour names for labels, tags, chart series and calendar-style grouping, where the colour only has to differ. Never use `red` or `green` to mean bad or good: use `danger` or `success`. The exact hue is not guaranteed.
- **Icons must match their label.** If no icon fits, leave it out. Use only names from the catalog.
- **Keep it small.** One idea per card: 2–4 blocks. Three stats, not six. Up to about 8 list rows or table rows; summarise the rest in text. A phone shows roughly one screen.
- **Tables are for comparing.** With more than 3 columns a phone shows each row as a block, so put the name in the first column. For one item's facts use `keyvalue`.
- **Charts need few, round series.** Up to 3 series reads well. Use `emphasis: true` on the one series that matters when the others are context. Labels are short (`Apr`, `Q3`, `api`).
- **Buttons are verbs.** `Review the first one`, not `OK`. At most 3 in a card; the first is the primary. Mark a destructive one with `tone: "danger"`.
- **Actions.** `message` sends text as if the user typed it; write it as a full instruction (`Roll 2.41 out to a 10% canary`), not just the label. `open` opens a link. `copy` copies. `plugin` opens a plugin's page so the person can install it. `tool` is reserved: no host runs it yet, so do not use it.
- **Ask for a credential with `secret`.** Never ask for a key, token or password in text, and never put a value in a document. Give a `secret` button the name, description and variables you need; the person types the values, may change the rest, and you get a message when it is saved. The variables are attached to you from then on. On Happy Cloud the action is `cluster_secret`.
- **Ask with `choices`.** Use `layout: "list"` when options need a line of description, `chips` for short labels. Do not add a button that repeats an option.
- **Images always have `alt`.** Describe what is in the picture.
- **No Markdown blocks.** `text` takes inline Markdown only. Use `section` for a heading, `list` for bullets, `code` for code.
- **Do not nest cards**, and do not put a `section` inside a `section`.

## Common mistakes

| Mistake | Fix |
|---|---|
| A `props` wrapper around the properties | Put props directly on the node |
| `children` on a component that is not a container | Remove them; use the component's own `items` or `options` |
| A hex or CSS colour, `padding`, `width`, `align` and similar | Remove; choose a `tone`, a colour name or a different component |
| A number where a string is required (`"value": 8412`) | Format it: `"value": "8,412"` |
| `chart.series[].values` shorter than `labels` | One value per label |
| An icon name not in the catalog | Pick one from the list or drop it |
| A `button` with no `action` | Every button and option needs an action |
| No `fallback` | Add one |

Full props and behaviour for each component are in `components/<type>.md`;
the exact schema is `genui.schema.json`.
