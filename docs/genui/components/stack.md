# `stack`

A vertical group of children with standard spacing. Use as the root when no card frame is wanted.

Group: container.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| (none) | | | |

## Children and slots

- `children`: an array of nodes, nested inline.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- Children are laid out top to bottom at full width. No border, background or padding of its own.
- As the root it sits directly on the chat surface, aligned with message text.

## Example

```json
{
  "type": "stack",
  "children": [
    {
      "type": "text",
      "text": "Three stays that fit your dates:"
    },
    {
      "type": "gallery",
      "layout": "carousel",
      "items": [
        {
          "image": {
            "src": "assets/coast.jpg",
            "alt": "Cabin on a cliff"
          },
          "title": "Cliffside Cabin",
          "subtitle": "$240 / night · 2 guests",
          "badge": {
            "text": "4.9",
            "icon": "star",
            "tone": "accent"
          },
          "action": {
            "type": "message",
            "text": "Tell me more about Cliffside Cabin"
          }
        }
      ]
    }
  ]
}
```
