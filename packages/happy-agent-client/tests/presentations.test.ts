import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    agentSpawnPresentationSchema,
    backgroundTerminalInteractionPresentationSchema,
    execCommandPresentationSchema,
    explorationPresentationSchema,
    fileDiffPresentationSchema,
    searchPresentationSchema,
    slicePresentationSchema,
    toolPresentationSchema,
    type ToolPresentation,
} from "../sources/protocol/messages.js";

const presentations = [
    {
        operations: [
            { kind: "list", target: "sources" },
            { kind: "read", name: "sources/index.ts" },
            {
                command: "Grep Agent",
                kind: "search",
                path: "sources",
                query: "Agent",
            },
        ],
        type: "exploration",
    },
    {
        command: "pnpm test",
        output: "42 passed",
        terminalId: null,
        type: "exec_command",
    },
    {
        command: "pnpm dev",
        input: "y\n",
        terminalId: "terminal1",
        type: "background_terminal_interaction",
    },
    {
        files: [
            {
                added: 1,
                deleted: 1,
                hunks: [
                    {
                        lines: [
                            { kind: "delete", text: "old" },
                            { kind: "add", text: "new" },
                        ],
                        newStart: 12,
                        oldStart: 12,
                    },
                ],
                kind: "update",
                language: "typescript",
                omittedLines: 0,
                path: "sources/index.ts",
            },
        ],
        omittedFiles: 0,
        type: "file_diff",
    },
    {
        query: "thumbhash spec",
        sources: [{ title: "ThumbHash", url: "https://evanw.github.io/thumbhash/" }],
        target: "web",
        type: "search",
    },
    {
        type: "agent_spawn",
        model: {
            modelId: "xai/grok-4.6",
            providerId: "grok",
            name: "Grok 4.6",
        },
        agentId: "tz4a98xxat96iws9zmbrgj3b",
    },
    {
        type: "slice",
        workspaceId: "tz4a98xxat96iws9zmbrgj3b",
        root: "/Users/ada/Projects/happy",
        title: "API schema changes, without tests",
        source: "changes",
        include: ["packages/api/**"],
        exclude: ["*.test.ts"],
        paths: [
            {
                path: "packages/api/schema.ts",
                reason: "Defines the new resource.",
                lines: [{ start: 12, end: 48 }],
            },
        ],
        fileCount: 3,
    },
] satisfies ToolPresentation[];

describe("tool presentation schemas", () => {
    it("accepts every presentation variant through its own schema and the shared union", () => {
        const schemas = [
            explorationPresentationSchema,
            execCommandPresentationSchema,
            backgroundTerminalInteractionPresentationSchema,
            fileDiffPresentationSchema,
            searchPresentationSchema,
            agentSpawnPresentationSchema,
            slicePresentationSchema,
        ];

        expect(
            presentations.map((presentation) => Value.Check(toolPresentationSchema, presentation)),
        ).toEqual([true, true, true, true, true, true, true]);
        expect(
            presentations.map((presentation, index) => Value.Check(schemas[index]!, presentation)),
        ).toEqual([true, true, true, true, true, true, true]);
    });

    it("requires a slice to carry its whole definition and its workspace", () => {
        const slice = presentations[6]!;
        expect(Value.Check(slicePresentationSchema, slice)).toBe(true);
        for (const invalid of [
            { type: "slice" },
            { ...slice, workspaceId: undefined },
            { ...slice, title: "" },
            { ...slice, source: "recent" },
            { ...slice, include: undefined },
            { ...slice, paths: [{ path: "a.ts", lines: [{ start: 0, end: 1 }] }] },
        ]) {
            expect(Value.Check(toolPresentationSchema, invalid)).toBe(false);
        }
    });

    it("accepts unresolved and running spawns but rejects partial or malformed model identity", () => {
        expect(Value.Check(toolPresentationSchema, { type: "agent_spawn" })).toBe(true);
        const model = {
            modelId: "xai/grok-4.6",
            providerId: "grok",
            name: "Grok 4.6",
        };
        expect(Value.Check(agentSpawnPresentationSchema, { type: "agent_spawn", model })).toBe(
            true,
        );
        for (const invalidModel of [
            null,
            {},
            { modelId: model.modelId, providerId: model.providerId },
            { modelId: model.modelId, name: model.name },
            { providerId: model.providerId, name: model.name },
            { ...model, modelId: "" },
            { ...model, providerId: 4 },
            { ...model, name: "x".repeat(257) },
        ]) {
            expect(
                Value.Check(toolPresentationSchema, { type: "agent_spawn", model: invalidModel }),
            ).toBe(false);
        }
    });

    it("rejects unknown variants and malformed bounded counts", () => {
        expect(Value.Check(toolPresentationSchema, { type: "unknown" })).toBe(false);
        expect(
            Value.Check(fileDiffPresentationSchema, {
                files: [
                    {
                        added: -1,
                        deleted: 0,
                        hunks: [],
                        kind: "add",
                        path: "bad.ts",
                    },
                ],
                type: "file_diff",
            }),
        ).toBe(false);
    });
});
