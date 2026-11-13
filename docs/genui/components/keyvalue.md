# `keyvalue`

A definition list of label/value pairs.

Group: content.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `items` | array of object (1–12) | yes | The pairs, in order. |
| `items[].label` | string | yes |  |
| `items[].value` | string | yes | Already formatted. |
| `items[].icon` | icon |  | Describes the label; drawn before it. |
| `items[].tone` | tone |  | Colours the value. |
| `items[].action` | action |  | Makes the value tappable. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- Phones: one pair per line, label leading and muted, value trailing, hairline between pairs.
- Wide layouts: labels in one fixed-width muted column, values start right after it, no hairlines.
- Every row reserves the icon column when any item has an icon, so labels share one left edge.
- Values wrap rather than truncate.

## Example

```json
{
  "type": "keyvalue",
  "items": [
    {
      "label": "Failure rate",
      "value": "7 of 50 runs",
      "tone": "danger"
    },
    {
      "label": "First seen",
      "value": "Nov 9",
      "icon": "calendar"
    }
  ]
}
```
