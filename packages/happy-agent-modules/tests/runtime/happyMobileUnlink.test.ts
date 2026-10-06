import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentProviders, withAgentDatabase } from "@slopus/happy-agent-base";
import { HappyAgentClient } from "@slopus/happy-agent-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    startHappyAgentRuntime,
    type HappyAgentRuntime,
} from "../../sources/runtime/startHappyAgentRuntime.js";
import { createMobileRelayFixture } from "../support/MobileRelayFixture.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Starts a standalone daemon on `happyHome` and an API client for it; `stop` shuts both down. */
async function startDaemon(happyHome: string, relayUrl: string) {
    const providers = new AgentProviders();
    providers.add("gym", new ScriptedProvider([]), "codex");
    const runtime: HappyAgentRuntime = await startHappyAgentRuntime({
        happyHome,
        environment: { HAPPY_HOME_DIR: happyHome, HAPPY_AGENT_HAPPY_SERVER_URL: relayUrl },
        inference: {
            providers,
            models: [
                {
                    id: "gym/model",
                    providerId: "gym",
                    name: "Gym",
                    defaultEffort: "medium",
                    effortLevels: ["medium"],
                },
            ],
        },
    });
    const server: Server = createServer((request, response) => {
        void runtime.api.handleRequest(
            withAgentDatabase(runtime.ctx.named("test.unlink-http"), runtime.database),
            request,
            response,
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await runtime.close();
    };
    cleanups.push(stop);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing address.");
    const client = new HappyAgentClient({
        endpoint: `http://127.0.0.1:${String(address.port)}`,
        token: (await readFile(runtime.configuration.paths.tokenPath, "utf8")).trim(),
    });
    return { client, stop };
}

/** A standalone daemon paired through the protocol relay, with one bot to publish. */
async function linkedDaemon(token: string, relayOptions?: { legacyMachineDeletion?: boolean }) {
    const root = await mkdtemp(join(tmpdir(), "happy-mobile-unlink-"));
    cleanups.push(async () => await rm(root, { force: true, recursive: true }));
    const relay = await createMobileRelayFixture(relayOptions);
    cleanups.push(async () => await relay.close());
    const happyHome = join(root, ".happy");
    let daemon = await startDaemon(happyHome, relay.url);
    const bot = (await daemon.client.createBot({ name: "Unlink bot" })).bot;
    const happyDirectory = join(happyHome, "agent", "happy");
    const link = async (account: string) => {
        const pairing = await daemon.client.startHappyIntegration();
        relay.authorize(pairing.integration.authorization!.data, account);
        await vi.waitFor(
            async () => {
                expect((await daemon.client.getHappyIntegration()).integration.status).toBe(
                    "connected",
                );
                expect(relay.botSessions(account, bot.id)).toHaveLength(1);
            },
            { timeout: 10_000 },
        );
        return relay.machines.get(account)!;
    };
    await link(token);
    return {
        bot,
        get client() {
            return daemon.client;
        },
        link,
        relay,
        /** Stops the daemon, runs `whileStopped`, then starts it again on the same state. */
        async restart(whileStopped: () => Promise<void>) {
            await daemon.stop();
            await whileStopped();
            daemon = await startDaemon(happyHome, relay.url);
        },
        credentialsPath: join(happyDirectory, "access.key"),
        machineId: async () =>
            (
                JSON.parse(await readFile(join(happyDirectory, "machine.json"), "utf8")) as {
                    id: string;
                }
            ).id,
    };
}

async function exists(path: string): Promise<boolean> {
    return await stat(path).then(
        () => true,
        () => false,
    );
}

/** The daemon has completed an unlink: nothing configured, no credentials, no machine identity. */
async function expectUnlinked(daemon: Awaited<ReturnType<typeof linkedDaemon>>) {
    await vi.waitFor(
        async () =>
            expect((await daemon.client.getHappyIntegration()).integration).toMatchObject({
                status: "disconnected",
                configured: false,
                error: null,
            }),
        { timeout: 10_000 },
    );
    expect(await exists(daemon.credentialsPath)).toBe(false);
    await expect(daemon.machineId()).rejects.toMatchObject({ code: "ENOENT" });
}

describe("unlinking Happy Mobile", () => {
    it("removes this computer with its sessions, resumes an unconfirmed removal, and relinks as a new computer", async () => {
        const daemon = await linkedDaemon("phone");
        const { relay } = daemon;
        const firstMachine = await daemon.machineId();
        expect(relay.machines.get("phone")).toBe(firstMachine);
        const published = relay.accountSessions("phone");
        expect(published).toContain(relay.botSessions("phone", daemon.bot.id)[0]);
        const terminal = relay.addForeignSession("phone", "cli-session");

        relay.faults.delete = (path) => (path.startsWith("/v1/machines/") ? 503 : undefined);
        await expect(daemon.client.disconnectHappyIntegration()).rejects.toMatchObject({
            status: 503,
            code: "happy_unavailable",
            body: {
                integration: {
                    status: "failed",
                    configured: true,
                    error: { code: "happy_unavailable" },
                },
            },
        });
        // Nothing was removed, so the computer, its credentials and its identity stay for a retry.
        expect(relay.deletions).toEqual([]);
        expect(relay.machines.get("phone")).toBe(firstMachine);
        expect(await exists(daemon.credentialsPath)).toBe(true);
        expect(await daemon.machineId()).toBe(firstMachine);
        await vi.waitFor(() => expect(relay.activeMachines()).toEqual([]));
        expect((await daemon.client.getHappyIntegration()).integration).toMatchObject({
            status: "failed",
            configured: true,
        });

        delete relay.faults.delete;
        const unlinked = await daemon.client.disconnectHappyIntegration();
        expect(unlinked.integration).toMatchObject({
            status: "disconnected",
            configured: false,
            error: null,
        });
        // One machine deletion took the sessions this computer published with it.
        expect(relay.deletions.slice(0, -1).sort()).toEqual(
            published.map((id) => `session:${id}`).sort(),
        );
        expect(relay.deletions.at(-1)).toBe(`machine:${firstMachine}`);
        expect(relay.machines.has("phone")).toBe(false);
        expect([...relay.sessions.values()].map((session) => session.id)).toEqual([terminal]);
        await expectUnlinked(daemon);
        await expect(daemon.client.disconnectHappyIntegration()).resolves.toEqual(unlinked);

        const secondMachine = await daemon.link("phone");
        expect(secondMachine).not.toBe(firstMachine);
        expect(relay.accountSessions("phone").filter((id) => published.includes(id))).toEqual([]);
    }, 30_000);

    it("unlinks when the phone deletes this computer while it is connected", async () => {
        const daemon = await linkedDaemon("phone");
        const { relay } = daemon;
        const firstMachine = await daemon.machineId();
        const terminal = relay.addForeignSession("phone", "cli-session");

        expect(await relay.deleteMachineFromPhone("phone", firstMachine)).toBe(200);

        await expectUnlinked(daemon);
        expect([...relay.sessions.values()].map((session) => session.id)).toEqual([terminal]);
        expect(relay.machines.has("phone")).toBe(false);
        const secondMachine = await daemon.link("phone");
        expect(secondMachine).not.toBe(firstMachine);
    }, 30_000);

    it("unlinks on restart when the phone deleted this computer while the daemon was off", async () => {
        const daemon = await linkedDaemon("phone");
        const { relay } = daemon;
        const firstMachine = await daemon.machineId();

        await daemon.restart(async () => {
            expect(await relay.deleteMachineFromPhone("phone", firstMachine)).toBe(200);
        });

        await expectUnlinked(daemon);
        // The daemon never brought the deleted computer or its sessions back.
        expect(relay.machines.has("phone")).toBe(false);
        expect(relay.botSessions("phone", daemon.bot.id)).toEqual([]);
        expect(await daemon.link("phone")).not.toBe(firstMachine);
    }, 30_000);

    it("brings a deleted computer back when the person pairs it again", async () => {
        const daemon = await linkedDaemon("phone");
        const { relay } = daemon;
        const firstMachine = await daemon.machineId();
        // A rejected login unlinks locally and keeps the identity for the same account.
        relay.rejected.add("phone");
        await daemon.client.disconnectHappyIntegration();
        expect(await daemon.machineId()).toBe(firstMachine);
        relay.rejected.delete("phone");
        expect(await relay.deleteMachineFromPhone("phone", firstMachine)).toBe(200);

        // Pairing is the person asking for this computer, so the deletion does not unlink it.
        expect(await daemon.link("phone")).toBe(firstMachine);
        expect((await daemon.client.getHappyIntegration()).integration.status).toBe("connected");
    }, 30_000);

    it("deletes each recorded session on an older Happy and relinks another account as a new computer", async () => {
        const daemon = await linkedDaemon("first-phone", { legacyMachineDeletion: true });
        const { relay } = daemon;
        const firstMachine = await daemon.machineId();
        const published = relay.accountSessions("first-phone");
        // A session the phone already deleted counts as removed.
        const deletedByPhone = relay.botSessions("first-phone", daemon.bot.id)[0]!;
        relay.sessions.delete(
            [...relay.sessions.entries()].find(([, session]) => session.id === deletedByPhone)![0],
        );
        const remaining = published.filter((id) => id !== deletedByPhone);

        relay.faults.delete = (path) => (path.startsWith("/v1/sessions/") ? 503 : undefined);
        await expect(daemon.client.disconnectHappyIntegration()).rejects.toMatchObject({
            status: 503,
        });
        expect(relay.deletions).toEqual([`machine:${firstMachine}`]);
        expect(await exists(daemon.credentialsPath)).toBe(true);

        delete relay.faults.delete;
        await daemon.client.disconnectHappyIntegration();
        expect(relay.accountSessions("first-phone")).toEqual([]);
        expect(relay.deletions.slice(1).sort()).toEqual(
            remaining.map((id) => `session:${id}`).sort(),
        );
        await expectUnlinked(daemon);

        const secondMachine = await daemon.link("second-phone");
        expect(secondMachine).not.toBe(firstMachine);
        expect(relay.botSessions("first-phone", daemon.bot.id)).toEqual([]);

        relay.rejected.add("second-phone");
        const unlinked = await daemon.client.disconnectHappyIntegration();
        expect(unlinked.integration).toMatchObject({ status: "disconnected", configured: false });
        expect(await exists(daemon.credentialsPath)).toBe(false);
        // Nothing could be deleted, so the account keeps this computer under the same identity.
        expect(await daemon.machineId()).toBe(secondMachine);
        expect(relay.botSessions("second-phone", daemon.bot.id)).toHaveLength(1);
    }, 30_000);
});
