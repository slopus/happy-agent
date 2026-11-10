import { crc32, deflateSync } from "node:zlib";

import {
    mediaSourceMatches,
    parseMediaLayoutHtml,
    splitMediaLayoutBlocks,
    type MediaItem,
} from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** A real, decodable RGB PNG, so the daemon measures it as a picture. */
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
    header.set([8, 2, 0, 0, 0], 8);
    const rows = Buffer.alloc((width * 3 + 1) * height);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const LAYOUT =
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">\n\n' +
    '  <figure><img src="shots/before.png"><figcaption>Before</figcaption></figure>\n\n' +
    '  <figure><img src="ABSOLUTE_AFTER"><figcaption>After</figcaption></figure>\n' +
    "</div>\n";

describe("an agent's reply lays out media it already showed", () => {
    it("keeps the HTML in its text and names earlier media by the paths they came from", async () => {
        let layout = "";
        let agentId = "";
        const gym = await createAgentGym({
            timeoutMs: 20_000,
            files: { "shots/before.png": png(16, 9), "shots/after.png": png(9, 16) },
            inference: (request) => {
                // Side requests, such as naming the chat, are not the conversation.
                if (request.sessionId !== agentId) {
                    return { content: [{ type: "text", text: "<title>Shots</title>" }] };
                }
                const last = request.messages.at(-1);
                if (last?.role !== "tool") {
                    return {
                        content: [
                            {
                                type: "tool_call",
                                name: "view_image",
                                arguments: { path: "shots/before.png" },
                            },
                            {
                                type: "tool_call",
                                name: "present_files",
                                arguments: { filepaths: ["shots/after.png"] },
                            },
                        ],
                    };
                }
                return {
                    content: [
                        {
                            type: "text",
                            text: `Side by side:\n${layout}\nThe after shot is taller.`,
                        },
                    ],
                };
            },
        });
        running.add(gym);
        agentId = gym.defaultSessionId;
        layout = LAYOUT.replace("ABSOLUTE_AFTER", `${gym.workspacePath}/shots/after.png`);

        await gym.send("Compare the shots.", { permissionMode: "auto" });

        // Layouts in text are legacy: the agent is taught show_ui's media component instead, and
        // a layout it still writes keeps rendering.
        const conversation = gym.inference.requests.filter(
            (request) => request.sessionId === agentId,
        );
        expect(conversation[0]?.instructions).toContain(
            "use the media component of show_ui instead of HTML in your reply",
        );

        const page = await gym.client.getMessages(gym.defaultSessionId);
        const content = page.runs
            .flatMap((run) => run.messages)
            .filter((message) => message.role === "agent")
            .flatMap((message) => message.content);
        // Every media item shown earlier in the conversation, oldest first.
        const shown: MediaItem[] = content.flatMap((block) =>
            block.type === "tool_call" && block.presentation?.type === "media"
                ? block.presentation.items
                : [],
        );
        expect(shown.map((item) => item.source)).toEqual([
            {
                path: "shots/before.png",
                absolutePath: `${gym.workspacePath}/shots/before.png`,
            },
            { path: "shots/after.png", absolutePath: `${gym.workspacePath}/shots/after.png` },
        ]);

        // The daemon stores the reply exactly as written; the client finds and reads the block.
        const text = content.flatMap((block) => (block.type === "text" ? [block.text] : []));
        expect(text).toEqual([`Side by side:\n${layout}\nThe after shot is taller.`]);
        const segments = splitMediaLayoutBlocks(text[0]!);
        expect(segments).toEqual([
            { type: "markdown", text: "Side by side:\n" },
            { type: "layout", html: layout, complete: true },
            { type: "markdown", text: "\nThe after shot is taller." },
        ]);
        const placed: MediaItem[] = [];
        const parsed = parseMediaLayoutHtml(layout, (src) => {
            const item = shown.findLast((candidate) => mediaSourceMatches(candidate.source, src));
            if (item === undefined) return undefined;
            placed.push(item);
            return placed.length - 1;
        });
        expect(parsed.ignored).toEqual([]);
        expect(parsed.placed).toEqual([0, 1]);
        expect(placed.map((item) => [item.width, item.height])).toEqual([
            [16, 9],
            [9, 16],
        ]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
