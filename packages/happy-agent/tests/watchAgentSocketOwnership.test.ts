import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    watchAgentSocketOwnership,
    type AgentSocketOwnershipLoss,
    type AgentSocketOwnershipWatch,
} from "../sources/socket/watchAgentSocketOwnership.js";

const directories: string[] = [];
const watches: AgentSocketOwnershipWatch[] = [];

afterEach(async () => {
    for (const watch of watches.splice(0)) watch.stop();
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
});

/** The watch compares only file identity and contents, so a plain file stands in for the socket. */
async function arrange() {
    const directory = await mkdtemp(join(tmpdir(), "happy-agent-ownership-"));
    directories.push(directory);
    const socketPath = join(directory, "server.sock");
    const tokenPath = join(directory, "token");
    await writeFile(socketPath, "");
    await writeFile(tokenPath, "the-token\n");
    const losses: AgentSocketOwnershipLoss[] = [];
    watches.push(
        await watchAgentSocketOwnership({
            socketPath,
            tokenPath,
            intervalMs: 10,
            onLost: (loss) => losses.push(loss),
        }),
    );
    return { losses, socketPath, tokenPath };
}

describe.skipIf(process.platform === "win32")("a daemon watching its socket and token", () => {
    it("stays quiet while both are its own", async () => {
        const { losses, tokenPath } = await arrange();
        // Rewriting the same token is not a loss.
        await writeFile(tokenPath, "the-token\n");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(losses).toEqual([]);
    });

    it("notices once when the token file is removed", async () => {
        const { losses, tokenPath } = await arrange();
        await rm(tokenPath);
        await expect.poll(() => losses).toEqual(["token-changed"]);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(losses).toEqual(["token-changed"]);
    });

    it("notices when the token file holds another token", async () => {
        const { losses, tokenPath } = await arrange();
        await writeFile(tokenPath, "someone-elses-token\n");
        await expect.poll(() => losses).toEqual(["token-changed"]);
    });

    it("notices when the socket path names another file", async () => {
        const { losses, socketPath } = await arrange();
        await rm(socketPath);
        await writeFile(socketPath, "");
        await expect.poll(() => losses).toEqual(["socket-replaced"]);
    });
});
