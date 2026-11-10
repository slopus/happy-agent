import { crc32, deflateSync } from "node:zlib";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { messagesOf, showing, shownIn, uiOf } from "./support/chatUiGym.js";

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

const PDF = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");

describe("Showing media", () => {
    it(
        "snapshots each file with its measured size, keeps its label, and serves its bytes",
        async () => {
            const gym = await createAgentGym({
                files: {
                    "out/login.png": png(6, 4),
                    "out/home.png": png(4, 8),
                    "out/report.pdf": PDF,
                },
                inference: showing([
                    {
                        id: "shots",
                        type: "media",
                        props: {
                            items: [
                                { path: "out/login.png", label: "Login" },
                                { path: "out/home.png", label: "Home" },
                            ],
                        },
                    },
                    { id: "tree", type: "file_tree", props: { paths: ["out/report.pdf"] } },
                    { id: "paper", type: "media", props: { items: [{ path: "out/report.pdf" }] } },
                ]),
            });
            running.add(gym);
            const agentId = gym.defaultSessionId;

            await gym.send("Show me what you made.", { permissionMode: "auto" });
            const shown = await shownIn(gym, agentId);
            const call = shown.content.find((block) => block.type === "tool_call") as unknown as {
                id: string;
                presentation: { items: Record<string, unknown>[] };
            };
            // Both media components name their files in the call's one list.
            expect(uiOf(shown)?.components).toEqual([
                {
                    id: "shots",
                    type: "media",
                    fallback: "2 images: Login · Home",
                    props: {
                        items: [
                            { mediaIndex: 0, label: "Login" },
                            { mediaIndex: 1, label: "Home" },
                        ],
                    },
                },
                {
                    id: "tree",
                    type: "file_tree",
                    fallback: "out/report.pdf",
                    props: { paths: ["out/report.pdf"] },
                },
                {
                    id: "paper",
                    type: "media",
                    fallback: "1 file",
                    props: { items: [{ mediaIndex: 2 }] },
                },
            ]);
            // The items are those of a `media` presentation: measured, and without their digest.
            expect(call.presentation.items).toMatchObject([
                { kind: "image", name: "login.png", mimeType: "image/png", width: 6, height: 4 },
                { kind: "image", name: "home.png", mimeType: "image/png", width: 4, height: 8 },
                { kind: "document", name: "report.pdf", mimeType: "application/pdf" },
            ]);
            expect(JSON.stringify(call.presentation.items)).not.toContain("sha256");

            for (const [index, bytes] of [
                [0, png(6, 4)],
                [2, PDF],
            ] as const) {
                // The same call a client makes for a `media` presentation's item.
                const served = await gym.client.getToolCallMedia(agentId, call.id, index);
                expect(Buffer.from(served!.data)).toEqual(bytes);
            }
            const beyond = await gym.http.request(
                "GET",
                `/v0/agents/${agentId}/tool-calls/${call.id}/media/3`,
            );
            expect(beyond.status).toBe(404);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuses a layout, so the model learns media has none",
        async () => {
            const gym = await createAgentGym({
                files: { "out/login.png": png(6, 4) },
                inference: showing([
                    {
                        id: "shots",
                        type: "media",
                        props: { items: [{ path: "out/login.png" }], columns: 2 },
                    },
                ]),
            });
            running.add(gym);
            await gym.send("Show me what you made.", { permissionMode: "auto" });
            const result = await gym.waitUntil(
                async () => gym.inference.toolResults().at(-1),
                "show_ui to answer",
            );
            expect(result.text).toContain("Nothing was shown.");
            expect(result.text).toContain("shots: the media props are invalid");
            const all = await messagesOf(gym, gym.defaultSessionId);
            expect(all.some((message) => uiOf(message) !== undefined)).toBe(false);
        },
        TEST_TIMEOUT_MS,
    );
});
