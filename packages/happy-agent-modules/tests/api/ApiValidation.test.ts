import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { apiValidator } from "../../sources/api/impl/apiValidator.js";
import { historyToolPresentationSchema } from "../../sources/history/index.js";

describe("compiled API projection checks", () => {
    it("reuses one validator per schema without retaining checked values", () => {
        const schema = Type.Object({ command: Type.String() }, { additionalProperties: false });
        const validator = apiValidator(schema);
        const input: { command: unknown } = { command: "ls" };
        expect(validator.Check(input)).toBe(true);
        input.command = 1;
        expect(validator.Check(input)).toBe(false);
        expect(apiValidator(schema)).toBe(validator);
    });

    it("accepts and rejects tool presentations exactly as the interpreted check does", () => {
        // Value.Create would build the first union member, and an empty Gen UI document is invalid.
        const created = {
            type: "gen_ui",
            document: {
                genuiRender: 1,
                compiler: "1.0.0",
                root: "text",
                elements: { text: { type: "text", props: { text: "Revenue was $1.24M." } } },
            },
        };
        expect(Value.Check(historyToolPresentationSchema, created)).toBe(true);
        for (const input of [
            created,
            { ...created, extra: true },
            { ...created, document: { ...created.document, elements: {} } },
            { type: "unknown" },
            [],
            {},
            null,
            "text",
        ]) {
            expect(apiValidator(historyToolPresentationSchema).Check(input)).toBe(
                Value.Check(historyToolPresentationSchema, input),
            );
        }
    });
});
