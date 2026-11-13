# `chart`

A line, area, bar or donut chart.

Group: data.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `kind` | `line` \| `area` \| `bar` \| `donut` | yes | Chart type. |
| `labels` | array of string (1–24) | yes | X categories in order, or slice names for a donut. |
| `series` | array of object (1–6) | yes | One or more series. A donut uses only the first. |
| `series[].name` | string | yes | Legend name. |
| `series[].values` | array of number (1–24) | yes | One value per label. |
| `series[].color` | color |  | Colour of this series, for telling series apart. Without it the series takes the shared chart palette in order. A donut ignores it. |
| `series[].emphasis` | boolean |  | Highlight this series; series without it are drawn muted. |
| `format` | object |  | How axis and value labels are written. |
| `format.prefix` | string |  | Put before every number (`$`). |
| `format.suffix` | string |  | Put after every number, including any space (` ms`, `%`). |
| `stacked` | boolean |  | Stack series (bar and area only). Default `false`. |
| `totalLabel` | string |  | Donut only: caption under the total in the centre. Default `Total`. |
| `caption` | string |  | Muted note under the chart. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- **Size.** Line, area and bar: 2:1 where the chart is 560pt or wider, 16:10 below that. Donut: the ring is at most 220pt; its legend sits beside it on wide layouts and under it on phones.
- **Y axis.** About four ticks at round values, light horizontal gridlines, no vertical ones. Bar and area always start at zero. A line chart starts at zero unless its smallest value is more than half of its largest; then the axis starts at a round value below the smallest.
- **Numbers.** Abbreviated with `k`, `M`, `B` and at most one decimal, then wrapped in `format.prefix` and `format.suffix` as written, with a minus sign before the prefix (`-$1.2k`). Units are never converted.
- **Colours.** Series take the shared chart palette in order (chart-1, chart-2, ...), unless a series names its `color`. If any series has `emphasis`, the others are drawn in the muted neutral, named colour or not. Donut slices always take the palette in order.
- **Legend.** Shown above the plot when there are two or more series; always shown for a donut, where each row is name, value and percentage.
- **Donut.** Slices follow `labels` order, clockwise from 12 o'clock; the centre shows the sum and `totalLabel`. Zero and negative values are skipped.
- **Area.** Unstacked areas fade to transparent toward the baseline so overlaps stay readable; stacked areas fill only their own band.
- **Bad data.** A series shorter than `labels` leaves gaps; extra values are ignored; a chart with no drawable value shows an empty plot with its axes.

## Example

```json
{
  "type": "chart",
  "kind": "line",
  "format": {
    "prefix": "$"
  },
  "labels": [
    "Apr",
    "May",
    "Jun"
  ],
  "series": [
    {
      "name": "Enterprise",
      "values": [
        120000,
        138000,
        156000
      ]
    },
    {
      "name": "Self-serve",
      "values": [
        190000,
        186000,
        192000
      ]
    }
  ]
}
```
