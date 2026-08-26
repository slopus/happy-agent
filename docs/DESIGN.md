# Happy design system

This is the authoritative visual specification for web pages and interfaces
designed in Happy's visual language. Use it for temporary pages, prototypes,
product surfaces, and any page the user asks to be built with the Happy design
system.

It is written to be followed literally. Every rule states a name, a number, or a
condition. Where a choice exists, this document makes it for you. If you are a
model generating an interface and you are unsure what something should look
like, the answer is in here; do not invent one.

## 0. How to use this document

**Precedence.** Three contracts apply, in this order:

1. The user's explicit requirements for the page.
2. **This document.** It defines the Happy visual language and interaction
   defaults.
3. The page's own product decisions — content, information architecture, and
   feature set.

**The one-sentence summary.** A Happy-designed page is a quiet, dense, neutral
desktop surface built from flex rows and columns on a 4 px grid, painted from
the design variables in §5, with exactly one accent colour used only where
something is interactive or selected.

**Read at minimum:** §1 (foundation), §2 (surfaces and sizes), §5 (variable
reference), §6 (typography), §11 (states), §16 (anti-patterns), and §18
(checklist). §17 is a complete working baseline you can copy verbatim.

---

## 1. Foundation

### 1.1 The design-variable contract

The variables in §5 are the complete visual vocabulary. A page may receive
them from its surrounding product, or define them itself from the fallback
values in §5.4. Components consume variables and never depend on a particular
framework, runtime, or container.

Layout comes from CSS, not JavaScript measurements. Use flexbox, intrinsic
sizing, and container queries. Do not read a width once at startup and build a
fixed layout from it; the page must remain correct as its container changes.

The first paint must already be complete and legible. Declare the §5.4 fallback
block synchronously in the first stylesheet so the page never flashes unstyled
while scripts, data, or an outer product initialize.

### 1.2 The theme can change at any moment

The resolved appearance can change at any moment because the operating system,
the containing product, or the user changes between light and dark. The page
must repaint without remounting or reloading.

This has one hard consequence:

> **Every colour in your page must be a `var(--…)` reference that resolves through
> the design variables.** A colour you computed once in JavaScript, baked into a
> generated SVG, or hard-coded in a class name will be wrong the moment the theme
> changes, and there will be no second chance to fix it.

Corollaries:

- Do not read a variable with `getComputedStyle` and store the value.
- Do not branch on a theme name in JavaScript to pick a colour. Let CSS do it.
- Do not scatter `@media (prefers-color-scheme: …)` colour overrides through
  components. Define the variables once and let every component consume them.
- **Do not write component rules keyed on `[data-theme]`.** The variables already
  encode the difference. If a fallback needs two values, express it with
  `light-dark()`.
- `light-dark()` **is** safe when `color-scheme: light dark` is set on `:root`.
  This is the recommended way to write a fallback (§5.4).

### 1.3 What this system does not provide

- Font files, component CSS, framework classes, or icon fonts.
- A component library. Build the small primitives in §9 from semantic HTML and
  the documented variables.
- Any variable outside the documented sets. Do not guess at names such as
  `--happy-sidebar-width`; they do not exist.

### 1.4 Page content is not browser or operating-system chrome

If a page appears inside another product, that product already draws its own
window frame and global navigation. If it is standalone, the browser still owns
its title bar and window controls.

**Do not imitate outer chrome.** Specifically, never render:

- A window title bar, traffic-light buttons, or a drag region.
- A duplicate browser title bar across the top of the document.
- A close, minimise, maximise, reload, or "open in new window" control.
- A navigation rail that imitates the surrounding product's global features.
- A backdrop or scrim covering the whole viewport for a "modal" that is really
  the whole page.

You _may_ render a toolbar or a header **for the page's own content** — a list's
filter row, a document's breadcrumb — as long as it reads as part of the
content, not as a second window frame. See §9.6.

---

## 2. Surfaces, dimensions, and gutters

Happy is desktop-first. Build one dense desktop layout that remains usable in a
narrow panel; do not introduce a separate mobile visual language, hamburger
navigation, or bottom tab bar.

### 2.1 The three surface shapes

| Surface        | Typical use                              | Width                         | Height ownership |
| -------------- | ---------------------------------------- | ----------------------------- | ---------------- |
| Full page      | Temporary page, product view, dashboard  | the browser or product region | the viewport     |
| Embedded panel | Card, preview, or bounded content region | the containing column         | the content      |
| Dialog/overlay | One focused decision or bounded workflow | `min(920px, viewport − 48px)` | the viewport     |

Design one layout that works across those sizes. Surface differences should
change only height ownership, gutters, and optional column collapse—not the
page's identity or interaction model.

### 2.2 Embedded content — the content owns its height

An embedded panel sizes to its content. Do not set `height: 100%`, `100vh`, or
`min-height: 100vh` on `html` or `body`. When the embedding context imposes a
maximum height, give the content one explicit internal scrollport (§4.4).

### 2.3 Full page and overlay — the viewport owns the height

The document fills the available region and manages its own overflow.

```css
html,
body {
    height: 100%;
    margin: 0;
}
#root {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
}
```

### 2.4 The smallest size you must survive

Desktop panels can become narrow even in a large window. The honest floor is:

> **A Happy-designed page must remain usable and unbroken at 400 × 360 CSS pixels, and
> must look correct at 640 × 480 and above.**

Design the primary layout for **640–1180 px** wide. Below 640 px, collapse
optional columns; do not introduce a different design.

### 2.5 Gutters

The document supplies its own gutter:

| Context                                   | Gutter (padding) |
| ----------------------------------------- | ---------------- |
| Embedded panel, outer edge                | **12 px**        |
| Full page / overlay, outer edge           | **16 px**        |
| Wide page (≥ 900 px), outer edge          | **24 px**        |
| Inside a card                             | **16 px**        |
| Inside a card in a dense card grid        | **12 px**        |
| Inside a compact list row                 | **8 px 12 px**   |
| Between a section heading and its content | **8 px**         |

Never use an outer gutter larger than 24 px. Never use 0 — content must not
touch the frame edge.

If your content has a natural reading width, cap the _inner_ measure and centre
it; keep the scroll container full-bleed (§4).

```css
.page-measure {
    width: 100%;
    max-width: 720px;
    margin-inline: auto;
}
```

---

## 3. The grid: 4 / 8 / 16

The scale applies to **layout spacing**: the `gap` between siblings, the padding
of a container around its children, the page gutter, and the space between
blocks. Every such value is one of:

| Value | Use                                                     |
| ----- | ------------------------------------------------------- |
| 4 px  | Tight vertical pairs, chip-to-chip                      |
| 8 px  | **The default gap.** Between controls, between cards    |
| 12 px | Between a row's columns, between fields in a dense form |
| 16 px | Between content blocks, card padding, page gutter       |
| 24 px | Between major sections, wide page gutter                |
| 32 px | Around an empty state, above a page's first section     |
| 48 px | Rare; vertical breathing room in a nearly empty page    |

**Control internals are not on this scale.** The padding inside a button, the
gap between a button's icon and its label, the padding inside an input, the
height of a chip — these are fixed per component in §9 and are whatever number
makes the component's declared height come out exactly right. Copy them from §9
verbatim; do not "correct" a `padding: 0 14px` to `0 16px`.

Rules:

- `0` is always allowed, and is the right answer more often than it looks: a
  stacked pair of text lines is separated by its line boxes, not by a `gap`, and a
  hairline-separated list uses `gap: 0` (§8). Anything greater than zero is one of
  the seven values above.
- Every length is a whole number of CSS pixels. Never use `em`/`rem` for spacing,
  and never a fractional pixel.
- 1 px is for hairline borders. 2 px is for a focus ring and its offset.
- Border-box everywhere: `*, *::before, *::after { box-sizing: border-box; }`.
- A declared size must be the rendered size. If a row promises 36 px, its
  padding, border, and line height must add to 36 px.
- Prefer integer positions so 1 px borders stay crisp at 2× device scale.

---

## 4. Layout: flexbox, and scrolling

### 4.1 Flexbox is the default

Use flexbox for every row, column, stack, toolbar, list, and centred box.

```css
.row {
    display: flex;
    align-items: center;
    gap: 8px;
}
.column {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.center {
    display: flex;
    align-items: center;
    justify-content: center;
}
```

Use CSS Grid **only** for a genuine two-dimensional grid of related tracks: a
data table's cells, or a media matrix with equal row and column tracks. When you
do, put a comment beside the declaration explaining the geometry flexbox cannot
express.

Never use floats, `inline-block` spacing hacks, layout tables, or absolute
positioning for layout. Absolute positioning is for overlays, popovers, and
badges that intentionally leave the flow.

### 4.2 The parent owns the spacing

Spacing between siblings belongs to the flex parent, via `gap`. A child never
gives itself an external margin to separate itself from a sibling it does not
know about.

