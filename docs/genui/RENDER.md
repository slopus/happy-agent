# Gen UI: authoring and rendering are two schemas

Status: draft for review. The authoring side (`SPEC.md`, `catalog.json`,
`components/`) is unchanged by this document except where noted at the end.

## The split

| | Authoring document | Render document |
|---|---|---|
| Who writes it | The model | The daemon's compiler, never a model |
| Who reads it | The model (read, edit), validators | Clients only |
| Shape | Nested tree, the easiest form for a model to write | Flat map of keyed elements, for streaming and patching |
| Vocabulary | 19 semantic components (`catalog.json`) | 15 primitives (`render/catalog.json`) |
| Images | `src`: a URL or a relative path | A stored file with width, height and ThumbHash |
| Text | Inline Markdown | Pre-parsed spans |
| Charts | Labels and raw values | Scale, ticks, tick labels and colours already computed |
| May change | Often: new components, new props | Rarely: only when a new drawing capability is needed |

The model only ever sees the authoring document. Model-facing tools read,
write and edit that document and report validation errors against it. They
never list or return the render document.

Clients only ever see the render document. A client implements the 15
primitives and nothing else. Adding or changing an authoring component is a
compiler change in the daemon; no client ships.

## What the daemon does on every write

1. **Validate** the authoring document against `catalog.json`. On failure:
   no version is made and the reasons go back to the model.
2. **Ingest images.** For every image reference:
   - a relative path must be a file of the artifact or vault bundle;
   - a remote URL is refused. The daemon never fetches; images are local
     files only;
   - pixel width, height and a ThumbHash are computed.
   An image that is missing or cannot be decoded fails the write with the
   element key and the reason, so the model can fix or drop it.
3. **Compile** the authoring document to a render document: expand every
   component into primitives by the lowering rules below.
4. **Store both** in the same artifact version, with the compiler version.

There is no reverse conversion: because the authoring document is stored,
reading it back is a plain read. The render document is derived data and can
be thrown away and rebuilt.

That last point is the main operational gain. When the compiler improves (a
better table layout, a fixed chart axis), the daemon recompiles stored
documents and every client shows the improvement without an update. When a
client is too old for the current render version, the daemon can compile for
the version that client asked for.

## Storage

| File | Visible to the model | Served to clients | Content |
|---|---|---|---|
| `index.genui.json` | yes | no | Authoring document |
| files the model added (`assets/...`) | yes | yes | Images referenced by relative path |
| `.genui/render.json` | no | yes | Render document |

A vault does not hold loose files; it holds entities stored as bundles, the
same way artifacts are. A Gen UI item in a vault is therefore one bundle with
exactly the layout above: `index.genui.json`, its images, and the derived
`.genui/render.json`. It goes through the same write pipeline as an artifact.

Limits for a render document: 4000 elements, 4 MiB.

## Render document

```json
{ "genuiRender": 1, "compiler": "1.0.0", "fallback": "...", "root": "card", "viewers": { "gallery": [] }, "elements": { "card": { "type": "box", "props": { "role": "card" }, "children": [] } } }
```

Unlike the nested authoring document, the render document is a flat map of
elements with keys, so it can be streamed and patched element by element.
The compiler assigns the keys: a node's `id` when it has one; otherwise the
first node of a type in document order gets the bare type (`stat`) and later
ones a counter (`stat-2`, `stat-3`), skipping any key an `id` already holds.
Parts are added for the primitives it
expands into (`stat.label`, `stat.value`). Keys are stable across
recompiles of the same document, so an action can be reported against the
authoring node that produced it and a future patch can replace one subtree.

### Primitives

| Primitive | What the client does |
|---|---|
| `box` | Stack children in a column or row. A `role` says what the box is and a `gap` says how its children relate; the platform chooses every distance, surface and radius |
| `grid` | Lay cells out as a table with columns sized together |
| `scroll` | Horizontal snapping row of cards |
| `switch` | Draw the `compact` or the `regular` subtree ; the platform decides where compact ends |
| `text` | Draw spans in the typography its `role` calls for |
| `icon` | Draw one glyph by name |
| `image` | Draw a stored file in a box of a given shape; ThumbHash until loaded; optional overlay text; tap opens the viewer |
| `pill` | Draw a status label |
| `button` | Draw a button and report its action |
| `press` | Make its child tappable and report its action |
| `bar` | Draw a progress bar |
| `marker` | Draw a step marker and its rail |
| `spark` | Draw a sparkline |
| `plot` | Draw a chart from computed ticks, labels and palette indices |
| `code` | Draw a code block with copy |

Exact props are in `render/catalog.json`.

### No dimensions in the render document

