# `progress`

A progress bar.

Group: data.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `value` | number | yes | Fraction complete, 0 to 1. Values outside the range are clamped. |
| `label` | string |  | What is progressing. |
| `detail` | string |  | Trailing text (`42 of 60`). |
| `tone` | tone |  | Fill colour. `neutral` uses the platform's primary ink. Default `neutral`. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- Label leading and detail trailing on one line, then a thin rounded bar on a faint track.
- The percentage is not printed by the renderer; put it in `detail` if it should be shown.

## Example

```json
{
  "type": "progress",
  "label": "Annual target",
  "value": 0.72,
  "detail": "$3.6M of $5M"
}
```
