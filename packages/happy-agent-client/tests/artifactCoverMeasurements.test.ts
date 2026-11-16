import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    artifactCoverSchema,
    artifactSchema,
    artifactVersionSchema,
    type ArtifactCover,
} from "../sources/protocol/artifacts.js";
import { artifactUpdatedChangesSchema } from "../sources/protocol/events.js";

const legacyCover = {
    path: "cover.webp",
    mimeType: "image/webp",
    width: 1600,
    height: 900,
    aspect: "wide",
};

describe("artifact cover shared measurements", () => {
    it("exposes optional measurements in the public cover type", () => {
        const cover: ArtifactCover = {
            ...legacyCover,
            kind: "image",
            scale: 2,
            durationMs: 0,
            animated: true,
            preview: { width: 640, height: 360 },
            thumbhash: "AAAA",
        };
        expect(Value.Check(artifactCoverSchema, cover)).toBe(true);
        expect(Value.Check(artifactCoverSchema, { ...cover, kind: "future-picture" })).toBe(true);
        expect(Value.Check(artifactCoverSchema, { ...cover, scale: 4 })).toBe(true);
    });

    it("accepts legacy covers without the new fields, including a null ThumbHash", () => {
        expect(Value.Check(artifactCoverSchema, legacyCover)).toBe(true);
        expect(Value.Check(artifactCoverSchema, { ...legacyCover, thumbhash: null })).toBe(true);
    });

    it.each([
        { kind: 1 },
        { scale: 1 },
        { scale: 4.01 },
        { scale: "2" },
        { durationMs: -1 },
        { durationMs: 0.5 },
        { durationMs: "0" },
        { animated: false },
        { animated: "true" },
    ])("rejects invalid shared measurements %j in every embedded cover", (invalid) => {
        const cover = { ...legacyCover, ...invalid };
        for (const schema of [
            artifactCoverSchema,
            artifactSchema.properties.cover,
            artifactVersionSchema.properties.cover,
            artifactUpdatedChangesSchema.properties.cover,
        ]) {
            expect(Value.Check(schema, cover)).toBe(false);
        }
    });
});
