# `stat`

One headline number with an optional change and sparkline.

Group: content.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `label` | string | yes | What the number is. |
| `value` | string | yes | The number, already formatted by the author (`$1.24M`, `8,412`, `2.1%`). |
| `delta` | string |  | Change, already formatted (`+18%`, `-0.4pt`). |
| `deltaLabel` | string |  | What the change is measured against (`vs Q2`). |
| `trend` | `up` \| `down` \| `flat` |  | Direction arrow next to the delta. |
| `tone` | tone |  | Colour of the delta and sparkline. Defaults from `trend`: up = success, down = danger, flat = neutral. Set it when down is good. |
| `spark` | array of number (2–60) |  | Values for a small sparkline, oldest first. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- Label (muted, small), then the value in the large numeric style with tabular figures, then the delta with its trend arrow.
- On wide layouts the delta sits beside the value; in narrow columns it sits under it. `deltaLabel` follows the delta in muted text.
- The sparkline is a thin line with a faint fill in the tone colour, no axes, scaled to its own minimum and maximum, about 28pt tall.
- Stats in a `row` are top aligned.

## Example

```json
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
```
