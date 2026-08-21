# Profile — learnings

## Photo processing follows the runtime

Profile photos keep one contract across runtimes: oriented, bounded WebP bytes and a ThumbHash.
Node implements it with Sharp; the standalone Bun executable implements it with `Bun.Image`.
Because Bun does not expose decoded pixels, only its own bounded, non-palette PNG thumbnail is
decoded to RGBA for ThumbHash generation; uploaded image bytes never enter that narrow decoder.