```css
/* Correct */
.toolbar {
    display: flex;
    gap: 8px;
}
.toolbar > * {
    margin: 0;
}

/* Wrong */
.toolbar-button + .toolbar-button {
    margin-left: 8px;
}
.toolbar-button:not(:last-child) {
    margin-right: 8px;
}
```

**The one legitimate margin** is `margin-inline-start: auto` on a flex child, to
push it and everything after it to the far end of the row. That is positioning,
not spacing, and it is the correct idiom — do not simulate it with a spacer
element, and do not reach for `justify-content: space-between`, which spreads
_every_ child rather than only the tail.

```css
/* Preferred: let the middle column absorb the slack. */
.toolbar-title {
    flex: 1 1 auto;
    min-width: 0;
}
/* Or push the tail explicitly when there is no such column. */
.toolbar-count {
    margin-inline-start: auto;
}
```

A conditional child must live in the same flex flow as its neighbours. When it is
absent it contributes neither a box nor a gap; when it appears, the parent's
`gap` separates it on both sides automatically. Do not wrap optional content in a
nested div that creates its own spacing island.

### 4.3 A flex child that can shrink needs `min-width: 0`

This is the single most common layout bug. A flex item's default minimum size is
its content, so long text pushes its siblings out of the row instead of
ellipsizing.

```css
.row-main {
    flex: 1 1 auto;
    min-width: 0;
} /* the column that may shrink */
.row-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.row-aside {
    flex: none;
} /* fixed-size trailing content */
```

The same applies vertically: a flex child that contains a scroll area needs
`min-height: 0`.

### 4.4 Scrolling

Exactly **one** element in a full-page layout owns vertical scrolling. It fills
the region its parent gives it and has **zero padding and zero margin** — its
viewport and scrollbar run edge to edge. All spacing, maximum widths, and
centring belong to an inner wrapper.

```css
.scrollport {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    /* no padding, no margin */
}
.scrollport-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
}
```

Rules:

- Never put `overflow: auto` on `<body>` in a full-page surface; give it to the
  designated scrollport so the header and footer stay fixed.
- Never nest scroll areas on the same axis. Two vertical scrollbars in one view
  is a defect.
- Horizontal scrolling is allowed only for a wide data table, and only on the
  table's own container.
- Keep the full painted extent of a focus ring inside the content wrapper's
  padding, so scrolling cannot clip it. A 2 px ring with a 2 px offset needs at
  least 4 px of clearance — the 16 px gutter covers it.
- Style the scrollbar with the design-system thumb colour, or leave it native. Do not hide
  it.

```css
.scrollport {
    scrollbar-width: thin;
    scrollbar-color: var(--happy-scrollbar-thumb, rgb(150 150 150 / 0.4)) transparent;
}
```

### 4.5 Responsive behaviour inside a desktop panel

Respond to the **container**, not the viewport, and only to collapse or reflow —
never to switch to a different design.

```css
.page {
    container-type: inline-size;
}

/* Below 640px the metadata column folds under the main column. */
@container (max-width: 640px) {
    .split {
        flex-direction: column;
    }
    .split-aside {
        width: 100%;
    }
}
```

Permitted responses to a narrow container, in order of preference:

1. Let a flex row wrap (`flex-wrap: wrap`) at a documented gap.
2. Hide a genuinely secondary column (never the primary action).
3. Reduce a 3-column card grid to 2, then 1.
4. Swap a side-by-side label/field pair to stacked.

Forbidden: hiding the primary action, replacing the layout with a "mobile" one,
introducing a hamburger menu, shrinking type below the minimums in §6.

---

## 5. Colour: the complete variable reference

**Every colour in your page comes from this section.** A raw hex value, named
colour, or `rgb()` literal in your CSS is a defect, with exactly one exception:
the fallback inside `var(--x, fallback)` (§5.4).

The two schemes are Happy's: light is white and `#f5f5f5` neutrals with black
primary actions; dark is a `#1e1e1e` canvas with `#212121` surfaces and, again,
black primary actions. You never write those values — they are given here only so
you can predict what a variable will look like.

### 5.1 Core variables — colour

Define these on `:root`, either directly or through the fallback mapping in
§5.4. They are the shared colour roles for every Happy-designed page.

| Variable                       | Meaning in Happy                                                       | Light         | Dark          |
| ------------------------------ | ---------------------------------------------------------------------- | ------------- | ------------- |
| `--color-background-primary`   | The surface a card or page body sits on                                | `#ffffff`     | `#212121`     |
| `--color-background-secondary` | A recessed panel: table head, sidebar, code well                       | `#f8f8f8`     | `#171717`     |
| `--color-background-tertiary`  | A pressed/active fill, or a deeper inset                               | `#f0f0f2`     | `#2c2c2e`     |
| `--color-background-inverse`   | The primary-action fill (black in both schemes)                        | `#000000`     | `#000000`     |
| `--color-background-ghost`     | Hover wash over any surface (translucent)                              | 8 % black     | 8 % white     |
| `--color-background-info`      | Soft informational fill (12 % accent over surface)                     | pale blue     | dim blue      |
| `--color-background-success`   | Soft success fill (14 % green over surface)                            | pale green    | dim green     |
| `--color-background-warning`   | Soft warning fill                                                      | `#fff8f0`     | 15 % orange   |
| `--color-background-danger`    | Soft error fill                                                        | `#fff0f0`     | 15 % red      |
| `--color-background-disabled`  | A disabled control's fill                                              | `#f0f0f2`     | `#2c2c2e`     |
| `--color-text-primary`         | Body and heading text                                                  | `#000000`     | `#ffffff`     |
| `--color-text-secondary`       | Supporting text, labels, captions                                      | `#49454f`     | `#cac4d0`     |
| `--color-text-tertiary`        | Metadata, timestamps, counts: 70 % of secondary over the surface       | `#807d84`     | `#97939c`     |
| `--color-text-inverse`         | Text on `--color-background-inverse`                                   | `#ffffff`     | `#ffffff`     |
| `--color-text-ghost`           | Text on a ghost/hover fill                                             | `#49454f`     | `#cac4d0`     |
| `--color-text-info`            | Informational text and the accent for text                             | `#007aff`     | `#0a84ff`     |
| `--color-text-success`         | Success text                                                           | `#34c759`     | `#32d74b`     |
| `--color-text-warning`         | Warning text                                                           | `#ff9500`     | `#ffab00`     |
| `--color-text-danger`          | Destructive/error text                                                 | `#f44336`     | `#f48fb1`     |
| `--color-text-disabled`        | Disabled label: 45 % of secondary over the surface                     | `#adabb0`     | `#6d6a70`     |
| `--color-border-primary`       | **The default hairline.** Card, row, input border                      | `#eaeaea`     | `#292929`     |
| `--color-border-secondary`     | The one divider stronger than the hairline: 20 % text over the surface | `#cccccc`     | `#4d4d4d`     |
| `--color-border-tertiary`      | Identical to primary. Use primary.                                     | `#eaeaea`     | `#292929`     |
| `--color-border-inverse`       | Border on an inverse fill                                              | `#000000`     | `#000000`     |
| `--color-border-ghost`         | `transparent`, for a border that only reserves space                   | `transparent` | `transparent` |
| `--color-border-info`          | Informational outline                                                  | `#007aff`     | `#0a84ff`     |
| `--color-border-success`       | Success outline                                                        | `#34c759`     | `#32d74b`     |
| `--color-border-warning`       | Warning outline                                                        | `#ff9500`     | `#ff9f0a`     |
| `--color-border-danger`        | Error outline                                                          | `#f44336`     | `#f48fb1`     |
| `--color-border-disabled`      | Disabled control outline                                               | `#eaeaea`     | `#292929`     |
| `--color-ring-primary`         | **The focus ring and the interactive accent**                          | `#007aff`     | `#0a84ff`     |
| `--color-ring-secondary`       | A neutral ring, the secondary text colour                              | `#49454f`     | `#cac4d0`     |
| `--color-ring-inverse`         | Ring against an inverse fill                                           | `#000000`     | `#000000`     |
| `--color-ring-info`            | Same as ring-primary                                                   | `#007aff`     | `#0a84ff`     |
| `--color-ring-success`         | Success ring                                                           | `#34c759`     | `#32d74b`     |
| `--color-ring-warning`         | Warning ring                                                           | `#ff9500`     | `#ff9f0a`     |
| `--color-ring-danger`          | Error ring                                                             | `#f44336`     | `#f48fb1`     |

### 5.2 Core variables — type, shape, elevation