The render document carries no sizes: no points, no size steps such as
`sm`/`md`/`lg`, no radius, no padding, no font sizes, weights or ratios. It says what a thing is and how
things relate, and each platform owns the numbers. A card on iOS may be 16pt
padded with a 10pt radius, 12dp with a 16dp radius on Android and 14px on
desktop; the document is the same.

| Prop | Values | The platform decides |
|---|---|---|
| `box.role` | `plain`, `card`, `header`, `actions`, `notice`, `section`, `item` (a list row), `record` (one table row shown as a block on a phone), `tile` (a carousel card), `mosaic` | Padding, surface, border, corner radius, minimum height; the hairline above a `section`; how a `mosaic` arranges its images by count |
| `box.leading` | `none`, `icon`, `thumb`, `number` | Width of the shared leading column of a list |
| `box.gap` | `none`, `inline` (icon beside its text), `tight` (a title and its subtitle), `related` (a label and its value or drawing), `heading` (a heading or question above the blocks it introduces), `labeled` (a caption line above the control it describes, such as a progress bar), `items` (rows of a list), `blocks` (components in a card) | The distance |
| `grid.density` | `table`, `pairs` | Column and row spacing |
| `image.role` | `figure`, `tile`, `thumb`, `cover` | Corner radius, height cap, thumbnail size |
| `icon.role` | `leading`, `inline` | Glyph size |
| `text.role` | `title`, `subtitle`, `heading`, `prompt`, `body`, `note`, `label`, `value`, `delta`, `item`, `detail`, `trailing`, `column`, `rowhead` (the cell that names a table row), `cell`, `number`, `ordinal` (a list position) | Font, size, weight, line height, tabular figures, default colour |
| `text.overflow` | `wrap`, `clamp`, `truncate` | How many lines a clamp is |
| span marks | `strong`, `emphasis`, `code`, `link` | How each is drawn (weight, slant, typeface, underline) |
| `image.shape`, `scroll.shape` | `landscape`, `square`, `portrait` | The exact ratio, carousel card width, how many cards show, peeking, edge bleed |
| `plot` | `kind` only | Chart height and proportions per width, legend placement |
| `button.variant` | `primary`, `secondary`, `plain`, `chip` | Height, padding, fill, typography |
| `tone` | `neutral`, `accent`, `success`, `warning`, `danger`, `muted` | Nothing. The colours are shared, see below |

### Shared colours and icons

Sizes and spacing belong to each platform. Colours and icon glyphs do not:
a chart or a badge must look the same colour on every device, and an icon
name must draw the same picture. Both ship with the spec and every client
imports them instead of using its own palette or icon font.

- **`theme.json`** holds the colours, each as a `light` and a `dark` value
  in `#RRGGBB` or `#RRGGBBAA`.
  - Each tone has three values. `ink` paints icons, bars, sparklines and
    markers. `text` paints text of that tone, including a pill's label; it is
    the ink adjusted to reach 4.5:1 on the card surface. `fill` is the
    background of a pill or a notice.
  - `neutral` ink is the primary text colour, so an untoned icon or progress
    bar is black in light and white in dark.
  - `markers` names the tone of each step status (`done`, `failed`, `active`,
    `pending`).
    Every marker is a circle of one diameter, whatever its status; the
    platform picks that diameter. `done` is a disc filled with the ink and
    the `check` glyph in the card surface colour. `failed` is the same with
    `x`. `active` is a ring in the ink with a centred dot of the ink, half
    the diameter. `pending` is an empty ring in the ink. Ring stroke is the
    same for `active` and `pending`. The rail is always the hairline colour;
    it never takes a status colour.
  - `colors.<name>` are the raw colours (`red`, `orange`, `yellow`, `green`,
    `teal`, `cyan`, `blue`, `indigo`, `purple`, `pink`, `brown`, `gray`), each
    with the same `ink`, `text` and `fill` values as a tone. A document names the colour;
    the exact hue is the theme's and may change without touching documents.
    Anywhere a tone is accepted, a raw colour name is accepted too.
  - `chart.palette` is the series colours. A `plot` colour `N` is
    `palette[(N - 1) % palette.length]`; `"muted"` is `chart.muted`.
    `chart.grid` and `chart.axisLabel` colour the grid lines and tick labels.
  - Surfaces, body text and hairlines are not in the file. They come from
    the host app theme.
- **`icons/`** holds one picture per icon name: `{name}.png` (24 px),
  `{name}@2x.png`, `{name}@3x.png` and the `{name}.svg` they were rendered
  from. Each is a black glyph on a transparent background. A client uses the
  alpha channel as a mask and paints it with the ink colour of the icon's
  tone, at the size its `icon.role` calls for. An unknown name draws nothing. An unknown plot colour name draws as `chart.muted`, so the series is not dropped.
  The glyphs are Lucide (ISC licence, `icons/LICENSE`), pinned in
  `theme.json`.

