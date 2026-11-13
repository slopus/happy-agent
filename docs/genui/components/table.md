# `table`

A small table of text, numbers and badges.

Group: data.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `columns` | array of object (1–6) | yes | Columns in order. The first column names the row. |
| `columns[].key` | string | yes | Property name of this column in each row. |
| `columns[].label` | string | yes | Header text. |
| `columns[].kind` | `text` \| `number` \| `badge` \| `code` |  | How cells are drawn. Default `text`. |
| `columns[].align` | `start` \| `end` |  | Defaults to `end` for `number`, `start` otherwise. |
| `rows` | array of object (0–30) | yes | One object per row, keyed by column `key`. A cell is a string, or `{ text, tone }` for a badge or a tinted value. |
| `caption` | string |  | Muted note under the table. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- Wide layouts: a plain grid with a muted header row and hairlines between rows, no vertical rules and no zebra striping. `number` cells use tabular figures.
- Phones, more than 3 columns: each row becomes a block. The first column is the block title, a `badge` column sits at the trailing edge of the title line, and the remaining columns form a small label/value grid under it.
- Phones, 3 columns or fewer: a normal grid.
- A missing cell is empty. Keys not named in `columns` are ignored. An empty `rows` shows the header and a muted "No rows".

## Example

```json
{
  "type": "table",
  "columns": [
    {
      "key": "model",
      "label": "Model"
    },
    {
      "key": "pass",
      "label": "Pass rate",
      "kind": "number"
    },
    {
      "key": "status",
      "label": "Verdict",
      "kind": "badge"
    }
  ],
  "rows": [
    {
      "model": "Fable 5.2",
      "pass": "81.5%",
      "status": {
        "text": "Best",
        "tone": "success"
      }
    }
  ]
}
```
