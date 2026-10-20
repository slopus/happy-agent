import { createHash } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { crc32, deflateSync } from "node:zlib";

import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
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
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            rows.set([40 * x, 30 * y, 200, 255], y * (width * 4 + 1) + 1 + x * 4);
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        chunk("IDAT", deflateSync(rows)),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

const CHART = png(6, 4);
const REPORT = Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");
const CLIP = Buffer.from(Array.from({ length: 64 }, (_, index) => index));

interface MediaResponse {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly body: Buffer;
}

/**
 * A raw probe of the media route, for exact assertions about the caching and security headers the
 * typed client does not surface.
 */
async function media(
    gym: AgentGym,
    path: string,
    headers: Record<string, string> = {},
): Promise<MediaResponse> {
    return await new Promise((resolve, reject) => {
        const call = httpRequest(
            {
                headers: { authorization: `Bearer ${gym.http.token}`, ...headers },
                method: "GET",
                path,
                socketPath: gym.http.socketPath,
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () =>
                    resolve({
                        status: response.statusCode ?? 0,
                        headers: response.headers,
                        body: Buffer.concat(chunks),
                    }),
                );
            },
        );
        call.on("error", reject);
        call.end();
    });
}

/** A gym whose model makes exactly the tool call a scenario asks for. */
async function harness() {
    const commands = new Map<string, { callId: string; turn: GymTurn }>();
    const gym = await createAgentGym({
        timeoutMs: 20_000,
        files: {
            "out/chart.png": CHART,
            "out/report.pdf": REPORT,
            "out/clip.mp4": CLIP,
        },
        inference: (request) => {
            const command = commands.get(request.sessionId);
            if (
                command !== undefined &&
                JSON.stringify(request.messages).includes(command.callId)
            ) {
                commands.delete(request.sessionId);
                return command.turn;
            }
            return { content: [{ type: "text", text: "Done." }] };
        },
    });
    running.add(gym);
    let callIndex = 0;
    async function call(name: string, args: Record<string, unknown>) {
        const callId = `media_test_${String(++callIndex)}`;
        const agentId = gym.defaultSessionId;
        commands.set(agentId, {
            callId,
            turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
        });
        await gym.send(`Please execute ${name}, request ${callId}.`, {
            sessionId: agentId,
            permissionMode: "auto",
        });
        const result = await gym.waitUntil(
            async () => gym.inference.toolResults().find((item) => item.callId === callId),
            "the tool result",
        );
        return { result, block: await toolBlock(gym, name, callIndex) };
    }
    return { gym, call };
}

/** The n-th call of a tool in the agent's history, as clients read it. */
async function toolBlock(gym: AgentGym, name: string, nth: number, omitToolData = false) {
    const page = await gym.client.getMessages(gym.defaultSessionId, { omitToolData });
    const blocks = page.runs
        .flatMap((run) => run.messages)
        .flatMap((message) => message.content)
        .filter((block) => block.type === "tool_call" && block.name === name);
    const found = blocks[blocks.length === 0 ? 0 : Math.min(nth, blocks.length) - 1];
    if (found === undefined || found.type !== "tool_call") {
        throw new Error(`History has no ${name} call.`);
    }
    return found as typeof found & { presentation?: Record<string, unknown> };
}

