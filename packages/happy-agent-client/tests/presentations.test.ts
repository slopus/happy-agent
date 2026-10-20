import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { HappyAgentClient } from "../sources/HappyAgentClient.js";
import {
    agentSpawnPresentationSchema,
    artifactPresentationSchema,
    backgroundTerminalInteractionPresentationSchema,
    execCommandPresentationSchema,
    explorationPresentationSchema,
    fileDiffPresentationSchema,
    mediaPresentationSchema,
    pagePresentationSchema,
    searchPresentationSchema,
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
        type: "media",
        items: [
            {
                kind: "image",
                name: "tz4a98xxat96iws9zmbrgj3b.png",
                mimeType: "image/png",
                size: 1_843_200,
                width: 1024,
                height: 1024,
                thumbhash: "3OcRJYB4d3h/iIeHeEh3eIhw+j3A",
            },
            { kind: "video", name: "demo.mp4", mimeType: "video/mp4", size: 52_428_800 },
            { kind: "document", name: "report.pdf", mimeType: "application/pdf", size: 482_113 },
            { kind: "file", name: "data", mimeType: "application/octet-stream", size: 0 },
        ],
    },
    {
        type: "artifact",
        artifactId: "r7k2m9q4w1e5t8y3u6i0o2p5",
        version: 3,
        artifactType: "markdown",
        title: "Q3 revenue report",
    },
    {
        type: "page",
        url: "http://localhost:5173/",
        title: "Shop preview",
        display: null,
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
            mediaPresentationSchema,
            artifactPresentationSchema,
            pagePresentationSchema,
        ];

        expect(
            presentations.map((presentation) => Value.Check(toolPresentationSchema, presentation)),
        ).toEqual(presentations.map(() => true));
        expect(
            presentations.map((presentation, index) => Value.Check(schemas[index]!, presentation)),
        ).toEqual(presentations.map(() => true));
    });

    it("says which version an artifact shows, and how a page asks to be shown", () => {
        const artifact = {
            type: "artifact",
            artifactId: "r7k2m9q4w1e5t8y3u6i0o2p5",
            version: 2,
            artifactType: "html",
            title: "Q3 at a glance",
        };
        expect(Value.Check(artifactPresentationSchema, artifact)).toBe(true);
        for (const shows of ["latest", "version"]) {
            expect(Value.Check(artifactPresentationSchema, { ...artifact, shows })).toBe(true);
        }
        expect(Value.Check(artifactPresentationSchema, { ...artifact, shows: "first" })).toBe(
            false,
        );

        const page = { type: "page", url: "http://localhost:5173/", title: "Shop preview" };
        for (const display of [null, "inline_compact", "inline_expanded", "side"]) {
            expect(Value.Check(pagePresentationSchema, { ...page, display })).toBe(true);
        }
        expect(Value.Check(pagePresentationSchema, page)).toBe(false);
        expect(Value.Check(pagePresentationSchema, { ...page, display: "modal" })).toBe(false);
        expect(Value.Check(pagePresentationSchema, { ...page, url: "", display: null })).toBe(
            false,
        );
    });

    it("requires measured images and bounds media items", () => {
        const image = {
            kind: "image",
            name: "chart.png",
            mimeType: "image/png",
            size: 10,
            width: 4,
            height: 3,
            thumbhash: "AAAA",
        };
        const media = (items: unknown[]) => ({ type: "media", items });
        expect(Value.Check(mediaPresentationSchema, media([image]))).toBe(true);
        for (const missing of ["width", "height", "thumbhash"]) {
            const { [missing]: _omitted, ...partial } = image as Record<string, unknown>;
            expect(Value.Check(mediaPresentationSchema, media([partial]))).toBe(false);
        }
        expect(Value.Check(mediaPresentationSchema, media([{ ...image, width: 0 }]))).toBe(false);
        expect(Value.Check(mediaPresentationSchema, media([]))).toBe(false);
        expect(Value.Check(mediaPresentationSchema, media(Array(11).fill(image)))).toBe(false);
        expect(
            Value.Check(
                mediaPresentationSchema,
                media([{ kind: "file", name: "", mimeType: "text/plain", size: 1 }]),
            ),
        ).toBe(false);
        expect(
            Value.Check(artifactPresentationSchema, {
                type: "artifact",
                artifactId: "r7k2m9q4w1e5t8y3u6i0o2p5",
                version: 0,
                artifactType: "markdown",
                title: "Q3",
            }),
        ).toBe(false);
    });

    it("reads one media item's bytes and ranges by index", async () => {
        const requests: Request[] = [];
        const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            requests.push(request);
            if (request.headers.get("if-none-match") === '"digest"') {
                return new Response(null, { status: 304 });
            }
            if (request.headers.get("range") !== null) {
                return new Response(new Uint8Array([2, 3]), {
                    headers: { "content-range": "bytes 1-2/3", "content-type": "video/mp4" },
                    status: 206,
                });
            }
            return new Response(new Uint8Array([1, 2, 3]), {
                headers: { "content-type": "video/mp4", etag: '"digest"' },
                status: 200,
            });
        };
        const client = new HappyAgentClient({ endpoint: "http://agent.local", token: "t", fetch });
        const url = "http://agent.local/v0/agents/agent1/tool-calls/call1/media/2";

        const whole = await client.getToolCallMedia("agent1", "call1", 2);
        expect(whole).toMatchObject({
            contentRange: null,
            contentType: "video/mp4",
            etag: '"digest"',
        });
        expect([...new Uint8Array(whole?.data ?? new ArrayBuffer(0))]).toEqual([1, 2, 3]);
        expect(requests[0]?.url).toBe(url);
        expect(requests[0]?.headers.get("accept")).toBe("*/*");
        const range = await client.getToolCallMedia("agent1", "call1", 2, {
            range: { start: 1, end: 2 },
        });
        expect(range?.contentRange).toBe("bytes 1-2/3");
        expect(requests[1]?.headers.get("range")).toBe("bytes=1-2");
        await expect(
            client.getToolCallMedia("agent1", "call1", 2, { ifNoneMatch: '"digest"' }),
        ).resolves.toBeNull();
        expect(client.toolCallMediaUrl("agent1", "call1", 2)).toBe(url);
        expect(() => client.toolCallMediaUrl("agent1", "call1", -1)).toThrow(TypeError);
        expect(() => client.toolCallMediaUrl("agent1", "call1", 1.5)).toThrow(TypeError);
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
