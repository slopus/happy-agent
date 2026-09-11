import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { waitForSocketRemoval } from "../sources/lifecycle/waitForSocketRemoval.js";

it("waits until the local listener has actually closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "happy-stop-"));
    const path =
        process.platform === "win32"
            ? `\\\\.\\pipe\\happy-stop-${randomUUID()}`
            : join(directory, "server.sock");
    const server = createServer((socket) => socket.end());
    server.listen(path);
    await once(server, "listening");
    try {
        expect(await waitForSocketRemoval(path, 80)).toBe(false);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        expect(await waitForSocketRemoval(path, 500)).toBe(true);
    } finally {
        server.close();
        await rm(directory, { recursive: true, force: true });
    }
});