describe("tool calls present media and artifacts in the chat", () => {
    it("shows presented files inline and serves each item's snapshot by call and position", async () => {
        const { gym, call } = await harness();
        const agentId = gym.defaultSessionId;
        const before = (await gym.client.getEvents()).latestCursor;

        const { result, block } = await call("present_files", {
            filepaths: ["out/chart.png", "out/report.pdf", "./out/clip.mp4"],
        });
        expect(result.text).toContain("Presented 3 files to the user in this chat");
        expect(result.text).toContain("not in any parent or child chat");

        const presentation = {
            type: "media",
            items: [
                {
                    kind: "image",
                    name: "chart.png",
                    mimeType: "image/png",
                    size: CHART.byteLength,
                    width: 6,
                    height: 4,
                    thumbhash: expect.stringMatching(/^[A-Za-z0-9+/]+=*$/),
                },
                {
                    kind: "document",
                    name: "report.pdf",
                    mimeType: "application/pdf",
                    size: REPORT.byteLength,
                },
                { kind: "video", name: "clip.mp4", mimeType: "video/mp4", size: CLIP.byteLength },
            ],
        };
        expect(block).toMatchObject({ status: "completed", presentation });
        expect(JSON.stringify(block)).not.toContain("sha256");

        // The live update carries the same block history returns.
        const updates = (await gym.client.getEvents({ after: before })).events.filter(
            (event) => event.type === "message.updated",
        );
        const live = updates
            .flatMap(
                (event) => (event.payload as { message: { content: unknown[] } }).message.content,
            )
            .filter(
                (content): content is { id: string } =>
                    (content as { id?: string }).id === block.id,
            )
            .at(-1);
        expect(live).toEqual(block);

        // Compact loads keep the raw data so older clients still have something to render.
        const compact = await toolBlock(gym, "present_files", 1, true);
        expect(compact).toEqual(block);

        const base = `/v0/agents/${agentId}/tool-calls/${block.id}/media`;
        const chart = await media(gym, `${base}/0`);
        expect(chart.status).toBe(200);
        expect(chart.body).toEqual(CHART);
        const etag = `"${createHash("sha256").update(CHART).digest("hex")}"`;
        expect(chart.headers).toMatchObject({
            "content-type": "image/png",
            "content-length": String(CHART.byteLength),
            "cache-control": "private, max-age=31536000, immutable",
            vary: "Authorization",
            etag,
            "accept-ranges": "bytes",
            "x-content-type-options": "nosniff",
        });
        expect(chart.headers["content-disposition"]).toContain('filename="chart.png"');
        expect(chart.headers["content-security-policy"]).toMatch(/^sandbox/);
        const unchanged = await media(gym, `${base}/0`, { "if-none-match": etag });
        expect(unchanged.status).toBe(304);
        expect(unchanged.headers).toMatchObject({
            etag,
            "cache-control": "private, max-age=31536000, immutable",
        });

        // The published client reads the same bytes and ranges.
        const typed = await gym.client.getToolCallMedia(agentId, block.id, 2, {
            range: { start: 60 },
        });
        expect(typed?.contentRange).toBe(`bytes 60-63/${String(CLIP.byteLength)}`);
        expect(Buffer.from(typed!.data)).toEqual(CLIP.subarray(60));
        await expect(
            gym.client.getToolCallMedia(agentId, block.id, 0, { ifNoneMatch: etag }),
        ).resolves.toBeNull();

        const report = await media(gym, `${base}/1`);
        expect(report.headers["content-type"]).toBe("application/pdf");
        expect(report.body).toEqual(REPORT);

        // A player seeks through ranges.
        const seek = await media(gym, `${base}/2`, { range: "bytes=10-19" });
        expect(seek.status).toBe(206);
        expect(seek.headers["content-range"]).toBe(`bytes 10-19/${String(CLIP.byteLength)}`);
        expect(seek.body).toEqual(CLIP.subarray(10, 20));
        const tail = await media(gym, `${base}/2`, { range: "bytes=-4" });
        expect(tail.body).toEqual(CLIP.subarray(60));
        const outside = await media(gym, `${base}/2`, { range: "bytes=100-" });
        expect(outside.status).toBe(416);
        expect(outside.headers["content-range"]).toBe(`bytes */${String(CLIP.byteLength)}`);
        expect(JSON.parse(outside.body.toString("utf8"))).toMatchObject({
            code: "range_not_satisfiable",
        });
        expect(outside.headers["cache-control"]).toBe("no-store");

        for (const missing of [
            `${base}/3`,
            `${base}/01`,
            `/v0/agents/${agentId}/tool-calls/nosuchcall/media/0`,
            `/v0/agents/nosuchagent/tool-calls/${block.id}/media/0`,
        ]) {
            const response = await media(gym, missing);
            expect(response.status, missing).toBe(404);
            expect(response.headers["cache-control"]).toBe("no-store");
        }

        // The chat keeps what was shown, even after the source changes and the daemon restarts.
        await gym.writeFile("out/chart.png", "overwritten");
        await gym.restart();
        expect(await toolBlock(gym, "present_files", 1)).toEqual(block);
        expect((await media(gym, `${base}/0`)).body).toEqual(CHART);
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("records no media for a call that fails", async () => {
        const { gym, call } = await harness();
        const { result, block } = await call("present_files", { filepaths: ["out"] });
        expect(result.text).toContain('"out" is not a file.');
        expect(block.status).toBe("failed");
        expect(block.presentation).toBeUndefined();
        const response = await media(
            gym,
            `/v0/agents/${gym.defaultSessionId}/tool-calls/${block.id}/media/0`,
        );
        expect(response.status).toBe(404);
    });

    it("reviews a file outside the workspace before reading it", async () => {
        const { call } = await harness();
        const { result, block } = await call("present_files", {
            filepaths: ["/etc/hostname"],
        });
        expect(result.text).toContain(
            'Automatic permission review refused showing "/etc/hostname"',
        );
        expect(block.status).toBe("failed");
        expect(block.presentation).toBeUndefined();
        // The scripted gym gives the reviewer no decision, so Auto fails closed without elevation.
        expect(block).toMatchObject({ elevated: false, review: { outcome: "denied" } });
    });

    it("shows a card for each artifact version an agent makes", async () => {
        const { gym, call } = await harness();
        const created = await call("create_artifact", {
            type: "markdown",
            title: "Q3 report",
            files: [{ fromPath: "out/chart.png" }],
        });
        expect(created.result.text).toContain("as a card that opens it");
        const { artifacts } = await gym.client.listArtifacts();
        const artifactId = artifacts[0]!.id;
        expect(created.block).toMatchObject({
            status: "completed",
            presentation: {
                type: "artifact",
                artifactId,
                version: 1,
                artifactType: "markdown",
                title: "Q3 report",
            },
        });

        const updated = await call("update_artifact", {
            artifactId,
            title: "Q3 report, reviewed",
        });
        expect(updated.block).toMatchObject({
            presentation: {
                type: "artifact",
                artifactId,
                version: 2,
                artifactType: "markdown",
                title: "Q3 report, reviewed",
            },
        });
        // The first card still names the version it made.
        expect((await toolBlock(gym, "create_artifact", 1)).presentation).toMatchObject({
            version: 1,
            title: "Q3 report",
        });
        expect(gym.inference.unscripted).toEqual([]);
    });
});
