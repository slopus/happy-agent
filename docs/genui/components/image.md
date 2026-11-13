# `image`

A single image.

Group: media.

## Props

| Prop | Type | Required | Notes |
|---|---|---|---|
| `src` | string | yes | Path of an image file stored with the document, relative to it (for example `assets/coast.jpg`). Remote URLs are refused in v1: add the image as a file first. |
| `alt` | string | yes | Text alternative. Shown if the image fails to load and read by screen readers. |
| `caption` | string |  | Muted text under the image. |
| `aspect` | `landscape` \| `square` \| `portrait` |  | 3:2, 1:1 or 3:4; cropped to fill, centred. Default `landscape`. |

## Children and slots

- No children.
- `id`: optional on every node; a stable name, unique in the document.

## Behaviour

- Full width of its container, rounded corners, never taller than 360pt; on wide layouts the image narrows to respect that cap and stays leading-aligned.
- Tapping opens the host's image viewer. Loading and failure show the tinted placeholder at the final size, so the layout never jumps.

## Example

```json
{
  "type": "image",
  "src": "assets/lake.jpg",
  "alt": "Alpine lake",
  "caption": "Taken this morning."
}
```
