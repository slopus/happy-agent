import { deflateSync } from "node:zlib";

import type {
    Artifact,
    CreateArtifactRequest,
    FeedItem,
    UpdateArtifactRequest,
} from "@slopus/happy-agent-client";
import { createAgentGym, type AgentGym, type GymTurn } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/** The cover fields, which the published client the gym uses does not type yet. */
interface Covered {
    readonly cover?: {
        readonly path: string;
        readonly mimeType: string;
        readonly width: number;
        readonly height: number;
        readonly aspect: string;
    } | null;
    readonly summary?: string | null;
}

/** A request naming a cover or summary on top of an otherwise typed request. */
function covered<Request extends CreateArtifactRequest | UpdateArtifactRequest>(
    request: Request,
    fields: { readonly cover?: string | null; readonly summary?: string | null },
): Request {
    return { ...request, ...fields } as Request;
}

/** A solid-colour PNG of the given size, encoded by hand so the test needs no image library. */
function png(width: number, height: number): Uint8Array {
    const row = Buffer.alloc(1 + width * 3, 0x40);
    row[0] = 0;
    const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.set([8, 2, 0, 0, 0], 8);
    return new Uint8Array(
        Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk("IHDR", header),
            chunk("IDAT", pixels),
            chunk("IEND", Buffer.alloc(0)),
        ]),
    );
}

function chunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.byteLength);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

async function upload(gym: AgentGym, bytes: Uint8Array): Promise<string> {
    return (await gym.client.uploadArtifactFile({ data: bytes })).upload.id;
}