| Variable                                                   | Value                      | Use                                       |
| ---------------------------------------------------------- | -------------------------- | ----------------------------------------- |
| `--font-sans`                                              | Happy's UI stack           | All interface text                        |
| `--font-mono`                                              | Happy's mono stack         | Code, IDs, hashes, log output             |
| `--font-weight-normal` / `-medium` / `-semibold` / `-bold` | 400 / 500 / 600 / 700      | See §6                                    |
| `--font-text-xs-size` / `-line-height`                     | 11 / 16 px                 | Micro-labels, table column heads          |
| `--font-text-sm-size` / `-line-height`                     | 12 / 18 px                 | Captions, metadata, chips                 |
| `--font-text-md-size` / `-line-height`                     | 14 / 20 px                 | **Body default**                          |
| `--font-text-lg-size` / `-line-height`                     | 16 / 24 px                 | Lead paragraph, prominent value           |
| `--font-heading-xs-size` / `-line-height`                  | 13 / 18 px                 | Section label                             |
| `--font-heading-sm-size` / `-line-height`                  | 15 / 20 px                 | Card title, row title                     |
| `--font-heading-md-size` / `-line-height`                  | 17 / 22 px                 | Page title on a small surface             |
| `--font-heading-lg-size` / `-line-height`                  | 20 / 26 px                 | Page title                                |
| `--font-heading-xl-size` / `-line-height`                  | 24 / 30 px                 | Rare; a landing or empty-state headline   |
| `--font-heading-2xl-size` / `-line-height`                 | 28 / 34 px                 | Do not use in a product interface         |
| `--font-heading-3xl-size` / `-line-height`                 | 34 / 40 px                 | Do not use in a product interface         |
| `--border-radius-xs`                                       | 6 px                       | Chips, small inputs                       |
| `--border-radius-sm`                                       | 6 px                       | **Controls: buttons, inputs, menu items** |
| `--border-radius-md`                                       | 8 px                       | **Content blocks, wells, list rows**      |
| `--border-radius-lg`                                       | 10 px                      | **Cards**                                 |
| `--border-radius-xl`                                       | 14 px                      | Large shells and dialog-like panels       |
| `--border-radius-full`                                     | 999 px                     | Pills, avatars, progress tracks           |
| `--border-width-regular`                                   | 1 px                       | Every hairline                            |
| `--shadow-hairline`                                        | `0 0 0 1px <hairline>`     | A ring instead of a border                |
| `--shadow-sm`                                              | `0 1px 2px <10 % black>`   | A card lifted off the surface             |
| `--shadow-md`                                              | `0 4px 12px <24 % black>`  | A popover or dropdown                     |
| `--shadow-lg`                                              | `0 12px 32px <45 % black>` | An in-app dialog                          |

### 5.3 Supplemental Happy variables: `--happy-*`

These are the roles the core vocabulary has no key for. Define them alongside
the core variables; they follow appearance changes in exactly the same way.

| Variable                      | Meaning                                                             | Light      | Dark       |
| ----------------------------- | ------------------------------------------------------------------- | ---------- | ---------- |
| `--happy-canvas`              | The page canvas **behind** cards; use when your page is a card list | `#f5f5f5`  | `#1e1e1e`  |
| `--happy-header-background`   | A content header strip's fill (your own, not the outer shell's)     | `#ffffff`  | `#212121`  |
| `--happy-header-text`         | Text on that strip                                                  | `#18171c`  | `#ffffff`  |
| `--happy-selected-background` | The fill of a **selected** row or tab                               | `#eaeaea`  | `#2c2c2e`  |
| `--happy-link`                | Hyperlink text (Happy teal, identical in both schemes)              | `#2baccc`  | `#2baccc`  |
| `--happy-input-background`    | A text field's fill                                                 | `#f5f5f5`  | `#303030`  |
| `--happy-input-text`          | A text field's value                                                | `#000000`  | `#ffffff`  |
| `--happy-input-placeholder`   | A text field's placeholder                                          | `#999999`  | `#8e8e93`  |
| `--happy-code-background`     | The code/diff/log surface                                           | `#f6f8fa`  | `#161b22`  |
| `--happy-scrim`               | Backdrop behind an in-app overlay you own                           | 48 % black | 48 % black |
| `--happy-scrollbar-thumb`     | Custom scrollbar thumb                                              | 40 % grey  | 40 % grey  |
| `--happy-shadow-color`        | The base elevation tint, for a shadow you compose yourself          | 10 % black | 10 % black |

No other `--happy-*` name exists. If you need a role that is not listed, build
it from the documented ones with `color-mix`:

```css
/* A 12% accent wash for a selected-and-focused row. */
background: color-mix(in srgb, var(--color-ring-primary) 12%, var(--color-background-primary));
```

### 5.4 Fallbacks: declare them once, in one place

Every design variable can be absent when a page starts as a standalone document
or is viewed in a bare browser tab. Declare a fallback for each variable you use
**exactly once**, in a `:root` block that maps design-system names to the page's
own short names. Downstream CSS then uses the short names with no fallbacks.

```css
:root {
    /* Standalone documents follow the OS. A containing product may set an
       explicit color-scheme, and `light-dark()` follows that decision. */
    color-scheme: light dark;

    --app-surface: var(--color-background-primary, light-dark(#ffffff, #212121));
    --app-raised: var(--color-background-secondary, light-dark(#f8f8f8, #171717));
    --app-canvas: var(--happy-canvas, light-dark(#f5f5f5, #1e1e1e));
    --app-text: var(--color-text-primary, light-dark(#000000, #ffffff));
    --app-muted: var(--color-text-secondary, light-dark(#49454f, #cac4d0));
    --app-border: var(--color-border-primary, light-dark(#eaeaea, #292929));
    --app-accent: var(--color-ring-primary, light-dark(#007aff, #0a84ff));
    --app-radius-control: var(--border-radius-sm, 6px);
    --app-radius-card: var(--border-radius-lg, 10px);
    --app-font: var(--font-sans, system-ui, -apple-system, sans-serif);
    --app-mono: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
}
```

Two rules about this block:

- **Never alias a variable to itself.** `--happy-canvas: var(--happy-canvas, #f5f5f5)`
  is a cycle; the property becomes invalid and everything using it falls back to
  its initial value. Always map a design name to a _different_ local name.
- **Never repeat a fallback downstream.** `background: var(--app-surface)` — not
  `var(--app-surface, #fff)`. One place to change, one place to be wrong.
- The component snippets in §9 write `var(--design-name, fallback)` inline so each
  one can be read and copied on its own. That is a documentation convenience, not
  the pattern. When you assemble a page, alias every design variable you use in the
  `:root` block once — §17's block is the complete list — and rewrite the §9
  snippets to use your local names with no fallback.

### 5.5 Contrast

- Body text on any surface: at least **4.5 : 1**.
- Text at 18 px+ or 14 px+ bold, and any non-text indicator (borders that carry
  meaning, focus rings, chart strokes): at least **3 : 1**.
- The documented variables satisfy this for the documented pairings — primary
  and secondary text on primary/secondary/tertiary backgrounds. If you invent a
  pairing with `color-mix`, measure it.
- Never put `--color-text-tertiary` or `--color-text-disabled` on anything other
  than `--color-background-primary` or `--color-background-secondary`.
- Never rely on colour alone. A status must also carry a word or a glyph.

---

## 6. Typography

### 6.1 Families

```css
body {
    font-family: var(--app-font);
}
code,
pre,
.mono {
    font-family: var(--app-mono);
}
```

`--font-sans` resolves to Happy's UI stack and `--font-mono` to its code stack.
The font _files_ are not available to your origin, so the stack ends in system
fonts; that is expected and correct. Do **not** load a web font, do not use
`@import url(https://fonts.googleapis.com/…)`, and do not embed a font as a data
URL. A page that ships its own typeface looks foreign and adds an unnecessary
network request.

Set `font-synthesis: none` on `body` so a missing weight is not faked.

### 6.2 The scale

Use these seven roles and nothing else. Always set `font-size` and `line-height`
together, both from the same row.

| Role          | Size / line height | Weight | Colour                   | Use                                   |
| ------------- | ------------------ | ------ | ------------------------ | ------------------------------------- |
| Page title    | 20 / 26 px         | 600    | `--color-text-primary`   | One per document, at most             |
| Section title | 15 / 20 px         | 600    | `--color-text-primary`   | Card and group headings               |
| Section label | 13 / 18 px         | 600    | `--color-text-secondary` | Small caps-free group label           |
| Body          | 14 / 20 px         | 400    | `--color-text-primary`   | **The default for everything**        |
| Row title     | 14 / 20 px         | 500    | `--color-text-primary`   | The first line of a list row          |
| Body strong   | 14 / 20 px         | 600    | `--color-text-primary`   | A value being emphasised in prose     |
| Caption       | 12 / 18 px         | 400    | `--color-text-secondary` | Secondary line under a title          |
| Micro         | 11 / 16 px         | 500    | `--color-text-tertiary`  | Table column heads, chip text, counts |

- **11 px is the absolute minimum.** Never render text smaller.
- Weight vocabulary is 400, 500, 600 only. Do not use 700 in an interface; do not
  use 300 or lighter.
- Do not use `text-transform: uppercase` on anything longer than a three-word
  label, and never with letter-spacing above `0.04em`.
