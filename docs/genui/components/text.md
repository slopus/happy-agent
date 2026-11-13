# `text`

A paragraph of text with inline Markdown.

Group: content.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `text` | string (inline Markdown) | yes | Inline Markdown: bold, italic, inline code and links. No headings, lists, images or HTML. |
| `variant` | `body` \| `title` \| `caption` |  | `title` is a heading, `caption` is small and muted. Default `body`. |
| `tone` | tone |  | Text colour. Default `neutral`. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- Wraps to the available width; never truncated.
- Links open through the host as an `open` action. Block-level Markdown is shown as literal text.

## Example

```json
{
  "type": "text",
  "text": "Three stays that fit your dates:"
}
```
