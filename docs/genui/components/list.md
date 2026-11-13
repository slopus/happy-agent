# `list`

Rows of rich items, optionally tappable.

Group: data.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `items` | array of object (1–20) | yes | The rows, in order. |
| `items[].title` | string | yes |  |
| `items[].subtitle` | string |  | Muted second line. |
| `items[].icon` | icon |  | Leading icon. Ignored when `image` is set or the list is `ordered`. |
| `items[].image` | image |  | Leading square thumbnail. |
| `items[].tone` | tone |  | Tints the leading icon. |
| `items[].badge` | badge |  | Status label. |
| `items[].trailing` | string |  | Short trailing text (`2h`, `$48`). Keep under 8 characters. |
| `items[].action` | action |  | Makes the row tappable and adds a chevron. |
| `ordered` | boolean |  | Number the rows instead of showing icons. Default `false`. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- One leading column for the whole list, as wide as its widest leading element (thumbnail, icon, number or nothing), so titles share a left edge.
- Wide layouts: badge, trailing text and chevron sit at the trailing edge, vertically centred.
- Phones: trailing text sits on the title line; the badge sits on the subtitle line, or on the title line when there is no subtitle.
- Hairlines between rows, inset to the title edge. Titles wrap to two lines, subtitles truncate at one.

## Example

```json
{
  "type": "list",
  "items": [
    {
      "title": "Fix reconnect loop after sleep",
      "subtitle": "happy-agent · #2314",
      "icon": "git-pull-request",
      "tone": "success",
      "badge": {
        "text": "Checks pass",
        "tone": "success"
      },
      "trailing": "2h",
      "action": {
        "type": "open",
        "url": "https://github.com/slopus/happy-agent/pull/2314"
      }
    }
  ]
}
```
