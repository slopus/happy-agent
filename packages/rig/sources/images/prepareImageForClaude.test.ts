import { describe, expect, it } from "vitest";

import { validJpeg32Base64, validPng32Base64 } from "../testing/validImageFixtures.js";
import { getImageProcessor } from "./getImageProcessor.js";
import {
    CLAUDE_IMAGE_MAX_DIMENSION,
    CLAUDE_IMAGE_MAX_RAW_BYTES,
    prepareImageForClaude,
} from "./prepareImageForClaude.js";

describe("prepareImageForClaude", () => {
    it("preserves a supported image that already satisfies Claude's limits", async () => {
        const input = Buffer.from(validPng32Base64, "base64");
        const prepared = await prepareImageForClaude(input);

        expect(prepared).toEqual({
            bytes: input,
            height: 32,
            mediaType: "image/png",
            width: 32,
        });
    });

    it("accepts Claude's JPEG, PNG, GIF, and WebP image formats", async () => {
        const sharp = await getImageProcessor();
        const source = {
            create: {
                width: 8,
                height: 8,
                channels: 3 as const,
                background: { r: 30, g: 60, b: 90 },
            },
        };
        const images = [
            {
                bytes: Buffer.from(validJpeg32Base64, "base64"),
                mediaType: "image/jpeg",
            },
            {
                bytes: Buffer.from(validPng32Base64, "base64"),
                mediaType: "image/png",
            },
            {
                bytes: await sharp(source).gif().toBuffer(),
                mediaType: "image/gif",
            },
            {
                bytes: await sharp(source).webp().toBuffer(),
                mediaType: "image/webp",
            },
        ] as const;

        for (const image of images) {
            const prepared = await prepareImageForClaude(image.bytes);
            expect(prepared.mediaType).toBe(image.mediaType);
            expect(prepared.bytes.equals(image.bytes)).toBe(true);
        }
    });

    it("resizes oversized dimensions to Claude's 2000-pixel boundary", async () => {
        const sharp = await getImageProcessor();
        const input = await sharp({
            create: {
                width: 2400,
                height: 1200,
                channels: 3,
                background: { r: 30, g: 60, b: 90 },
            },
        })
            .png()
            .toBuffer();

        const prepared = await prepareImageForClaude(input);
        const metadata = await sharp(prepared.bytes).metadata();

        expect(prepared.width).toBe(CLAUDE_IMAGE_MAX_DIMENSION);
        expect(prepared.height).toBe(1000);
        expect(metadata.width).toBe(2000);
        expect(metadata.height).toBe(1000);
    });

    it("compresses images to fit Claude's base64 request limit", async () => {
        const sharp = await getImageProcessor();
        const input = await sharp({
            create: {
                width: 1024,
                height: 1024,
                channels: 4,
                background: { r: 30, g: 60, b: 90, alpha: 0.5 },
            },
        })
            .png({ compressionLevel: 0 })
            .toBuffer();
        expect(input.length).toBeGreaterThan(CLAUDE_IMAGE_MAX_RAW_BYTES);

        const prepared = await prepareImageForClaude(input);

        expect(prepared.bytes.length).toBeLessThanOrEqual(CLAUDE_IMAGE_MAX_RAW_BYTES);
        expect(prepared.mediaType).toBe("image/png");
        expect(prepared.width).toBe(1024);
        expect(prepared.height).toBe(1024);
    });

    it("normalizes other decodable raster formats to an API-supported format", async () => {
        const sharp = await getImageProcessor();
        const input = await sharp({
            create: {
                width: 8,
                height: 8,
                channels: 3,
                background: { r: 30, g: 60, b: 90 },
            },
        })
            .tiff()
            .toBuffer();

        const prepared = await prepareImageForClaude(input);

        expect(prepared.mediaType).toBe("image/png");
        await expect(sharp(prepared.bytes).stats()).resolves.toBeDefined();
    });
});
