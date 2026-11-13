# `card`

The standard root: a bordered surface with a header, content and a footer of actions.

Group: container.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `title` | string |  | Header title. |
| `subtitle` | string |  | Muted line under the title. |
| `icon` | icon |  | Leading header icon. |
| `badge` | badge |  | Status label at the trailing edge of the header. |

## Children and slots

- `children`: an array of nodes, nested inline.
- `actions`: Footer buttons. An array of nodes, nested inline. Allowed: `button`; at most 3.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- A hairline border on the chat surface, no fill tint, platform corner radius. Children stack vertically with the standard gap.
- The header is omitted when `title`, `subtitle`, `icon` and `badge` are all absent.
- `actions` render as a footer row. A button with no `variant` is `primary` if it is first and `secondary` otherwise.
- When the buttons do not fit on one line (typical on phones) they stack, each full width, in document order.
- A card must not contain another card. A nested card renders its children without its own border or header.

## Example

```json
{
  "type": "card",
  "title": "Q3 at a glance",
  "subtitle": "Jul 1 – Sep 30",
  "icon": "chart",
  "badge": {
    "text": "On track",
    "tone": "success",
    "icon": "check"
  },
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
    }
  ],
  "actions": [
    {
      "type": "button",
      "label": "Break down by plan",
      "action": {
        "type": "message",
        "text": "Break down by plan"
      }
    }
  ]
}
```
