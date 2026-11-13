# `choices`

A question with tappable answers; picking one runs its action.

Group: input.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `options` | array of object (2–8) | yes | The answers. |
| `options[].label` | string | yes |  |
| `options[].description` | string |  | Second line (`list` layout only). |
| `options[].icon` | icon |  |  |
| `options[].action` | action | yes |  |
| `prompt` | string |  | The question, shown above the options. |
| `layout` | `list` \| `chips` |  | `list`: full-width rows with descriptions. `chips`: compact buttons that wrap. Default `list`. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- `list`: rows with icon, label, description and a chevron, hairlines between them.
- `chips`: outlined pill buttons in document order, wrapping to more lines; descriptions are not shown.
- Picking an option runs its action once. The picked option stays marked and the others are disabled, so the transcript shows what was chosen.

## Example

```json
{
  "type": "choices",
  "prompt": "How do you want to handle it?",
  "options": [
    {
      "label": "Fix the race",
      "description": "About 30 lines.",
      "icon": "code",
      "action": {
        "type": "message",
        "text": "Fix the race"
      }
    },
    {
      "label": "Quarantine it",
      "icon": "lock",
      "action": {
        "type": "message",
        "text": "Quarantine it"
      }
    }
  ]
}
```
