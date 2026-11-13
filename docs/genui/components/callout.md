# `callout`

An inline notice.

Group: content.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `text` | string (inline Markdown) | yes | The message. Inline Markdown. |
| `title` | string |  | Bold lead-in. |
| `tone` | tone |  | Kind of notice. A colour name tints it and behaves as `neutral`. Default `neutral`. |
| `icon` | icon |  | Overrides the default icon for the tone (neutral, accent and colour names = info, success = check, warning and danger = alert). |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- A faintly tinted block in the tone colour with the platform corner radius: icon leading, optional title, then the text.
- Never a coloured stripe on one edge. At most one callout per card reads well.

## Example

```json
{
  "type": "callout",
  "tone": "warning",
  "title": "Long migration",
  "text": "`add_index_sessions_updated_at` locks writes for about 40 seconds."
}
```
