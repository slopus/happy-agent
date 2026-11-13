import { createHash, randomBytes } from "node:crypto";

import type { MessageBlock } from "@slopus/happy-agent-client";
import { createAgentGym, createUnixSocketFetch, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const gyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
});

function sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
}

// The wire is spoken directly so every status and header is checked; the client is checked last.
describe("attached files", () => {
    it("upload whole or in parallel chunks, reach the model as notes, and are never echoed", async () => {
        const notes = "line one\nline two\n";
        const noteBytes = Buffer.from(notes);
        const noteId = sha256(noteBytes);
        const gym = await createAgentGym({
            inference(request) {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ type: "text", text: "Attached files" }] };
                }
                if (!request.messages.some((message) => message.role === "tool")) {
                    return {
                        content: [
                            {
                                type: "tool_call",
                                name: "read_attachment",
                                arguments: { attachment_id: noteId },
                            },
                        ],
                    };
                }
                return { content: [{ type: "text", text: "Read both." }] };
            },
        });
        gyms.add(gym);
        const agentId = gym.defaultSessionId;
        const fetch = createUnixSocketFetch(gym.socketPath);
        const base = `http://gym/v0/agents/${agentId}/attachments`;
        const call = async (
            method: string,
            path: string,
            body?: Uint8Array,
            headers: Record<string, string> = {},
        ): Promise<Response> =>
            await fetch(`${base}${path}`, {
                method,
                headers: { authorization: `Bearer ${gym.token}`, ...headers },
                ...(body === undefined ? {} : { body }),
            });

        expect((await gym.client.getHealth()).capabilities).toMatchObject({ attachments: true });

        // The client sends a file past its direct limit in chunks, and the same bytes again
        // answer the attachment without resending them.
        const viaClient = new Uint8Array(randomBytes(10_000));
        const clientFile = { name: "client.bin", data: viaClient };
        const chunked = { directLimit: 1_000, chunkSize: 4_096 };
        const attached = await gym.client.attachFile(agentId, clientFile, chunked);
        expect(attached).toMatchObject({ id: sha256(viaClient), size: 10_000, kind: "file" });
        expect(await gym.client.attachFile(agentId, clientFile, chunked)).toEqual(attached);

        // A small file goes whole, as on Happy Cloud.
        const whole = await call("PUT", "?name=notes.txt", noteBytes, {
            "content-type": "text/plain",
        });
        expect(whole.status).toBe(201);
        expect(await whole.json()).toEqual({
            attachment: {
                id: noteId,
                name: "notes.txt",
                mimeType: "text/plain",
                size: noteBytes.byteLength,
                kind: "file",
            },
        });

        // A larger one goes in chunks named by its digest, out of order and in parallel.
        const big = randomBytes(300_000);
        const bigId = sha256(big);
        const chunk = async (start: number, end: number) =>
            await call("PUT", `/${bigId}?name=big.bin`, big.subarray(start, end + 1), {
                "content-range": `bytes ${String(start)}-${String(end)}/${String(big.byteLength)}`,
            });
        const probe = await call("PUT", `/${bigId}?name=big.bin`, new Uint8Array(), {
            "content-range": `bytes */${String(big.byteLength)}`,
        });
        expect(probe.status).toBe(200);
        expect(await probe.json()).toMatchObject({ upload: { id: bigId, received: [] } });
        const last = await chunk(200_000, 299_999);
        expect(await last.json()).toMatchObject({
            upload: { received: [{ start: 200_000, end: 299_999 }] },
        });
        const answers = await Promise.all([chunk(0, 99_999), chunk(100_000, 199_999)]);
        expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
        // Asking again, the conversation already holds it.
        const again = await call("PUT", `/${bigId}?name=big.bin`, new Uint8Array(), {
            "content-range": `bytes */${String(big.byteLength)}`,
        });
        expect(again.status).toBe(201);

        // An upload can be cancelled; a file the conversation does not hold cannot be sent.
        const abandoned = sha256(Buffer.from("abandoned"));
        await call("PUT", `/${abandoned}?name=a.txt`, Buffer.from("aban"), {
            "content-range": "bytes 0-3/9",
        });
        expect((await call("DELETE", `/${abandoned}`)).status).toBe(200);
        const mode = {
            effort: gym.selection.effort,
            modelId: gym.selection.modelId,
            permissionMode: "auto" as const,
            providerId: gym.selection.providerId,
            serviceTier: null,
        };
        await expect(
            gym.client.sendMessage(agentId, {
                text: "Look",
                mode,
                content: [
                    {
                        type: "file",
                        attachment: abandoned,
                        name: "a.txt",
                    } as unknown as MessageBlock,
                ],
            }),
        ).rejects.toMatchObject({ status: 400, code: "attachment_not_found" });

        // Sending names both; every representation carries the blocks without bytes.
        const sent = await gym.client.sendMessage(agentId, {
            text: "Look at these.",
            mode,
            content: [
                { type: "file", attachment: noteId, name: "notes.txt" },
                { type: "file", attachment: bigId, name: "big.bin" },
            ] as unknown as MessageBlock[],
        });
        const expectedBlocks = [
            { type: "text", text: "Look at these." },
            {
                type: "file",
                attachment: noteId,
                name: "notes.txt",
                mimeType: "text/plain",
                size: noteBytes.byteLength,
                kind: "file",
            },
            {
                type: "file",
                attachment: bigId,
                name: "big.bin",
                mimeType: "application/octet-stream",
                size: big.byteLength,
                kind: "file",
            },
        ];
        expect(sent.message.content).toEqual(expectedBlocks);
        expect(JSON.stringify(sent).length).toBeLessThan(4_000);
        await gym.waitForEvent(
            (event) => event.type === "run.finished",
            "the run reading the attachment to finish",
        );
        const history = await gym.client.getMessages(agentId);
        const stored = history.runs
            .flatMap((run) => run.messages)
            .find((message) => message.id === sent.message.id);
        expect(stored?.content).toEqual(expectedBlocks);

        // The model got notes, then read the text through its tool.
        const userTexts = gym.inference.userTexts().join("\n");
        expect(userTexts).toContain(
            `[Attachment ${noteId}: "notes.txt", text/plain, 18 bytes. Open it with read_attachment.]`,
        );
        expect(userTexts).toContain(`[Attachment ${bigId}: "big.bin"`);
        expect(
            gym.inference
                .toolResults()
                .map((result) => result.text)
                .join("\n"),
        ).toContain("1\tline one\n2\tline two");

        // A sent attachment stays, and its bytes are served with ranges and caching.
        expect((await call("DELETE", `/${noteId}`)).status).toBe(409);
        const ranged = await call("GET", `/${bigId}`, undefined, { range: "bytes=10-19" });
        expect(ranged.status).toBe(206);
        expect(Buffer.from(await ranged.arrayBuffer())).toEqual(big.subarray(10, 20));
        expect(ranged.headers.get("content-disposition")).toMatch(/^attachment;/u);
        const cached = await call("GET", `/${bigId}`, undefined, {
            "if-none-match": `"${bigId}"`,
        });
        expect(cached.status).toBe(304);
        expect(gym.errors).toEqual([]);
    });
});
