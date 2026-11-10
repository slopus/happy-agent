import { crc32, deflateSync } from "node:zlib";

import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { messagesOf, uiOf } from "./support/onboardingGym.js";

/**
 * `show_ui`'s `media` component shows files from the agent's machine, pictures and anything else,
 * each with an optional one-line label. It has no layout: clients place the items from the sizes
 * the presentation records.
 */

const running = new Set<AgentGym>();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

/** A real, decodable RGBA PNG, so the daemon measures it as a picture. */
function png(width: number, height: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.byteLength);
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const checksum = Buffer.alloc(4);
        checksum.writeUInt32BE(crc32(body));
        return Buffer.concat([length, body, checksum]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 6, 0, 0, 0], 8);
    const rows = Buffer.alloc((width * 4 + 1) * height);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

/** The first turn shows `props`; after the tool answers, the model stops. */
function showing(props: Record<string, unknown>) {
    return (request: GymInferenceRequest) => {
        if (request.sessionId.endsWith(":title")) {
            return { content: [{ type: "text" as const, text: "<title>Media</title>" }] };
        }
        if (request.messages.at(-1)?.role === "tool") return { content: [] };
        return {
            content: [
                {
                    type: "tool_call" as const,
                    name: "show_ui",
                    arguments: { components: [{ id: "shots", type: "media", props }] },
                },
            ],
        };
    };
}

describe("Showing media", () => {
    it(
        "snapshots each file with its measured size and keeps its label",
        async () => {
            const gym = await createAgentGym({
                files: {
                    "out/login.png": png(6, 4),
                    "out/report.pdf": Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n"),
                },
                inference: showing({
                    items: [{ path: "out/login.png", label: "Login" }, { path: "out/report.pdf" }],
                }),
            });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            const health = await gym.client.getHealth();
            expect(health.capabilities?.chatUi?.components).toContain("media");
            expect(health.capabilities?.chatUi?.components).not.toContain("images");

            await gym.send("Show me what you made.", { permissionMode: "auto" });
            const shown = await gym.waitUntil(async () => {
                const all = await messagesOf(gym, agentId);
                return all.find((message) => uiOf(message) !== undefined);
            }, "the media to be shown");
            const call = shown.content.find((block) => block.type === "tool_call") as unknown as {
                id: string;
                presentation: { items: Record<string, unknown>[] };
            };
            expect(uiOf(shown)?.components).toEqual([
                {
                    id: "shots",
                    type: "media",
                    fallback: "2 files: Login",
                    props: { items: [{ mediaIndex: 0, label: "Login" }, { mediaIndex: 1 }] },
                },
            ]);
            expect(call.presentation.items).toMatchObject([
                { kind: "image", name: "login.png", width: 6, height: 4 },
                { kind: "document", name: "report.pdf" },
            ]);
            const served = await gym.http.request(
                "GET",
                `/v0/agents/${agentId}/tool-calls/${call.id}/media/1`,
            );
            expect(served.status).toBe(200);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuses a layout, so the model learns media has none",
        async () => {
            const gym = await createAgentGym({
                files: { "out/login.png": png(6, 4) },
                inference: showing({ items: [{ path: "out/login.png" }], columns: 2 }),
            });
            running.add(gym);
            await gym.send("Show me what you made.", { permissionMode: "auto" });
            const result = await gym.waitUntil(
                async () => gym.inference.toolResults().at(-1),
                "show_ui to answer",
            );
            expect(result.text).toContain("Nothing was shown.");
            expect(result.text).toContain("columns");
            const all = await messagesOf(gym, gym.defaultSessionId);
            expect(all.some((message) => uiOf(message) !== undefined)).toBe(false);
        },
        TEST_TIMEOUT_MS,
    );
});