describe("artifact covers and the Highlights filter over the API", () => {
    it("decodes a named cover, carries it and the summary forward, and refuses losing it", async () => {
        const gym = await createAgentGym({ timeoutMs: 20_000 });
        running.add(gym);
        const health = (await gym.http.ok("GET", "/v0/health")) as {
            capabilities: Record<string, unknown>;
        };
        expect(health.capabilities).toMatchObject({
            artifactCovers: true,
            feedSubjectFilter: true,
        });

        const summary = "Revenue up 18% QoQ, driven by enterprise seats.";
        const { artifact } = await gym.client.createArtifact(
            covered(
                {
                    type: "markdown",
                    title: "Q3 revenue",
                    files: [
                        { path: "index.md", text: "# Q3\n" },
                        { path: "cover.png", uploadId: await upload(gym, png(1600, 900)) },
                    ],
                },
                { cover: "cover.png", summary },
            ),
        );
        const cover = {
            path: "cover.png",
            mimeType: "image/png",
            width: 1600,
            height: 900,
            aspect: "wide",
        };
        expect(artifact as Artifact & Covered).toMatchObject({ cover, summary });
        expect(
            (await gym.client.getArtifactVersion(artifact.id, 1)).version as Covered,
        ).toMatchObject({ cover, summary });
        const before = (await gym.client.getEvents()).latestCursor;

        const { artifact: retitled } = await gym.client.updateArtifact(
            artifact.id,
            { title: "Q3 revenue, final" },
            { ifMatch: artifact.version },
        );
        expect(retitled as Artifact & Covered).toMatchObject({ cover, summary });

        for (const change of [
            { remove: ["cover.png"] },
            covered({}, { cover: "index.md" }),
            covered(
                {
                    files: [
                        {
                            path: "chart.svg",
                            text: '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"/>',
                        },
                    ],
                },
                { cover: "chart.svg" },
            ),
            covered(
                { files: [{ path: "cover.png", uploadId: await upload(gym, png(900, 100)) }] },
                {},
            ),
            covered({}, { summary: "two\nlines" }),
        ] as UpdateArtifactRequest[]) {
            await expect(
                gym.client.updateArtifact(artifact.id, change, { ifMatch: retitled.version }),
            ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
        }
        expect((await gym.client.getArtifact(artifact.id)).artifact.latestVersion).toBe(2);

        const { artifact: square } = await gym.client.updateArtifact(
            artifact.id,
            covered(
                { files: [{ path: "square.png", uploadId: await upload(gym, png(1200, 1200)) }] },
                { cover: "square.png", summary: null },
            ),
            { ifMatch: retitled.version },
        );
        expect(square as Artifact & Covered).toMatchObject({
            cover: { path: "square.png", width: 1200, height: 1200, aspect: "square" },
            summary: null,
        });
        const updates = (await gym.client.getEvents({ after: before })).events.filter(
            (event) => event.type === "artifact.updated",
        );
        expect(updates.map((event) => event.payload)).toMatchObject([
            { changes: { cover, summary, latestVersion: 2 } },
            {
                changes: { cover: { path: "square.png" }, summary: null, latestVersion: 3 },
            },
        ]);

        // An image is its own cover unless it cannot be one.
        const { artifact: image } = await gym.client.createArtifact({
            type: "image",
            title: "Chart",
            files: [{ path: "chart.png", uploadId: await upload(gym, png(720, 720)) }],
        });
        expect((image as Artifact & Covered).cover).toEqual({
            path: "chart.png",
            mimeType: "image/png",
            width: 720,
            height: 720,
            aspect: "square",
        });
        const { artifact: banner } = await gym.client.createArtifact({
            type: "image",
            title: "Banner",
            files: [{ path: "banner.png", uploadId: await upload(gym, png(1000, 100)) }],
        });
        expect((banner as Artifact & Covered).cover).toBeNull();
        expect(gym.errors).toEqual([]);
    });

    it("pages and closes only the subject types a filter names", async () => {
        const commands = new Map<string, { callId: string; turn: GymTurn }>();
        const gym = await createAgentGym({
            timeoutMs: 20_000,
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
        const client = gym.client;
        let calls = 0;
        const call = async (sessionId: string, name: string, args: Record<string, unknown>) => {
            const callId = `highlights_${String(++calls)}`;
            commands.set(sessionId, {
                callId,
                turn: { content: [{ type: "tool_call", name, arguments: args, callId }] },
            });
            await gym.send(`Please run ${name}, request ${callId}.`, {
                sessionId,
                permissionMode: "full_access",
            });
            await gym.waitUntil(
                async () => gym.inference.toolResults().find((item) => item.callId === callId),
                `the ${name} result`,
            );
        };
        const { task } = await client.createTask({ name: "Quarterly review" });
        const { surface } = await client.createSurface({ type: "todo", name: "Errands" });
        await call(task.agent.id, "create_artifact", {
            type: "markdown",
            title: "Findings",
            content: "# Findings\n",
        });
        await call(task.agent.id, "create_artifact", {
            type: "markdown",
            title: "Appendix",
            content: "# Appendix\n",
        });
        await call(task.agent.id, "create_todo", {
            surfaceId: surface.id,
            text: "Post the report",
            authorUserId: null,
        });
        type Page = {
            items: FeedItem[];
            unread: number;
            filteredUnread?: number;
            hasMore: boolean;
        };
        await gym.waitUntil(async () => {
            const page = await client.getFeed();
            return page.unread === 3 ? page : undefined;
        }, "three open entries");

        const highlights = (await gym.http.ok("GET", "/v0/feed?subjects=artifact,task")) as Page;
        expect(highlights.items.map((item) => item.subject.type).sort()).toEqual([
            "artifact",
            "artifact",
            "task",
        ]);
        expect(highlights).toMatchObject({ unread: 3, filteredUnread: 2, hasMore: false });
        expect(((await gym.http.ok("GET", "/v0/feed")) as Page).filteredUnread).toBeUndefined();

        const first = (await gym.http.ok("GET", "/v0/feed?subjects=artifact&limit=1")) as Page;
        expect(first.items).toHaveLength(1);
        expect(first.hasMore).toBe(true);
        const second = (await gym.http.ok(
            "GET",
            `/v0/feed?subjects=artifact&limit=1&before=${first.items[0]!.cursor}`,
        )) as Page;
        expect(second.items.map((item) => item.subject.type)).toEqual(["artifact"]);
        expect(second.hasMore).toBe(false);

        const none = (await gym.http.ok("GET", "/v0/feed?subjects=story")) as Page;
        expect(none).toMatchObject({ items: [], unread: 3, filteredUnread: 0, hasMore: false });
        expect((await gym.http.request("GET", `/v0/feed?subjects=${"x".repeat(65)}`)).status).toBe(
            400,
        );

        expect(
            await gym.http.ok("POST", "/v0/feed/read-all", { subjects: ["artifact", "task"] }),
        ).toEqual({ unread: 1 });
        const after = await client.getFeed();
        expect(
            after.items.filter((item) => item.seenAt === null).map((item) => item.subject),
        ).toEqual([{ type: "surface", id: surface.id }]);
        expect(gym.errors).toEqual([]);
    });
});
