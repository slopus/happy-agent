import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    MAX_SLASH_COMMAND_CATALOG_BYTES,
    MAX_SLASH_COMMANDS,
    invokeSlashCommandRequestSchema,
    slashCommandCatalogSchema,
    slashCommandSchema,
} from "../sources/protocol/slashCommands.js";

describe("slash command protocol", () => {
    it.each([257, 1_025, 10_000])("accepts the complete catalog of %i skills", (count) => {
        const catalog = Array.from({ length: count }, (_, index) => ({
            description: "d".repeat(1_024),
            hasArguments: true,
            kind: "skill",
            name: `skill-${String(index).padStart(5, "0")}`,
        }));
        expect(Buffer.byteLength(JSON.stringify(catalog))).toBeGreaterThan(256 * 1_024);
        expect(Value.Check(slashCommandCatalogSchema, catalog)).toBe(true);
        expect(slashCommandCatalogSchema.maxItems).toBeUndefined();
        expect(MAX_SLASH_COMMANDS).toBe(Infinity);
        expect(MAX_SLASH_COMMAND_CATALOG_BYTES).toBe(Infinity);
    });

    it("still validates every entry in a large catalog", () => {
        const catalog = Array.from({ length: 10_000 }, (_, index) => ({
            description: "Review changes.",
            hasArguments: true,
            name: `skill-${index}`,
        }));
        catalog[9_999]!.description = "d".repeat(1_025);
        expect(Value.Check(slashCommandCatalogSchema, catalog)).toBe(false);
        catalog[9_999]!.description = "Review changes.";
        catalog[9_999]!.name = "/invalid";
        expect(Value.Check(slashCommandCatalogSchema, catalog)).toBe(false);
    });

    it("carries arguments, kinds, and lightweight artwork metadata", () => {
        const command = {
            description: "Review the current changes.",
            hasArguments: true,
            image: {
                thumbhash: "1QcSHQRnh493V4dIh4eXh1h4kJUI",
            },
            kind: "skill",
            name: "code-review",
        };

        expect(Value.Check(slashCommandSchema, command)).toBe(true);
        expect(Value.Check(slashCommandCatalogSchema, [command])).toBe(true);
    });

    it("keeps the leading slash out of command names", () => {
        expect(
            Value.Check(slashCommandSchema, {
                description: "Compact context.",
                hasArguments: false,
                kind: "compaction",
                name: "/compact",
            }),
        ).toBe(false);
    });

    it("requires the complete composer mode for an invocation", () => {
        expect(
            Value.Check(invokeSlashCommandRequestSchema, {
                arguments: "focus on authentication",
                mode: {
                    effort: "medium",
                    modelId: "openai/gpt-5.6-sol",
                    permissionMode: "auto",
                    providerId: "codex",
                    serviceTier: null,
                },
                mutationId: "command1",
            }),
        ).toBe(true);
        expect(Value.Check(invokeSlashCommandRequestSchema, {})).toBe(false);
    });
});
