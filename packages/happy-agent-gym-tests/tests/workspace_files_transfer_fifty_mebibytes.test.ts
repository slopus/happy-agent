import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { clientFrameEvent, createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running = new Set<AgentGym>();
const maximumBytes = 50 * 1024 * 1024;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

it("transfers exactly 50 MiB through the file API and rejects larger files without replacing bytes", async () => {
    const gym = await createAgentGym();
    running.add(gym);
    const workspaceId = (await gym.client.getAgent(gym.defaultSessionId)).agent.workspaceId!;
    const path = "attachment.bin";
    const bytes = Buffer.alloc(maximumBytes, 0xa5);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const stream = gym.stream();
    await stream.opened();
    try {
        const written = await gym.client.writeFile(workspaceId, {
            content: bytes.toString("base64"),
            expectedHash: null,
            path,
        });
        expect(written.hash).toBe(hash);
        const invalidation = await stream.waitFor((frame) => {
            const event = clientFrameEvent(frame);
            return event?.type === "files.updated" && event.payload.paths?.includes(path) === true;
        });
        expect(clientFrameEvent(invalidation)).toMatchObject({
            type: "files.updated",
            payload: { workspaceId, paths: [path] },
        });

        const read = await gym.client.readFile(workspaceId, path);
        expect(read.hash).toBe(hash);
        const received = Buffer.from(read.content, "base64");
        expect(received.length).toBe(maximumBytes);
        expect(createHash("sha256").update(received).digest("hex")).toBe(hash);

        const oversized = Buffer.alloc(maximumBytes + 1, 0x5a);
        await expect(
            gym.client.writeFile(workspaceId, {
                content: oversized.toString("base64"),
                expectedHash: hash,
                path,
            }),
        ).rejects.toMatchObject({ status: 413, code: "too_large" });
        expect(
            createHash("sha256")
                .update(await readFile(join(gym.workspacePath, path)))
                .digest("hex"),
        ).toBe(hash);

        await writeFile(join(gym.workspacePath, "oversized.bin"), oversized);
        await expect(gym.client.readFile(workspaceId, "oversized.bin")).rejects.toMatchObject({
            status: 413,
            code: "too_large",
        });
        await expect(gym.client.readFile(workspaceId, path)).resolves.toMatchObject({ hash });
        expect(gym.errors).toEqual([]);
    } finally {
        stream.close();
    }
}, 60_000);
