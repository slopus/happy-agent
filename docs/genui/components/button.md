# `button`

A button that runs an action.

Group: input.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `label` | string | yes | Verb phrase, under 24 characters. |
| `action` | action | yes | What it does. |
| `icon` | icon |  | Leading icon. |
| `variant` | `primary` \| `secondary` \| `plain` |  | Visual weight. In a card's `actions` slot the default is `primary` for the first button and `secondary` for the rest; elsewhere `secondary`. |
| `tone` | tone |  | `danger` marks a destructive action. A colour name only tints the button. Default `neutral`. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- The platform's standard medium button. One line; the label truncates rather than wraps.
- After activation the button shows a pressed or done state and cannot be triggered twice while the host is handling the action.
- A button whose action the host cannot run, because it does not know the action or does not serve it, is drawn disabled with its label.

## Example

```json
{
  "type": "button",
  "label": "Break down by plan",
  "action": {
    "type": "message",
    "text": "Break down by plan"
  }
}
```
