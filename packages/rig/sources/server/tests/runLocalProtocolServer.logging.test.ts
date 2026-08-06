import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { prepareLocalServerDirectory } from "../prepareLocalServerDirectory.js";
import { runLocalProtocolServer } from "../runLocalProtocolServer.js";
import { writeLocalServerToken } from "../writeLocalServerToken.js";

const roots = new Set<string>();

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all([...roots].map((root) => rm(root, { force: true, recursive: true })));
    roots.clear();
});

describe("runLocalProtocolServer logging", () => {
    it("records starting, ready, stopping, and stopped lifecycle boundaries", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-server-logging-"));
        const socketDirectory = await createTestSocketDirectory();
        roots.add(root);
        roots.add(socketDirectory);
        const serverDirectory = join(root, "server");
        const configDirectory = join(root, "config");
        const rigHome = join(root, "home", ".happy", "rig");
        await Promise.all([
            prepareLocalServerDirectory(serverDirectory),
            mkdir(configDirectory, { recursive: true }),
            mkdir(rigHome, { recursive: true }),
        ]);
        await writeFile(
            join(configDirectory, "happy.toml"),
            "[p2p]\nenable_iroh = false\n\n[providers]\ndefault_enable = false\n\n[providers.bedrock]\nenabled = true\n",
        );
        vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
        vi.stubEnv("RIG_CONFIGURATION_DIRECTORY", configDirectory);
        vi.stubEnv("RIG_HOME", rigHome);
        vi.stubEnv("RIG_SERVER_DIRECTORY", serverDirectory);
        const tokenPath = join(serverDirectory, "token");
        const socketPath = join(socketDirectory, "server.sock");
        const token = await writeLocalServerToken(tokenPath);
        const running = runLocalProtocolServer({
            happyIntegration: "disabled",
            socketPath,
            tokenPath,
        });
        const client = new ProtocolHttpClient({ socketPath, token });

        await waitForReady(client);
        await client.shutdown();
        await running;

        const records = (await readFile(join(serverDirectory, "server.log"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records.map((record) => record.event)).toEqual([
            "daemon_starting",
            "daemon_ready",
            "daemon_stopping",
            "daemon_stopped",
        ]);
        expect(records[0]).toMatchObject({
            databasePath: join(serverDirectory, "sessions.sqlite"),
            level: "info",
            message: "Rig daemon is starting.",
            socketPath,
        });
        expect(records[2]).toMatchObject({
            message: "Rig daemon is stopping.",
            reason: "Shutdown requested through the daemon protocol.",
        });
        for (const record of records) {
            expect(record.pid).toBe(process.pid);
            expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
            expect(record.version).toEqual(expect.any(String));
        }
    }, 60_000);
});

async function waitForReady(client: ProtocolHttpClient): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        let health;
        try {
            health = await client.health();
        } catch {
            // The Unix socket may not be accepting connections yet.
            await new Promise((resolve) => setTimeout(resolve, 20));
            continue;
        }
        if (health.status === "ready") return;
        if (health.status === "error") {
            throw new Error(health.error ?? "The test daemon failed to start.");
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Timed out waiting for the test daemon.");
}
