# `section`

A titled group inside a card.

Group: container.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `title` | string | yes | Small heading above the group. |

## Children and slots

- `children`: an array of nodes, nested inline.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- A hairline divider, then the title in the small-heading style, then the children.
- The divider is omitted when the section is the first child of its parent.
- Sections do not nest; a section inside a section renders as plain children under its title.

## Example

```json
{
  "type": "section",
  "title": "Checks",
  "children": [
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
  ]
}
```