- `letter-spacing: -0.01em` is permitted on the page title and section title.
  Nowhere else.
- Never justify text. Never centre a paragraph. Centre only a single-line label
  inside a control or an empty state.

### 6.3 Long text

```css
.truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.wrap-anywhere {
    overflow-wrap: anywhere;
} /* URLs, IDs, file paths */
.clamp-2 {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
}
```

Every single-line title in a row or card must truncate, and its flex parent must
carry `min-width: 0` (§4.3). Text that can contain an unbroken token — a URL, a
hash, a path — must use `overflow-wrap: anywhere` or truncate; it must never
widen its container.

### 6.4 Numbers

Right-align numeric table columns and use tabular figures so digits line up:

```css
.num {
    font-variant-numeric: tabular-nums;
    text-align: right;
}
```

Format dates, times, and numbers with `Intl`, using the requested locale and time
zone when the page has them, otherwise the browser's resolved defaults. Never
hard-code `MM/DD/YYYY` or a currency symbol.

---

## 7. Surfaces, borders, radii, shadows

### 7.1 Choosing a background

| You are painting                                  | Background                     |
| ------------------------------------------------- | ------------------------------ |
| The document, when the content **is** the surface | `--color-background-primary`   |
| The document, when it holds a list of cards       | `--happy-canvas`               |
| A card on the canvas                              | `--color-background-primary`   |
| A recessed panel: table header, sidebar, well     | `--color-background-secondary` |
| A code, log, or diff block                        | `--happy-code-background`      |
| A hovered row                                     | `--color-background-ghost`     |
| A selected row or active tab                      | `--happy-selected-background`  |
| A pressed control                                 | `--color-background-tertiary`  |
| A text input                                      | `--happy-input-background`     |

Default to the first row. Painting the outer document
`--color-background-primary` creates one quiet continuous surface. Reach for
`--happy-canvas` only when you genuinely have separated cards.

### 7.2 Borders

One hairline, everywhere: `1px solid var(--color-border-primary)`.

- Prefer a border over a shadow to separate things. Happy is a flat, quiet system.
- A card gets a border **or** `--shadow-sm`, never both.
- Between list rows use `border-bottom` on each row except the last, or better, a
  flex `gap` with no border at all.
- To reserve space for a border that appears on hover or selection, use
  `--color-border-ghost` (transparent) rather than a margin that shifts on hover.

### 7.3 Radii

| Element                                      | Radius                    |
| -------------------------------------------- | ------------------------- |
| Button, input, select, menu item, small chip | `--border-radius-sm` (6)  |
| List row, content block, code well           | `--border-radius-md` (8)  |
| Card                                         | `--border-radius-lg` (10) |
| A large panel or in-app dialog               | `--border-radius-xl` (14) |
| Pill, avatar, progress track                 | `--border-radius-full`    |

**Nested corners must be true parallel curves.** When a child's edge sits in a
rounded corner of its parent:

```
inner radius = max(0, outer radius − inset)
```

`inset` is the real distance between the two border-box edges — the parent's
border plus its padding. A 10 px card with a 1 px border and 12 px padding gives
a child sitting in the corner a radius of `max(0, 10 − 13) = 0`. A header strip
flush inside that card (1 px inset, no padding) gets `10 − 1 = 9 px`.

If the horizontal and vertical insets differ, do not compromise — change the
layout so they match.

### 7.4 Shadows

Use a shadow only for something that genuinely floats above the page:

| Thing                        | Shadow                 |
| ---------------------------- | ---------------------- |
| A card resting on the canvas | none, or `--shadow-sm` |
| A dropdown, popover, tooltip | `--shadow-md`          |
| An in-app dialog you own     | `--shadow-lg`          |

Never put a shadow on a button, input, row, chip, badge, or table. Never write a
shadow with your own colour; if you must compose one, tint it with
`--happy-shadow-color`.

---

## 8. Density and rhythm

Happy is an information-dense desktop tool, not a marketing page.

