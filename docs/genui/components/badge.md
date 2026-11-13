# `badge`

A short status label.

Group: content.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `text` | string | yes | Short label, shown exactly as written (no case change). Keep under 16 characters. |
| `tone` | tone |  | Colour of the label. Default `neutral`. |
| `icon` | icon |  | Small leading icon. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- A compact pill: tinted background and text in the tone colour, sentence case exactly as written, one line.
- Text longer than the available width is truncated with an ellipsis.
- The same look is used wherever a `badge` value appears as a prop (card header, list item, gallery item). A `badge` table column draws its `{ text, tone }` cells the same way.

## Example

```json
{
  "type": "badge",
  "text": "Draft"
}
```
