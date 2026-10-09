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
        const created = Value.Create(historyToolPresentationSchema);
        expect(Value.Check(historyToolPresentationSchema, created)).toBe(true);
        for (const input of [
            created,
            { ...(created as object), extra: true },
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
