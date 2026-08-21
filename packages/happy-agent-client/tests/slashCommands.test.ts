import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    invokeSlashCommandRequestSchema,
    slashCommandCatalogSchema,
    slashCommandSchema,
} from "../sources/protocol/slashCommands.js";

describe("slash command protocol", () => {
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
