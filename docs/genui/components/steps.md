# `steps`

A vertical timeline of steps with their status.

Group: data.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `items` | array of object (1–12) | yes | Steps in order. |
| `items[].title` | string | yes |  |
| `items[].detail` | string |  | Muted second line. |
| `items[].status` | `done` \| `active` \| `pending` \| `failed` | yes |  |
| `items[].time` | string |  | Short trailing text, already formatted (`1m 08s`). Shown only when given. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- A marker per step joined by a thin neutral rail: done = filled check in the success colour, active = accent ring with a dot (it may pulse; hosts can freeze motion), failed = filled x in the danger colour, pending = hollow circle.
- Pending titles are muted; a failed title takes the danger colour. The rail does not change colour.
- `time` is trailing and muted, on the title line.

## Example

```json
{
  "type": "steps",
  "items": [
    {
      "title": "Build image",
      "status": "done",
      "time": "1m 08s"
    },
    {
      "title": "Migrate database",
      "detail": "Applying 2 of 3 migrations",
      "status": "active"
    },
    {
      "title": "Roll out",
      "status": "pending"
    }
  ]
}
```
