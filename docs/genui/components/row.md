# `row`

A horizontal group whose children share the width equally.

Group: container.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| (none) | | | |

## Children and slots

- `children`: an array of nodes, nested inline.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- 2–4 children, equal widths, top aligned, standard gap. Intended for `stat`, `button` and `badge`.
- When the children do not fit at their minimum width the row wraps to a vertical stack. Three `stat`s must fit side by side at 390pt.
- A row with one child behaves like that child alone. Children beyond the fourth wrap to a second line.

## Example

```json
{
  "type": "row",
  "children": [
    {
      "type": "stat",
      "label": "Revenue",
      "value": "$1.24M",
      "delta": "+18%",
      "deltaLabel": "vs Q2",
      "trend": "up",
      "spark": [
        62,
        64,
        70,
        68,
        75,
        81,
        88,
        96,
        104
      ]
    },
    {
      "type": "stat",
      "label": "Revenue",
      "value": "$1.24M",
      "delta": "+18%",
      "deltaLabel": "vs Q2",
      "trend": "up",
      "spark": [
        62,
        64,
        70,
        68,
        75,
        81,
        88,
        96,
        104
      ]
    }
  ]
}
```
