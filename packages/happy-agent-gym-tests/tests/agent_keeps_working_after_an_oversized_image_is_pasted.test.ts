import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";
import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";

/** Anthropic refuses an image whose base64 text is larger than this, before any request is sent. */
const ANTHROPIC_IMAGE_BASE64_LIMIT = 5 * 1024 * 1024;

const REFERENCE =
    /^\[Image attached here, saved at (\S+) \(image\/png, [\d.]+ MiB\)\. It is not shown inline; open the file with your file-reading tool to see it\.\]$/u;

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("an oversized pasted image", () => {
    it("reaches the model as a file reference on every turn, including after a restart", async () => {
        const gym = await createAgentGym({
            inference: [
                { content: [{ type: "text", text: "I see two screenshots." }] },
                { content: [{ type: "text", text: "Yo." }] },
                { content: [{ type: "text", text: "Still here." }] },
            ],
        });
        running.add(gym);
        const screenshot = noisePng(1600, 1200);
        expect(screenshot.length).toBeGreaterThan(ANTHROPIC_IMAGE_BASE64_LIMIT);
        const mode = { ...gym.selection, permissionMode: "auto" as const, serviceTier: null };

        const sent = await gym.client.sendMessage(gym.defaultSessionId, {
            text: "Look at these",
            content: [
                { type: "text", text: "Look at these" },
                { type: "image", mimeType: "image/png", data: screenshot },
                { type: "image", mimeType: "image/png", data: screenshot },
            ],
            mode,
        });
        await gym.waitForEvent((event) => event.type === "run.finished", "the first turn");
        await gym.send("yo");
        await gym.restart();
        await gym.send("still there?");

        expect(gym.inference.requests).toHaveLength(3);
        const [path] = references(gym.inference.requests[0]!.messages);
        for (const request of gym.inference.requests) {
            expect(sentImages(request.messages)).toEqual([]);
            // Both copies name one saved file, and every turn replays the same reference.
            expect(references(request.messages)).toEqual([path, path]);
        }
        expect(path!.startsWith(join(gym.happyHome, "cache", "images"))).toBe(true);
        expect((await readFile(path!)).toString("base64")).toBe(screenshot);

        // People still see the picture they sent.
        const history = await gym.client.getMessages(gym.defaultSessionId);
        const first = history.runs.flatMap((run) => run.messages)[0];
        expect(first).toMatchObject({ id: sent.message.id });
        expect(first!.content).toContainEqual({
            type: "image",
            mimeType: "image/png",
            data: screenshot,
        });
        expect(JSON.stringify(await gym.sessionEvents())).toContain("Still here.");
        expect(gym.inference.unscripted).toEqual([]);
        expect(gym.errors).toEqual([]);
    }, 60_000);
});

function references(messages: GymInferenceRequest["messages"]): string[] {
    return messages.flatMap((message) =>
        message.role === "user"
            ? message.content.flatMap((block) => {
                  const path = block.type === "text" ? REFERENCE.exec(block.text)?.[1] : undefined;
                  return path === undefined ? [] : [path];
              })
            : [],
    );
}

function sentImages(messages: GymInferenceRequest["messages"]): unknown[] {
    return messages.flatMap((message) =>
        message.role === "user" || message.role === "system" || message.role === "agent"
            ? message.content.filter((block) => block.type === "image")
            : [],
    );
}

/** A PNG of pseudo-random pixels, which nothing can compress, as base64. */
function noisePng(width: number, height: number): string {
    const rows = Buffer.alloc((width * 3 + 1) * height);
    let state = 0x9e3779b9;
    for (let index = 0; index < rows.length; index += 1) {
        if (index % (width * 3 + 1) === 0) continue;
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        rows[index] = state & 0xff;
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]).toString("base64");
}

function chunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function crc32(bytes: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}