Rules that settle what three renderers each had to guess:

- **Who gives way in a row.** Text marked `fixed` keeps its natural width; its siblings wrap, clamp or truncate. The compiler marks values, deltas, trailing text and numbers.
- **Rows that must fit.** A row with `wrap: false` stays on one line and its children shrink. A row of up to three stats is compiled this way, so three stats sit side by side on a phone.
- **Alignment in grids** comes from the column only.
- **Leading column.** `leading` is set on the list box and on every row, including compact key/value rows.
- **Defaults for enums** an old client may not know: button `secondary`, shape `landscape`, marker `pending`, plot `line`.
- **A `press` without a valid action** draws its child, not tappable.
- **The image viewer is not an action.** A tap on an image with `viewer` is reported to the host separately as (element key, group, index).
- **A step rail** runs from its marker to the next marker in the same box, across the gap.

The only numbers left are data: an image file's pixel size, a plot's values
and tick values, a sparkline's values, a progress fraction.

What a client no longer needs: a Markdown parser, number formatting and
abbreviation, axis and tick maths, palette assignment, the default-variant
rules for buttons, the table-to-blocks logic, the gallery mosaic rules, image
sizing before load, or any knowledge of the 19 components.

What a client still decides: how each token looks, the real pixel layout,
scrolling and snapping physics, the image viewer, press and disabled states,
motion, accessibility wiring.

### Lowering rules

| Authoring | Render |
|---|---|
| `card` | `box` (`role: card`) of: header `box` row (`icon`, title and subtitle `text`, `pill`), the children, an actions `box` row that wraps |
| `stack` | `box` column |
| `row` | `box` row with `equal` and `wrap` |
| `section` | `box` (`role: section`): heading `text`, children. The platform draws the hairline above it unless it is first |
| `text` | `text` with Markdown parsed into spans |
| `badge` | `pill` |
| `stat` | `box` of label `text`, value `text`, trend `icon`, delta `text`, optional `spark` |
| `keyvalue` | `switch`: compact = `box` rows with hairlines, label leading and value trailing; regular = two-column `grid` |
| `callout` | `box` (`role: notice`, tone) row: `icon`, title and body `text` |
| `code` | `code` |
| `chart` | `plot`, with scale, ticks, formatted labels, palette indices, ready-made `legend` rows and the text summary computed |
| `table` | `switch`: regular = `grid` with header; compact = `grid` when 3 columns or fewer, otherwise a `box` of per-row blocks |
| `list` | `box` with inset hairlines; each row a `box` row of leading element, texts, `pill`, trailing `text`, chevron `icon`; wrapped in `press` when it has an action; `switch` for badge placement |
| `steps` | `box` of rows: `marker`, title and detail `text`, trailing time `text` |
| `progress` | `box`: label and detail `text` row, then `bar` |
| `gallery` grid | `box` (`role: mosaic`) of up to 5 `image` tiles, `overlay` on the last when more exist. All items, drawn or not, with their captions, go in the document's `viewers` group |
| `gallery` carousel | `scroll` of `box` (`role: tile`) cards (`image`, title `text`, `pill`, subtitle `text`), each in a `press` |
| `image` | `image` with `role: figure`, optional caption `text` |
| `button` | `button` with the variant resolved |
| `choices` | prompt `text`, then `press` rows (list) or `chip` `button`s (chips), all in one single-choice group |

`render/examples/small-card.source.genui.json` and
`small-card.render.json` show one document before and after.

## Open questions

1. **Is `plot` the right level?** Charts stay one primitive with the maths
   done, because drawing lines and arcs from generic primitives would need a
   canvas vocabulary. The alternative is for the daemon to render charts to
   SVG or an image; clients get simpler but lose native text, dark mode and
   touch.
2. **Responsiveness is one threshold.** `switch` has two branches, compact
   and regular. A third (tablet, wide desktop side panel) is not modelled.
3. **Primitive count.** 15 primitives against 19 components is not a smaller
   number. The gain is that the primitives are dumb and stable; whether that
   is enough is the thing to judge.

## Effect on the existing spec

- `SPEC.md` "Rules for renderers" was written for clients rendering authoring
  documents. Under this split those rules bind the compiler (never fail,
  skip unknown types, defaults), and clients get the same never-fail rule for
  primitives.
- Each page in `components/` describes behaviour; it now reads as the
  contract the compiled output must meet. The pages are not yet rewritten in
  terms of primitives.
- No change to `USAGE.md`: the model writes exactly what it wrote before.
