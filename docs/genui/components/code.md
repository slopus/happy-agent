# `code`

A block of code with a copy control.

Group: content.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes | The code. Newlines and indentation are preserved. |
| `language` | string |  | Language id for highlighting (`ts`, `sql`, `json`, `bash`...). Unknown values render unhighlighted. |
| `title` | string |  | File name or caption in the header. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- Monospace, no wrapping; long lines scroll horizontally inside the block.
- A copy control copies `text` exactly. Blocks taller than about 20 lines are capped and scroll or expand, as the platform's code block does.

## Example

```json
{
  "type": "code",
  "language": "sql",
  "title": "spend.sql",
  "text": "SELECT category, SUM(amount) AS total\nFROM expenses\nGROUP BY category;"
}
```