| Element                                             | Height    |
| --------------------------------------------------- | --------- |
| Small button / chip / compact control               | **28 px** |
| Default button, input, select                       | **36 px** |
| Large button (a page's main action)                 | **44 px** |
| Compact list row (one line)                         | **32 px** |
| Standard list row (title + caption)                 | **44 px** |
| List row with a ≥ 20 px glyph, avatar, or thumbnail | **56 px** |
| Table header row                                    | **32 px** |
| Table body row                                      | **36 px** |
| Your own content toolbar                            | **48 px** |
| Your own content header strip                       | **56 px** |

Additional rules:

- A vertical list of rows uses `gap: 0` with hairline separators, or `gap: 8px`
  with bordered rows. Not both.
- Never exceed 24 px of vertical space between a heading and its content.
- Never centre a whole page's content vertically, except an empty state (§11.1).
- Never use a hero band, a full-bleed illustration, or a decorative gradient.
- Icons in rows and buttons are **16 px**; in a page title, **20 px**; in an empty
  state, **32 px**. Nothing else.

---

## 9. Components

Build each of these from plain HTML plus the variables. Do not add a component
library, a CSS framework, or a design-token package.

### 9.1 Buttons

Three variants, plus one destructive modifier of Secondary:

| Variant   | Fill                         | Text                     | Border                             | When                                                                                 |
| --------- | ---------------------------- | ------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------ |
| Primary   | `--color-background-inverse` | `--color-text-inverse`   | none                               | One per view, the main action                                                        |
| Secondary | `--color-background-primary` | `--color-text-primary`   | `1px solid --color-border-primary` | Everything else                                                                      |
| Ghost     | `transparent`                | `--color-text-secondary` | none                               | Toolbar and row-level actions                                                        |
| Danger    | `transparent`                | `--color-text-danger`    | `1px solid --color-border-danger`  | Only the confirming button of a destructive action, and never more than one per view |

A destructive action is never the Primary variant — a black filled button is the
safe default action, and the delete must not be the thing the eye lands on first.

```css
.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 36px;
    padding: 0 14px;
    flex: none;
    font: inherit;
    font-size: 14px;
    line-height: 20px;
    font-weight: 500;
    border: 1px solid transparent;
    border-radius: var(--app-radius-control);
    background: transparent;
    color: var(--app-text);
    cursor: pointer;
    user-select: none;
    transition:
        background-color 120ms ease,
        border-color 120ms ease;
}
.btn:disabled {
    cursor: default;
    background: var(--color-background-disabled);
    color: var(--color-text-disabled);
    border-color: transparent;
}
.btn:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
}

.btn-primary {
    background: var(--color-background-inverse);
    color: var(--color-text-inverse);
}
.btn-secondary {
    background: var(--app-surface);
    border-color: var(--app-border);
}
.btn-secondary:hover:not(:disabled) {
    background: var(--color-background-ghost);
}
.btn-ghost {
    color: var(--app-muted);
    padding: 0 10px;
}
.btn-ghost:hover:not(:disabled) {
    background: var(--color-background-ghost);
    color: var(--app-text);
}
.btn-danger {
    background: transparent;
    color: var(--color-text-danger);
    border-color: var(--color-border-danger);
}
```

- Small button: `height: 28px; padding: 0 10px; font-size: 12px;`.
- Large button: `height: 44px; padding: 0 20px; font-size: 15px;`.
- An icon-only button is square: 28×28 or 36×36, and **must** have `aria-label`.
- Button labels are sentence case, verb first: "Add item", not "ADD ITEM" or
  "Add Item".
- Never a gradient fill, never a coloured shadow, never a full-width button
  unless the container is narrower than 320 px.

### 9.2 Inputs and forms

```css
.field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.field-label {
    font-size: 12px;
    line-height: 18px;
    font-weight: 500;
    color: var(--app-muted);
}
.input {
    height: 36px;
    padding: 0 10px;
    width: 100%;
    font: inherit;
    font-size: 14px;
    line-height: 20px;
    color: var(--happy-input-text, var(--app-text));
    background: var(--happy-input-background, var(--app-raised));
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius-control);
}
.input::placeholder {
    color: var(--happy-input-placeholder, var(--app-muted));
}
/* A field keeps its border when focused and draws the ring just inside its own
   edge, so there is no 3px halo gap between the two. Buttons, which have no
   filled edge to preserve, use the outward 2px offset instead. */
.input:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: -1px;
}
.input[aria-invalid="true"] {
    border-color: var(--color-border-danger);
}
textarea.input {
    height: auto;
    min-height: 72px;
    padding: 8px 10px;
    resize: vertical;
}
```

- Labels go **above** the field, 6 px away. Never use a placeholder as the label.
- **Exception, and only this one:** a search or filter field inside a 48 px
  toolbar has no room for a label above it, so its name is given by
  `aria-label` and its placeholder shows the same words. This is the single
  place a placeholder-only field is permitted; every field in a form body has a
  visible label.
- A form is a flex column with `gap: 16px` between fields.
- Error text sits 4 px under the field, 12/18 px, `--color-text-danger`, and is
  referenced by `aria-describedby`.
- Actions go in a row at the end: `justify-content: flex-end; gap: 8px`, primary
  last (rightmost).
- Never use a native `<input type="color">`, `<input type="range">` styling hack,
  or a custom checkbox that loses keyboard behaviour. Style the native control
  with `accent-color: var(--app-accent)`.

### 9.3 Lists

The standard row: a leading glyph or nothing, a shrinking main column, a fixed
trailing column.

```css
.list {
    display: flex;
    flex-direction: column;
}
.row {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--app-border);
    background: var(--app-surface);
}
.list > .row:last-child {
    border-bottom: none;
}
.row:hover {
    background: var(--color-background-ghost);
}
.row[aria-selected="true"] {
    background: var(--happy-selected-background, var(--color-background-tertiary));
}
.row-main {
    display: flex;
    flex-direction: column;
    /* No gap: the 20 px and 16 px line boxes already separate the two lines, and
       a two-line row measures 52 px. */
    flex: 1 1 auto;
    min-width: 0;
}
.row-title {
    font-size: 14px;
    line-height: 20px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.row-meta {
    font-size: 12px;
    line-height: 18px;
    color: var(--app-muted);
}
.row-aside {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
}
```

- A whole row that is clickable must be a `<button>` or an `<a>`, or carry
  `role="button"` **and** `tabindex="0"` **and** an Enter/Space handler.
- Do not nest an interactive control inside a clickable row without stopping
  propagation; better, make the row non-clickable and give it an explicit action.
- Reorderable lists need stable keys; never key by array index.
- A list that can hold thousands of entries must be virtualised.

### 9.4 Tables

A table is the one legitimate place for CSS Grid, or for a real `<table>`.
Prefer `<table>` — you get semantics and keyboard behaviour for free.

```css
.table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
    line-height: 20px;
}
.table thead th {
    height: 32px;
    padding: 0 12px;
    text-align: left;
    font-size: 11px;
    line-height: 16px;
    font-weight: 500;
    color: var(--color-text-tertiary);
    background: var(--app-raised);
    border-bottom: 1px solid var(--app-border);
}
.table tbody td {
    height: 36px;
    padding: 0 12px;
    border-bottom: 1px solid var(--app-border);
}
.table tbody tr:hover td {
    background: var(--color-background-ghost);
}
.table td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
    /* A truncated number is a wrong number. Numeric cells never ellipsize; give
       the column enough width instead, or drop it entirely (§4.5). */
    white-space: nowrap;
}
/* An action cell holds a control, not text, so it is sized to that control and
   drops the text padding: 28px button + 8px of breathing room on each side. */
.table .actions-column {
    width: 44px;
}
.table td.actions {
    padding: 0 8px;
    text-align: right;
}
```

- Never zebra-stripe. A hairline between rows is enough.
- Column heads are Micro type (11/16, weight 500, tertiary), left aligned, except
  numeric columns which are right aligned along with their cells.
- A sortable head is a `<button>` inside the `<th>` and sets `aria-sort`.
- Below 640 px, hide non-essential columns; do not turn rows into cards. Never
  hide the numeric column by squeezing it — hide it outright or keep it whole.
- **Size every fixed column to its content, including its own padding.** With
  `table-layout: fixed` a declared width that is narrower than the cell's content
  plus its padding does not grow the column — the content spills past the table's
  edge and is clipped by whatever contains it, which is easy to miss because the
  document itself never reports an overflow. An icon-button column is 44 px wide
  _and_ uses the 8 px padding above; the two numbers go together.
- A table inside a card with a radius needs `overflow: hidden` on the card, so the
  first header cell and last row cell are clipped to the curve. The header's own
  corners then need no radius of their own.
- **A sticky header is optional, and only works in one arrangement.**
  `position: sticky` on `thead th` sticks to the nearest scrolling ancestor, so it
  is inert when the page scrollport is further up the tree, and any
  `overflow: hidden` or `overflow-x: auto` between the two — including the card
  clip above — becomes that ancestor and breaks it. Choose one:

    - **Simplest, and the default:** no sticky header. The table scrolls with the
      page. This is correct and is what most interfaces should do.
    - **Sticky:** the table's own container owns the vertical scroll
      (`overflow-y: auto` with a bounded height) and there is no clipping ancestor
      between it and the `thead`. Then add `position: sticky; top: 0; z-index: 1`
      and a solid `background` on the header cells. Do not also put the table in a
      rounded, clipped card, and remember §4.4: this container is now the view's one
      vertical scrollport, so the page around it must not scroll too.

### 9.5 Cards

```css
.card {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    background: var(--app-surface);
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius-card);
}
.card-title {
    font-size: 15px;
    line-height: 20px;
    font-weight: 600;
}
```

A card grid is a flex row with `flex-wrap: wrap; gap: 12px` and children at
`flex: 1 1 280px`, or a real Grid with `repeat(auto-fill, minmax(280px, 1fr))`
(comment the Grid, §4.1).

### 9.6 Your own navigation, toolbars, and tabs

Permitted, for navigating **your** content:

```css
.toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 48px;
    flex: none;
    /* Matches the page gutter (§2.5), so the toolbar's contents line up with the
       content below it. Raise both to 24px together on a wide page. */
    padding: 0 16px;
    border-bottom: 1px solid var(--app-border);
    background: var(--app-surface);
}
.tabs {
    display: flex;
    align-items: center;
    gap: 4px;
}
.tab {
    height: 28px;
    padding: 0 10px;
    border-radius: var(--app-radius-control);
    font-size: 13px;
    line-height: 18px;
    font-weight: 500;
    color: var(--app-muted);
    background: transparent;
    border: none;
    cursor: pointer;
}
.tab[aria-selected="true"] {
    color: var(--app-text);
    background: var(--happy-selected-background, var(--color-background-tertiary));
}
.tab:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
}
```

- Tabs use `role="tablist"` / `role="tab"` / `role="tabpanel"` and arrow-key
  navigation.
- A tab strip is horizontal only. No vertical tab rail — that reads as Happy
  chrome (§1.4).
- Breadcrumbs: 12/18 px, `--color-text-secondary`, separated by a `/` in
  `--color-text-tertiary`, last crumb `--color-text-primary`.

### 9.7 Status: badges, chips, and indicators

```css
.badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
    height: 20px;
    padding: 0 8px;
    font-size: 11px;
    line-height: 16px;
    font-weight: 500;
    border-radius: var(--border-radius-full, 999px);
    background: var(--color-background-secondary);
    color: var(--color-text-secondary);
}
.badge-info {
    background: var(--color-background-info);
    color: var(--color-text-info);
}
.badge-success {
    background: var(--color-background-success);
    color: var(--color-text-success);
}
.badge-warning {
    background: var(--color-background-warning);
    color: var(--color-text-warning);
}
.badge-danger {
    background: var(--color-background-danger);
    color: var(--color-text-danger);
}
```

Semantics are fixed: **green = succeeded / healthy / connected**, **orange =
needs attention / degraded / unsaved**, **red = failed / destructive / offline**,
**blue = in progress / informational**, **neutral grey = idle / unknown /
disabled**. Never use a semantic colour decoratively, and never re-map one.

A status must be legible without colour: pair the fill with a word ("Failed") or
a text glyph. Do not use a bare coloured dot as the only signal.

### 9.8 Menus and dialogs you own

**When to own one.** An overflow menu on a row, a filter popover, and a confirm
prompt for a destructive action belong inside the document. A larger workflow
should be a page or a real dialog surface, not a fake nested application covered
by its own scrim.

**Menu / popover.** Anchored to its trigger, never wider than 280 px:

```css
.menu {
    position: absolute;
    z-index: 10;
    min-width: 180px;
    max-width: 280px;
    display: flex;
    flex-direction: column;
    padding: 4px;
    background: var(--app-surface);
    border: 1px solid var(--app-border);
    border-radius: var(--app-radius-block);
    box-shadow: var(--shadow-md, 0 4px 12px rgb(0 0 0 / 0.24));
}
.menu-item {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 8px;
    flex: none;
    font: inherit;
    font-size: 13px;
    line-height: 18px;
    text-align: left;
    background: none;
    border: 0;
    border-radius: var(--app-radius-control);
    color: var(--app-text);
    cursor: pointer;
}
.menu-item:hover {
    background: var(--app-ghost);
}
.menu-item[data-destructive] {
    color: var(--app-danger);
}
.menu-separator {
    height: 1px;
    margin: 4px 0;
    background: var(--app-border);
    flex: none;
}
```

The trigger is a `<button>` with `aria-haspopup="menu"` and `aria-expanded`. The
menu is `role="menu"`, its items `role="menuitem"`. Arrow keys move, Enter
activates, Escape closes and returns focus to the trigger, and a click anywhere
else closes it.

**Where to put it.** `position: absolute` inside a `position: relative` parent is
correct _only_ when no ancestor clips or scrolls. A menu opened from a table row
or a list inside a scrollport is the common case, and there the absolute menu is
clipped by the scrollport and drifts out of alignment as the user scrolls. In that
case anchor it to the viewport instead:

- `position: fixed`, with `top`/`left` computed from the trigger's
  `getBoundingClientRect()` at open time.
- Flip above the trigger when it would extend past the bottom edge.
- Close it on scroll and on window resize rather than trying to follow the
  trigger.

This is the one place a page reads geometry from the DOM, and it is
legitimate: there is no CSS expression of "anchored to that element but not
clipped by its scroll container" that is portable today.

**Confirm dialog.** 360 px wide, centred over a scrim, for one destructive
decision:

```css
.scrim {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--happy-scrim, rgb(0 0 0 / 0.48));
}
.dialog {
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: 360px;
    max-width: 100%;
    padding: 16px;
    background: var(--app-surface);
    border: 1px solid var(--app-border);
    /* 14px shell corner; the 1px border plus 16px padding puts every child
       outside the corner field, so no child needs an inner radius (§7.3). */
    border-radius: var(--border-radius-xl, 14px);
    box-shadow: var(--shadow-lg, 0 12px 32px rgb(0 0 0 / 0.45));
}
.dialog-title {
    font-size: 17px;
    line-height: 22px;
    font-weight: 600;
    margin: 0;
}
.dialog-body {
    font-size: 14px;
    line-height: 20px;
    color: var(--app-muted);
    margin: 0;
}
.dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
```

Use `<dialog>` if you can — you get the focus trap, Escape, and the accessible
role for free. Otherwise: `role="dialog"`, `aria-modal="true"`,
`aria-labelledby` pointing at the title, focus moved into the dialog on open and
back to the trigger on close, Escape cancels, and a scrim click cancels unless
the dialog holds unsaved input. The confirming button is the Danger variant
(§9.1) and sits rightmost; Cancel is Secondary and sits to its left.

One dialog at a time. Never stack two, and never open one from inside a menu
without closing the menu first.

### 9.9 Links

```css
a {
    color: var(--happy-link, var(--app-accent));
    text-decoration: none;
}
a:hover {
    text-decoration: underline;
}
a:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
    border-radius: 2px;
}
```

Use a real anchor for navigation. Keep same-product navigation in the current
tab. An external destination may open in a new tab only when that behavior is
useful and clearly expected; include `rel="noreferrer"` whenever using
`target="_blank"`:

```tsx
return (
    <a href={url} target="_blank" rel="noreferrer">
        {label}
    </a>
);
```

Prefer declarative anchors over `window.open` or click handlers that assign
`location.href`. A link must remain discoverable, keyboard-accessible, and
copyable.

---

## 10. Using the accent meaningfully

There is **one** accent: `--color-ring-primary` (system blue), plus
`--happy-link` (Happy teal) for hyperlink text.

Use the accent only for:

1. The focus ring on every focusable element.
2. The selected state of a **form control** — a radio, checkbox, or switch — which
   means setting `accent-color: var(--color-ring-primary)` and letting the native
   control paint itself.
3. An in-progress indicator, and the `--color-text-info` badge (§9.7).
4. `--color-text-info` for informational text and icons.

A **selected row or tab is neutral**, not accent: it takes
`--happy-selected-background` and normal text (§9.3, §9.6). This is deliberate —
a table with six accent-filled rows is unreadable, and the neutral fill is what
Happy itself uses. Do not add an accent underline, left rule, or text colour to a
selected row or tab on top of the neutral fill.

That list is exhaustive. Do **not** use the accent for: page or section headings,
body text, card borders, row hover, the primary button (that is black —
`--color-background-inverse`), any filled area larger than a chip, or decoration.

One deliberate difference to be aware of: hyperlinks use teal (`--happy-link`),
while selection and focus use system blue (`--color-ring-primary`). The blue is
the platform focus colour; use teal for hyperlink text (§9.9) and the loading
arc (§11.2).

---

## 11. States

Every view that loads data has four states, and you must implement all four.

### 11.1 Empty

Centred in the available space, at most 320 px wide, and — as the one exception
to §6.2's rule against centred text — centre aligned:

```css
.empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    flex: 1 1 auto;
    padding: 32px;
    max-width: 320px;
    margin-inline: auto;
    text-align: center;
}
.empty-glyph {
    font-size: 32px;
    line-height: 32px;
    color: var(--app-faint);
}
.empty-title {
    font-size: 15px;
    line-height: 20px;
    font-weight: 600;
    color: var(--app-text);
}
.empty-body {
    font-size: 13px;
    line-height: 18px;
    color: var(--app-muted);
}
```

- The glyph is optional; nothing is an acceptable choice.
- The title is one short sentence saying what is missing.
- The body is one optional sentence saying how to fix it.
- One action, if there is an obvious one, in the Secondary variant.

Never illustrate an empty state with a large graphic, and never apologise
("Oops!", "Nothing to see here!").

### 11.2 Loading

- **First load, no data yet:** a centred 18 px ring with a single arc, plus a
  13/18 px `--color-text-secondary` line ("Loading items…"). Nothing else. This is
  the canonical spinner — use it verbatim:

    ```css
    .spinner {
        flex: none;
        width: 18px;
        height: 18px;
        border: 2px solid var(--app-border);
        border-top-color: var(--app-link);
        border-radius: var(--app-radius-pill);
        animation: spinner-rotate 900ms linear infinite;
    }
    @keyframes spinner-rotate {
        to {
            transform: rotate(360deg);
        }
    }
    ```

    The arc is teal (`--happy-link`), not blue, so progress stays distinct from
    focus and selection. Under
    `prefers-reduced-motion` the animation stops and the ring becomes a static
    arc — which is why the adjacent "Loading…" text is required, not optional: it
    is what carries the meaning when nothing moves.

- **Refreshing existing data:** keep the data on screen. Show a 2 px indeterminate
  bar at the top of the content region, or dim the affected rows to
  `opacity: 0.6`. Never blank a populated view.
- **Optional:** skeleton blocks — `--color-background-secondary`, the exact height
  and radius of the real content. If you animate them, respect §13.
- Never a full-screen spinner overlay. Never a progress bar that
  fakes progress.

### 11.3 Error

An inline block at the top of the content, not a modal, not a toast:

```css
.error {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border-radius: var(--border-radius-md, 8px);
    background: var(--color-background-danger);
    border: 1px solid var(--color-border-danger);
    color: var(--color-text-primary);
}
.error-title {
    font-size: 14px;
    line-height: 20px;
    font-weight: 600;
    color: var(--color-text-danger);
}
```

- Say what failed and what the user can do. Show the underlying message in
  `--font-mono` 12/18 px only if it is actionable.
- Offer a retry **action** if retrying can help. This is not the forbidden
  "Refresh" button — it is recovery from a specific failure.
- Never `alert()`, never `console.error` as the only surface.

### 11.4 Disabled and read-only

- Disabled: `--color-background-disabled`, `--color-text-disabled`, no hover,
  `cursor: default`, and the real `disabled` attribute so it leaves the tab order.
- Read-only content: normal colours, no control affordance. Do not render a
  disabled input to show a value — render text.
- Never disable a control without an adjacent explanation of why.

### 11.5 Staying current

The page must keep itself up to date. When its data source reports a change,
re-read and re-render without a remount and without the user asking. Do not ship
a "Refresh" button whose only job is to re-fetch.

### 11.6 Initializing, and failing to initialize

Before the four data states there is initialization: scripts start, dependencies
become ready, and the first data request begins. Render something sensible for
every outcome. This is not optional—an unhandled startup failure shows a blank
document.

```tsx
if (startError)
    return <ErrorBlock title="This page could not start." detail={startError.message} />;
if (!isReady) return <Loading label="Starting…" />;
if (items === undefined) return <Loading label="Loading items…" />;
if (items.length === 0) return <Empty />;
return <List items={items} />;
```

- While initialization is pending, render the §11.2 first-load state. Do not render the
  populated layout with placeholder data, and do not render nothing.
- When startup fails before retry is possible, render the §11.3 block with no
  retry action, and say that the page could not start rather than that data could
  not load.
- Everything in these states is painted from the §5.4 variables. Check that it
  is legible before any asynchronous work completes.

---

## 12. Focus, keyboard, and accessibility

- **Every** interactive element must show a focus ring:
  `outline: 2px solid var(--color-ring-primary); outline-offset: 2px;` under
  `:focus-visible`. Never `outline: none` without an equally visible replacement.
- Never set a positive `tabindex`. DOM order is tab order; make DOM order match
  visual order.
- Use real elements: `<button>`, `<a href>`, `<input>`, `<select>`, `<table>`,
  `<ul>`. A `<div onclick>` is a defect.
- Give every icon-only control an `aria-label`. Mark decorative glyphs
  `aria-hidden="true"`.
- One `<h1>` per document for the page's content title, then `<h2>`/`<h3>` in
  order, never skipping a level.
- Keyboard contracts you must honour: Enter and Space activate a button; Escape
  closes a popover or cancels an inline edit; arrow keys move within a tablist,
  menu, or grid; Tab never enters a closed disclosure.
- Announce asynchronous changes with `aria-live="polite"` on the status region.
- Respect `prefers-reduced-motion` (§13).
- Do not trap focus unless you have opened a modal you own, and then return focus
  to the trigger on close.
- Do not autofocus on load in an embedded panel; the user may already be
  interacting with the surrounding page. Autofocus is acceptable in a modal or
  a page whose sole purpose is that field.

---

## 13. Motion and performance

Happy's surfaces are still. Motion is for state feedback, never for arrival.

Permitted:

| Change                      | Duration | Easing     |
| --------------------------- | -------- | ---------- |
| Hover / press colour        | 120 ms   | `ease`     |
| Expand / collapse a section | 160 ms   | `ease-out` |
| Popover appear              | 120 ms   | `ease-out` |
| Indeterminate progress      | loop     | linear     |

Forbidden: entrance animations on page or list load, parallax, animated
gradients, bouncing, spinning icons that are not progress, anything over 200 ms,
and animating `width`, `height`, `top`, or `left`. Animate only `opacity` and
`transform`.

```css
@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
    }
}
```

Performance:

- Keep the page small. Use the project's existing framework; do not add another
  framework for one view.
- No network requests to third-party origins for fonts, icons, analytics, or CSS.
  Data comes from the page's own application boundary.
- Virtualise any list that can exceed a few hundred rows.
- Do not observe `resize` at high frequency; prefer CSS container queries. When
  JavaScript observation is unavoidable, coalesce work to animation frames.
- Do not poll on a timer for data the application can push or invalidate.

---

## 14. Icons

You have no access to Happy's icon fonts (Ionicons and Octicons), and there is no
channel to get them. So:

1. **Prefer no icon.** Most rows and buttons read better with a word. This is the
   default answer.
2. When an icon is genuinely needed, use one from the set below. Do not invent a
   different one, and do not mix drawing styles within an app.

These seven cover nearly every product interface. Copy them verbatim; they share one
grid, one stroke weight, and one cap style, which is what makes a set look like a
set rather than seven unrelated drawings.

```tsx
/* All icons: 16x16 box, 1.5px stroke, round caps and joins, currentColor. */
const icon = {
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
};

export const ChevronDown = () => (
    <svg {...icon}>
        <path d="M4 6.5 8 10.5l4-4" />
    </svg>
);
export const ChevronRight = () => (
    <svg {...icon}>
        <path d="M6.5 4 10.5 8l-4 4" />
    </svg>
);
export const Close = () => (
    <svg {...icon}>
        <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
);
export const Plus = () => (
    <svg {...icon}>
        <path d="M8 3.5v9M3.5 8h9" />
    </svg>
);
export const Check = () => (
    <svg {...icon}>
        <path d="M3.5 8.5l3 3 6-7" />
    </svg>
);
export const Search = () => (
    <svg {...icon}>
        <circle cx="7" cy="7" r="3.75" />
        <path d="M10 10l2.5 2.5" />
    </svg>
);
export const More = () => (
    <svg {...icon} fill="currentColor" stroke="none">
        <circle cx="3.5" cy="8" r="1.25" />
        <circle cx="8" cy="8" r="1.25" />
        <circle cx="12.5" cy="8" r="1.25" />
    </svg>
);
```

Rules:

- 16 px in rows, buttons, and menus. 20 px beside a page title. 32 px in an empty
  state — scale the same `viewBox`, never redraw at a new size.
- `currentColor` only, so an icon follows its container's text colour and
  therefore the theme, with no extra work.
- `aria-hidden="true"` on the SVG, and the meaning in the button's `aria-label` or
  in adjacent text.
- Never load an icon font, an icon sprite, or an SVG over the network.
- Never use an emoji as a control's icon.
- A Unicode text glyph (`↑ ↓ ✓ ×`) is acceptable in a dense table cell where a
  full SVG would be noise. Wrap it the same way.

---

## 15. Writing

- Sentence case everywhere: labels, buttons, headings, menu items.
- Verb-first actions: "Add item", "Delete list", "Retry".
- No exclamation marks. No "Oops", "Whoops", "Uh-oh", "Awesome", or "Please".
- State facts: "3 items", "Last updated 2 minutes ago", "Failed to load items".
- Empty and error copy is one sentence of what, one sentence of what to do.
- Never expose internal identifiers, stack traces, or tool names in user-facing
  copy unless they are the point of the view.

---

## 16. Anti-patterns

Each of these is a defect. They are listed because they are what a model
generating a web page tends to do by default.

**Colour and theme**

1. A hex, `rgb()`, `hsl()`, or named colour anywhere except inside a `var()`
   fallback. The keywords `currentColor`, `transparent`, `inherit`, and `none` are
   not colours in this sense and are always allowed — they are how the icon set
   (§14) and the ghost border follow the theme.
2. Tailwind-style palette names (`slate-800`, `blue-500`) or a bundled CSS
   framework.
3. A gradient of any kind — background, text, border, or button.
4. `@media (prefers-color-scheme)` to choose colours instead of the variables.
5. Reading a variable in JavaScript and storing the resolved colour.
6. Aliasing a design variable to itself (`--happy-canvas: var(--happy-canvas, …)`).
7. Repeating a fallback at every use site instead of once in `:root`.
8. A dark-mode-only or light-mode-only design.

**Layout**

9. `float`, layout `<table>`, `inline-block` spacing, or absolute positioning for
   layout (§4.1).
10. Margins between siblings instead of the parent's `gap` (§4.2).
11. A flex child that can shrink without `min-width: 0` (§4.3).
12. Padding on the scrollport instead of on an inner wrapper (§4.4).
13. Two nested vertical scrollbars (§4.4).
14. `100vh` or `min-height: 100vh` inside an embedded surface. It forces content
    to viewport height even though the panel owns a different region (§2.2).
15. `height: 100%` on `<html>`/`<body>` in an embedded surface; content should
    own its intrinsic height (§2.2).
16. Laying out from a one-time JavaScript width measurement; it does not survive
    a window or container resize (§1.1).
17. Mobile breakpoints, a hamburger menu, or touch-sized targets (§2).

**Chrome and identity**

18. A fake browser title bar or window controls (§1.4).
19. A navigation rail that imitates the surrounding product's global chrome (§1.4).
20. A full-viewport scrim for something that is not a dialog you own (§9.8).
21. Scripted navigation where a semantic `<a>` works, or `target="_blank"`
    without `rel="noreferrer"` (§9.9).
22. Shipping a web font, an icon font, a Google Fonts `@import`, or a CDN
    stylesheet (§6.1, §14).

**Type and density**

23. Text below 11 px, or a weight outside 400/500/600 (§6.2).
24. A 32 px hero heading, centred marketing copy, or an illustration band (§8).
25. Layout spacing off the 4 px scale (§3) — but note that control-internal
    padding is deliberately not on it.
26. Zebra-striped tables, coloured row backgrounds, or shadowed buttons (§7, §9.4).
27. Emoji as UI iconography, or a hand-drawn icon outside the §14 set.

**Behaviour**

28. Rendering nothing, or a populated layout with placeholder data, while
    initialization is still in flight (§11.6).
29. A "Refresh" button as the only way to get current data (§11.5).
30. A full-screen loading overlay, or blanking a populated view while refreshing.
31. `alert()`, `confirm()`, or `prompt()`.
32. Entrance animations, or any transition longer than 200 ms (§13).
33. `outline: none` without a replacement focus indicator (§12).
34. A `<div>` with an `onclick` and no role, tabindex, or key handler (§12).

---

## 17. A complete baseline

Copy this as the first stylesheet of a new Happy-designed page. It implements §5.4, §3,
§4, §6, and §12, and nothing else — every component style is yours to add from §9.

```css
/* ---- Design-variable mapping and fallbacks (declare once) ------------- */
:root {
    color-scheme: light dark;

    --app-surface: var(--color-background-primary, light-dark(#ffffff, #212121));
    --app-raised: var(--color-background-secondary, light-dark(#f8f8f8, #171717));
    --app-inset: var(--color-background-tertiary, light-dark(#f0f0f2, #2c2c2e));
    --app-disabled: var(--color-background-disabled, light-dark(#f0f0f2, #2c2c2e));
    --app-ghost: var(
        --color-background-ghost,
        light-dark(rgb(0 0 0 / 0.08), rgb(255 255 255 / 0.08))
    );
    --app-canvas: var(--happy-canvas, light-dark(#f5f5f5, #1e1e1e));
    --app-code: var(--happy-code-background, light-dark(#f6f8fa, #161b22));

    --app-text: var(--color-text-primary, light-dark(#000000, #ffffff));
    --app-muted: var(--color-text-secondary, light-dark(#49454f, #cac4d0));
    --app-faint: var(--color-text-tertiary, light-dark(#807d84, #97939c));
    --app-on-action: var(--color-text-inverse, #ffffff);
    --app-disabled-text: var(--color-text-disabled, light-dark(#adabb0, #6d6a70));

    --app-border: var(--color-border-primary, light-dark(#eaeaea, #292929));
    --app-border-strong: var(--color-border-secondary, light-dark(#cccccc, #4d4d4d));
    --app-accent: var(--color-ring-primary, light-dark(#007aff, #0a84ff));
    --app-link: var(--happy-link, #2baccc);
    --app-action: var(--color-background-inverse, #000000);

    --app-danger: var(--color-text-danger, light-dark(#f44336, #f48fb1));
    --app-success: var(--color-text-success, light-dark(#34c759, #32d74b));
    --app-warning: var(--color-text-warning, light-dark(#ff9500, #ffab00));
    --app-info: var(--color-text-info, light-dark(#007aff, #0a84ff));

    /* Soft semantic fills, composed from each hue over the surface. */
    --app-danger-soft: var(--color-background-danger, light-dark(#fff0f0, rgb(255 69 58 / 0.15)));
    --app-success-soft: var(
        --color-background-success,
        light-dark(rgb(52 199 89 / 0.14), rgb(50 215 75 / 0.14))
    );
    --app-warning-soft: var(
        --color-background-warning,
        light-dark(#fff8f0, rgb(255 159 10 / 0.15))
    );
    --app-info-soft: var(
        --color-background-info,
        light-dark(rgb(0 122 255 / 0.12), rgb(10 132 255 / 0.12))
    );

    --app-radius-control: var(--border-radius-sm, 6px);
    --app-radius-block: var(--border-radius-md, 8px);
    --app-radius-card: var(--border-radius-lg, 10px);
    --app-radius-pill: var(--border-radius-full, 999px);

    --app-font: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    --app-mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

/* ---- Document ---------------------------------------------------------- */
*,
*::before,
*::after {
    box-sizing: border-box;
}

html,
body {
    margin: 0;
    padding: 0;
}

/* Include EXACTLY ONE of the following two blocks.
 *
 * FULL PAGE OR OVERLAY: the viewport owns the height, so fill the frame. */
html,
body,
#root {
    height: 100%;
}

/* EMBEDDED PANEL: content owns the height, so include NOTHING here—no height,
 * no min-height, no vh—and let the document size intrinsically. */

body {
    font-family: var(--app-font);
    font-size: 14px;
    line-height: 20px;
    font-weight: 400;
    font-synthesis: none;
    color: var(--app-text);
    background: var(--app-surface);
    -webkit-font-smoothing: antialiased;
}

#root {
    display: flex;
    flex-direction: column;
    min-height: 0;
    width: 100%;
}

/* ---- Shared primitives -------------------------------------------------- */
.row {
    display: flex;
    align-items: center;
    gap: 8px;
}
.column {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.grow {
    flex: 1 1 auto;
    min-width: 0;
}
.fixed {
    flex: none;
}
.truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.scrollport {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: var(--happy-scrollbar-thumb, rgb(150 150 150 / 0.4)) transparent;
}
.scrollport-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
}

code,
pre,
.mono {
    font-family: var(--app-mono);
    font-size: 12px;
    line-height: 18px;
}
pre {
    margin: 0;
    padding: 12px;
    /* Horizontal only: a long log line scrolls sideways, but the block grows to
       its content vertically, so it never becomes a second vertical scrollport
       (§4.4). Never add `max-height` with `overflow-y: auto` here. An unbounded
       log is laid out the other way round: the `pre` becomes the view's one
       scrollport itself — `flex: 1 1 auto; min-height: 0; overflow: auto` inside
       the body, with no other scrolling element — or it stays in normal flow and
       you cap the number of lines you render. */
    overflow-x: auto;
    background: var(--app-code);
    border-radius: var(--app-radius-block);
}

a {
    color: var(--app-link);
    text-decoration: none;
}
a:hover {
    text-decoration: underline;
}

.spinner {
    flex: none;
    width: 18px;
    height: 18px;
    border: 2px solid var(--app-border);
    border-top-color: var(--app-link);
    border-radius: var(--app-radius-pill);
    animation: spinner-rotate 900ms linear infinite;
}
@keyframes spinner-rotate {
    to {
        transform: rotate(360deg);
    }
}

:focus-visible {
    outline: 2px solid var(--app-accent);
    outline-offset: 2px;
}

@media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
    }
}
```

And the shape of a full-page layout built on it:

```tsx
function Page() {
    return (
        <div className="page">
            <div className="toolbar">
                <h1 className="page-title grow truncate">Deployments</h1>
                <button className="btn btn-secondary fixed" type="button">
                    Filter
                </button>
                <button className="btn btn-primary fixed" type="button">
                    New deployment
                </button>
            </div>
            <div className="scrollport">
                <div className="scrollport-content">{/* rows, cards, table */}</div>
            </div>
        </div>
    );
}
```

```css
.page {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--app-surface);
}
.page-title {
    font-size: 20px;
    line-height: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
    margin: 0;
}
```

---

## 18. Acceptance checklist

Verify each item by measurement, not by looking. Where a number is given, read it
out of `getComputedStyle` or the DevTools box model at **2× device pixel ratio**,
in **both** light and dark, at **three** container widths: **400**, **640**, and
**1180** CSS pixels.

**Theme**

- [ ] `getComputedStyle(document.documentElement)` resolves `--app-surface` and
      `--app-canvas`.
- [ ] The first paint already renders legibly from the §5.4 fallbacks—no flash
      of unstyled or invisible content.
- [ ] No rule is keyed on `[data-theme]`.
- [ ] Toggling between light and dark repaints the page with no reload, and
      every visible colour changes appropriately.
- [ ] A grep of the page's CSS and TSX finds **zero** hex, `rgb(`, `hsl(`, or
      named colours outside `var(…, fallback)` positions.
- [ ] Opened standalone in a browser tab, the page is still legible
      in both OS appearances (the fallbacks work) and no variable is cyclic.

**Layout**

- [ ] `document.body` computed `margin` is `0px`.
- [ ] On a full-page surface the outermost element fills the frame
      (`clientHeight === document.documentElement.clientHeight`) and there is no
      page-level scrollbar on `<body>`. Verify after resizing the window, not
      only at first load.
- [ ] On an embedded surface the document height equals its content height and
      no viewport-height rule forces extra space.
- [ ] The scrollport's computed `padding` and `margin` are both `0px`, and its
      box exactly matches its parent's content box.
- [ ] Exactly one element in the view has a vertical scrollbar.
- [ ] Every flex `gap`, every container padding, and every margin between elements
      is 0, 4, 8, 12, 16, 24, 32, or 48 px. (Padding _inside_ a control is exempt —
      it comes from §9 verbatim.)
- [ ] No rule anywhere uses `vh` units.
- [ ] At 400 px wide nothing overflows horizontally
      (`document.documentElement.scrollWidth <= clientWidth`).
- [ ] A row with a 200-character title ellipsizes and its trailing controls stay
      at their declared width.

**Type**

- [ ] No computed `font-size` below `11px`.
- [ ] Every text element's `font-family` resolves through `--app-font` or
      `--app-mono`; no other family appears.
- [ ] Every `font-weight` is 400, 500, or 600.
- [ ] Each `font-size`/`line-height` pair matches a row of the §6.2 table.

**Shape**

- [ ] Buttons and inputs are exactly 28, 36, or 44 px tall.
- [ ] Every `border-radius` is 0, 6, 8, 10, 14, or 999 px.
- [ ] Every border is exactly 1 px, except the loading ring and focus rings,
      which are 2 px.
- [ ] For each nested rounded corner, `inner === max(0, outer − inset)`.
- [ ] No `box-shadow` on a button, input, row, chip, or table.

**Accent and contrast**

- [ ] The accent appears only in focus rings, form-control selection
      (`accent-color`), progress, and info text — never on a selected row or tab,
      which are neutral (§10).
- [ ] Body text contrast is ≥ 4.5 : 1 against its background in both schemes.
- [ ] Focus rings are ≥ 3 : 1 against the adjacent surface in both schemes.

**Interaction**

- [ ] Tabbing reaches every control in visual order and each shows a 2 px ring
      (offset 2 outward, or −1 inside a filled input), fully inside the scrollport.
- [ ] Enter and Space activate every clickable thing; Escape closes every menu and
      dialog and returns focus to its trigger.
- [ ] Every icon-only control has an `aria-label`.
- [ ] All six states—initializing, start-failed, loading, empty, error, and
      populated—render correctly at each of the three widths.
- [ ] No transition exceeds 200 ms; `prefers-reduced-motion` disables them all and
      the loading state still reads without motion.
- [ ] There is no "Refresh" button, no `alert()`, no scripted navigation where
      an anchor works, and every new-tab link uses `rel="noreferrer"`.
