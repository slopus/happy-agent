# `gallery`

A set of images as a mosaic grid or a carousel of cards.

Group: media.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `items` | array of object (1–24) | yes | The images, in order. |
| `items[].image` | image | yes |  |
| `items[].title` | string |  | Carousel card title; the viewer caption in a grid. |
| `items[].subtitle` | string |  | Muted line under the title (carousel). |
| `items[].badge` | badge |  | Label beside the title (carousel). |
| `items[].action` | action |  | Carousel only: makes the card tappable. |
| `layout` | `grid` \| `carousel` |  | Default `grid`. |
| `aspect` | `landscape` \| `square` \| `portrait` |  | Tile shape: 3:2, 1:1 or 3:4. Images are cropped to fill, centred. Default `landscape`. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- **Grid.** A tight mosaic with 2pt gutters and rounded outer corners: 1 image = full width; 2 = side by side; 3 = one large and two stacked; 4 = 2×2; 5 or more = two over three, with `+N` over the fifth tile for the rest. Titles are not drawn. Tapping a tile opens the host's image viewer on that image; the viewer pages through all items.
- **Carousel.** Horizontally scrolling cards: image on top, then title with the badge at its trailing edge, then subtitle. Phones: the row runs to the screen edge, snaps per card, and the next card peeks; card width is 72% of the column for landscape, 60% for square and 48% for portrait. Wide layouts: three cards visible, arrow buttons centred on the images, shown only when there is more to scroll.
- On narrow cards the badge moves under the subtitle so the title keeps its line.
- An image that fails to load shows a tinted placeholder with an image glyph, same size.

## Example

```json
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
```
