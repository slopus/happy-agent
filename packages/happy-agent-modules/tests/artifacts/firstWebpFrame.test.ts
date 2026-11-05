import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { firstWebpFrame } from "../../sources/artifacts/impl/firstWebpFrame.js";

async function animation(options: { quality?: number; lossless?: boolean }): Promise<Uint8Array> {
    const frames = await Promise.all(
        [
            { r: 255, g: 0, b: 0, alpha: 0.5 },
            { r: 0, g: 0, b: 255, alpha: 1 },
        ].map((background) =>
            sharp({ create: { width: 96, height: 54, channels: 4, background } })
                .png()
                .toBuffer(),
        ),
    );
    return await sharp(frames, { join: { animated: true } })
        .webp({ loop: 0, ...options })
        .toBuffer();
}

describe("firstWebpFrame", () => {
    it.each([
        ["lossy with alpha", { quality: 80 }],
        ["lossless", { lossless: true }],
    ])("rewraps a %s animation's first frame as a still WebP", async (_, options) => {
        const still = firstWebpFrame(await animation(options))!;
        const metadata = await sharp(still).metadata();
        expect(metadata).toMatchObject({ format: "webp", width: 96, height: 54 });
        expect(metadata.pages ?? 1).toBe(1);
        const { data } = await sharp(still).raw().toBuffer({ resolveWithObject: true });
        expect(data[0]).toBeGreaterThan(200);
        expect(data[2]).toBeLessThan(40);
        expect(data[3]).toBeGreaterThan(100);
        expect(data[3]).toBeLessThan(160);
    });

    it("leaves a still WebP and other bytes alone, and refuses an animation without frames", async () => {
        const still = new Uint8Array(
            await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } })
                .webp()
                .toBuffer(),
        );
        expect(firstWebpFrame(still)).toBe(still);
        const gif = new Uint8Array(Buffer.from("GIF89a"));
        expect(firstWebpFrame(gif)).toBe(gif);
        const animated = await animation({ quality: 80 });
        const header = Buffer.from(animated.subarray(0, 12 + 8 + 10));
        header.writeUInt32LE(header.byteLength - 8, 4);
        expect(firstWebpFrame(header)).toBeUndefined();
    });
});
