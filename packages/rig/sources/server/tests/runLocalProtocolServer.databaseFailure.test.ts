import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import { ProtocolHttpClient } from "../../client/ProtocolHttpClient.js";
import { PersistentSessionStore } from "../../session/PersistentSessionStore.js";
import { createTestSocketDirectory } from "../../testing/createTestSocketDirectory.js";
import { prepareLocalServerDirectory } from "../prepareLocalServerDirectory.js";
import { runLocalProtocolServer } from "../runLocalProtocolServer.js";
import { writeLocalServerToken } from "../writeLocalServerToken.js";

const roots = new Set<string>();

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all([...roots].map((root) => rm(root, { force: true, recursive: true })));
    roots.clear();
});

describe("runLocalProtocolServer database failures", () => {
    it("rejects after cleanup when opening the session database fails", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-server-database-failure-"));
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
        await writeFile(join(serverDirectory, "sessions.sqlite"), "not a SQLite database");
        vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
        vi.stubEnv("RIG_CONFIGURATION_DIRECTORY", configDirectory);
        vi.stubEnv("RIG_HOME", rigHome);
        vi.stubEnv("RIG_SERVER_DIRECTORY", serverDirectory);
        const tokenPath = join(serverDirectory, "token");
        const socketPath = join(socketDirectory, "server.sock");
        await writeLocalServerToken(tokenPath);

        await expect(
            runLocalProtocolServer({
                happyIntegration: "disabled",
                socketPath,
                tokenPath,
            }),
        ).rejects.toMatchObject({ name: "SqliteError" });

        await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
        const records = (await readFile(join(serverDirectory, "server.log"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records.map((record) => record.event)).toEqual([
            "daemon_starting",
            "daemon_startup_failed",
            "daemon_stopping",
            "daemon_stopped",
        ]);
    }, 60_000);

    it("rejects after cleanup when the shutdown drain hits a database failure", async () => {
        const { configDirectory, rigHome, serverDirectory, socketPath, tokenPath } =
            await prepareServer();
        vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "test-token");
        vi.stubEnv("RIG_CONFIGURATION_DIRECTORY", configDirectory);
        vi.stubEnv("RIG_HOME", rigHome);
        vi.stubEnv("RIG_SERVER_DIRECTORY", serverDirectory);
        const token = await writeLocalServerToken(tokenPath);
        const driverError = captureDriverError((database) => {
            database.prepare("select * from missing_table").all();
        });
        const databaseError = new AggregateError(
            [driverError],
            "The daemon could not finish shutting down.",
        );
        vi.spyOn(PersistentSessionStore.prototype, "prepareForShutdown").mockRejectedValue(
            databaseError,
        );
        const running = runLocalProtocolServer({
            happyIntegration: "disabled",
            socketPath,
            tokenPath,
        });
        const client = new ProtocolHttpClient({ socketPath, token });

        await waitForReady(client);
        const escaped = running.then(
            () => undefined,
            (error: unknown) => error,
        );
        await client.shutdown();
        await expect(escaped).resolves.toBe(databaseError);
        await expect(lstat(socketPath)).rejects.toMatchObject({ code: "ENOENT" });

        const records = (await readFile(join(serverDirectory, "server.log"), "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(records.map((record) => record.event)).toEqual([
            "daemon_starting",
            "daemon_ready",
            "daemon_stopping",
            "daemon_shutdown_drain_failed",
            "daemon_stopped",
        ]);
    }, 60_000);
});

async function prepareServer(): Promise<{
    configDirectory: string;
    rigHome: string;
    serverDirectory: string;
    socketPath: string;
    tokenPath: string;
}> {
    const root = await mkdtemp(join(tmpdir(), "rig-server-database-failure-"));
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
    return {
        configDirectory,
        rigHome,
        serverDirectory,
        socketPath: join(socketDirectory, "server.sock"),
        tokenPath: join(serverDirectory, "token"),
    };
}

function captureDriverError(act: (database: Database.Database) => void): unknown {
    const database = new Database(":memory:");
    try {
        act(database);
        throw new Error("Expected the driver to fail.");
    } catch (error) {
        return error;
    } finally {
        if (database.open) database.close();
    }
}

async function waitForReady(client: ProtocolHttpClient): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        let health;
        try {
            health = await client.health();
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
            continue;
        }
        if (health.status === "ready") return;
        if (health.status === "error") {
            throw new Error(health.error ?? "The test daemon failed to start.");
        }
    }
    throw new Error("Timed out waiting for the test daemon.");
}
