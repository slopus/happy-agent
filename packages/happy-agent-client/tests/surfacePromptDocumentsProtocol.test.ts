import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { surfaceCreatedPayloadSchema } from "../sources/protocol/events.js";
import {
    surfaceListResponseSchema,
    surfacePromptDocumentSchema,
    surfaceSchema,
    type Surface,
} from "../sources/protocol/surfaces.js";

const surface: Surface = {
    id: "s12345678901234567890123",
    name: "Release process",
    type: "document",
    image: null,
    members: [],
    creatorUserId: null,
    version: "01991f3a-5c1e-7000-8000-2f9a1b3c4d5e",
    updatedAt: 1_755_400_000_000,
};

describe("Important document protocol", () => {
    it("accepts a document Surface that is, is not, or does not say whether it is important", () => {
        for (const promptDocument of [
            undefined,
            null,
            { description: "Read before releasing anything." },
            { description: "Read before releasing anything.", name: "Releases" },
        ]) {
            const candidate =
                promptDocument === undefined ? surface : { ...surface, promptDocument };
            expect(Value.Check(surfaceSchema, candidate)).toBe(true);
            expect(
                Value.Check(surfaceListResponseSchema, {
                    cursor: "0",
                    surfaces: [candidate],
                }),
            ).toBe(true);
        }
    });

    it("bounds the description and name and admits nothing else", () => {
        for (const invalid of [
            {},
            { description: "" },
            { description: "   " },
            { description: "x".repeat(1_025) },
            { description: "Fine.", name: "" },
            { description: "Fine.", name: "Bad\u0007name" },
            { description: "Fine.", markedAt: 1 },
        ]) {
            expect(Value.Check(surfacePromptDocumentSchema, invalid)).toBe(false);
            expect(Value.Check(surfaceSchema, { ...surface, promptDocument: invalid })).toBe(false);
        }
        expect(Value.Check(surfacePromptDocumentSchema, { description: "x".repeat(1_024) })).toBe(
            true,
        );
    });

    it("keeps the read-time projection out of shared creation events", () => {
        expect(Value.Check(surfaceCreatedPayloadSchema, { surface })).toBe(true);
        expect(
            Value.Check(surfaceCreatedPayloadSchema, {
                surface: { ...surface, promptDocument: null },
            }),
        ).toBe(false);
    });
});
