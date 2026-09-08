import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { getHappyDaemonPaths } from "./getHappyDaemonPaths.js";
import { observeLocalProtocolServer } from "./ensureLocalProtocolServer.js";

const roots = new Set<string>();
const servers = new Set<Server>();

afterEach(async () => {
    await Promise.all(
        [...servers].map(async (server) => {
            server.closeAllConnections();
            await new Promise<void>((done) => server.close(() => done()));
        }),
    );
    servers.clear();
    await Promise.all(
        [...roots].map(async (root) => await rm(root, { recursive: true, force: true })),
    );
    roots.clear();
});

describe("Happy Agent protocol compatibility", () => {
    it.each([22, 23, 24, 25])("connects to additive protocol %i", async (protocol) => {
        const paths = await serveHealth(protocol);
        await expect(observeLocalProtocolServer(paths)).resolves.toMatchObject({
            health: { version: { protocol } },
        });
    });

    it.each([17, 21])("explains the required upgrade for protocol %i", async (protocol) => {
        const paths = await serveHealth(protocol);
        await expect(observeLocalProtocolServer(paths)).rejects.toThrow(
            "supports protocol 22 and newer",
        );
    });
});

async function serveHealth(protocol: number) {
    const scratch = resolve(process.cwd(), "../../.local");
    await mkdir(scratch, { recursive: true });
    const root = await mkdtemp(resolve(scratch, "protocol-"));
    roots.add(root);
    const paths = getHappyDaemonPaths({ HAPPY_HOME_DIR: root }, root);
    await mkdir(paths.agentDirectory);
    await writeFile(paths.tokenPath, "fixture-token", { mode: 0o600 });
    const server = createServer((request, response) => {
        if (
            request.url !== "/v0/health" ||
            request.headers.authorization !== "Bearer fixture-token"
        ) {
            response.writeHead(401).end();
            return;
        }
        response.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
                healthy: true,
                ready: true,
                status: "ready",
                version: { protocol, daemon: "fixture" },
            }),
        );
    });
    servers.add(server);
    await new Promise<void>((done, reject) => {
        server.once("error", reject);
        server.listen(paths.socketPath, () => {
            server.off("error", reject);
            done();
        });
    });
    return paths;
}
