import { Value } from "@sinclair/typebox/value";
import { expect, expectTypeOf, it } from "vitest";

import { isMediaImageItem } from "../sources/index.js";
import { mediaItemSchema, type MediaItem } from "../sources/protocol/messages.js";

function byIf(item: MediaItem): string | null {
    if (item.kind === "image") {
        expectTypeOf(item.width).toEqualTypeOf<number>();
        expectTypeOf(item.height).toEqualTypeOf<number>();
        expectTypeOf(item.thumbhash).toEqualTypeOf<string>();
        const width: number = item.width;
        const height: number = item.height;
        const thumbhash: string = item.thumbhash;
        return `${width}×${height} ${thumbhash}`;
    }
    return null;
}

function bySwitch(item: MediaItem): string | null {
    switch (item.kind) {
        case "image": {
            const width: number = item.width;
            const height: number = item.height;
            const thumbhash: string = item.thumbhash;
            return `${width}×${height} ${thumbhash}`;
        }
        default:
            return null;
    }
}

it("preserves required image fields after existing discriminant checks", () => {
    const image: MediaItem = {
        kind: "image",
        name: "a.png",
        mimeType: "image/png",
        size: 1,
        width: 10,
        height: 20,
        thumbhash: "AAAA",
    };
    expect(byIf(image)).toBe("10×20 AAAA");
    expect(bySwitch(image)).toBe("10×20 AAAA");
});

it("exports an image guard and treats future runtime kinds as files", () => {
    const image: MediaItem = {
        kind: "image",
        name: "a.png",
        mimeType: "image/png",
        size: 1,
        width: 10,
        height: 20,
        thumbhash: "AAAA",
    };
    function dimensions(item: MediaItem): number | null {
        if (isMediaImageItem(item)) {
            expectTypeOf(item.width).toEqualTypeOf<number>();
            expectTypeOf(item.height).toEqualTypeOf<number>();
            expectTypeOf(item.thumbhash).toEqualTypeOf<string>();
            return item.width * item.height;
        }
        return null;
    }
    expect(dimensions(image)).toBe(200);
    const future = Value.Decode(mediaItemSchema, {
        name: "future.dat",
        kind: "future_kind",
        mimeType: "application/example",
        size: 1,
    });
    expect(dimensions(future)).toBeNull();
});

it("classifies images by kind when future measurements exceed today's schema bounds", () => {
    const image: MediaItem = {
        kind: "image",
        name: "a.png",
        mimeType: "image/png",
        size: 1,
        width: 10,
        height: 20,
        scale: 8,
        thumbhash: "A".repeat(256),
    };
    expect(isMediaImageItem(image)).toBe(image.kind === "image");
});
