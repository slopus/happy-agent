import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { toLlmParametersSchema } from "@/tools/sanitizeSchema.js";
import { toGrokToolDefinitions } from "@/vendors/grok/impl/toGrokToolDefinitions.js";

describe("tool dictionary schemas", () => {
    it("keeps nonempty secret dictionaries valid on the Grok wire without changing local validation", () => {
        const parameters = Type.Object({
            environment: Type.Optional(
                Type.Record(
                    Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
                    Type.String({ maxLength: 65_536, pattern: "^[^\\u0000]*$" }),
                    { additionalProperties: false, minProperties: 1, maxProperties: 256 },
                ),
            ),
        });
        const original = JSON.stringify(parameters);

        expect(
            toGrokToolDefinitions([{ name: "create_secret", parameters, defer: true }]),
        ).toMatchObject([
            {
                parameters: {
                    properties: {
                        environment: {
                            type: "object",
                            minProperties: 1,
                            maxProperties: 256,
                            additionalProperties: {
                                type: "string",
                                maxLength: 65_536,
                                description: "Must not contain null bytes.",
                            },
                        },
                    },
                },
            },
        ]);
        expect(JSON.stringify(parameters)).toBe(original);
        expect(Value.Check(parameters, { environment: { API_KEY: "line one\nline two" } })).toBe(
            true,
        );
        expect(Value.Check(parameters, { environment: {} })).toBe(false);
        expect(Value.Check(parameters, { environment: { "invalid-name": "value" } })).toBe(false);
        expect(Value.Check(parameters, { environment: { API_KEY: "bad\u0000value" } })).toBe(false);
    });

    it("unions patterned values with a typed fallback and preserves named fields", () => {
        const schema = Type.Object(
            { enabled: Type.Boolean() },
            {
                patternProperties: {
                    "^text_": Type.String(),
                    "^count_": Type.Integer(),
                },
                additionalProperties: Type.Null(),
            },
        );

        expect(toLlmParametersSchema(schema)).toEqual({
            type: "object",
            required: ["enabled"],
            properties: { enabled: { type: "boolean" } },
            additionalProperties: {
                anyOf: [{ type: "string" }, { type: "integer" }, { type: "null" }],
            },
        });
    });

    it("keeps open dictionaries unchanged without exposing recursive value schemas", () => {
        const value = Type.Recursive((self) => Type.Union([Type.String(), Type.Array(self)]), {
            $id: "MetadataValue",
        });
        for (const options of [{}, { additionalProperties: true }]) {
            expect(toLlmParametersSchema(Type.Record(Type.String(), value, options))).toEqual({
                type: "object",
                properties: {},
                ...options,
            });
        }
    });
});
