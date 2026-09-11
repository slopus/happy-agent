import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { clientFrameEvent, createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import nacl from "tweetnacl";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

const gyms = new Set<AgentGym>();
const execFile = promisify(execFileCallback);
const servers = new Set<Server>();
const webSocketServers = new Set<WebSocketServer>();

afterEach(async () => {
    await Promise.all([...gyms].map(async (gym) => await gym.dispose()));
    gyms.clear();
    await Promise.all(
        [...webSocketServers].map(
            async (server) =>
                await new Promise<void>((resolve) => {
                    for (const socket of server.clients) socket.terminate();
                    server.close(() => resolve());
                }),
        ),
    );
    webSocketServers.clear();
    await Promise.all(
        [...servers].map(
            async (server) =>
                await new Promise<void>((resolve) => {
                    server.closeAllConnections();
                    server.close(() => resolve());
                }),
        ),
    );
    servers.clear();
});

describe("Happy integration API", () => {
    it("distinguishes unborn and clean native comparisons without widening a subfolder project", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            files: { "outside.txt": "outside", "selected/inside.txt": "inside" },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        const git = async (...args: string[]) =>
            (
                await execFile("git", args, { cwd: gym.workspacePath, timeout: 10_000 })
            ).stdout.trim();
        await git("init", "--initial-branch=main");
        await git("config", "user.name", "Gym");
        await git("config", "user.email", "gym@example.test");
        await gym.client.startHappyIntegration();
        await waitForIntegration(gym, "connected");
        const session = await gym.waitUntil(
            () => happy.sessions.find((item) => item.metadata.path === gym.workspacePath),
            "the unborn repository session",
        );
        await gym.waitUntil(
            () => happy.hasRpc(`${session.id}:gitState`) || undefined,
            "native Git registration",
        );
        expect(await happy.rpc(session.id, "gitState", {})).toMatchObject({
            success: true,
            git: { comparison: "unavailable", base: null, countsExact: false },
        });
        await git("add", ".");
        await git("commit", "-m", "base");
        const base = await git("rev-parse", "HEAD");
        await git("update-ref", "refs/remotes/origin/main", base);
        const clean = await gym.waitUntil(async () => {
            const result = (await happy.rpc(session.id, "gitState", {})) as {
                git?: { comparison: string };
            };
            return result.git?.comparison === "ready" ? result : undefined;
        }, "a ready clean comparison");
        expect(clean).toMatchObject({
            success: true,
            git: { base, changedFiles: 0, countsExact: true, files: [] },
        });
        const selected = join(gym.workspacePath, "selected");
        await gym.createSession({ cwd: selected });
        const nested = await gym.waitUntil(
            () => happy.sessions.find((item) => item.metadata.path === selected),
            "the subfolder session",
        );
        await gym.waitUntil(
            () => happy.hasRpc(`${nested.id}:gitState`) || undefined,
            "subfolder Git registration",
        );
        expect(await happy.rpc(nested.id, "gitState", {})).toMatchObject({
            success: false,
            code: "unsupported",
        });
        expect(await happy.rpc(nested.id, "readFile", { path: "inside.txt" })).toMatchObject({
            success: true,
            content: Buffer.from("inside").toString("base64"),
        });
        expect(
            await happy.rpc(nested.id, "readFileAtRevision", {
                path: "inside.txt",
                revision: base,
            }),
        ).toMatchObject({ success: true, content: Buffer.from("inside").toString("base64") });
        expect(
            await happy.rpc(nested.id, "readFileAtRevision", {
                path: "../outside.txt",
                revision: base,
            }),
        ).toMatchObject({ success: false, code: "invalid" });
    }, 60_000);

    it("reads each native bot's own workspace and refuses reads while it is being archived", async () => {
        const archiveRequested = new Set<string>();
        let releaseArchive!: () => void;
        const archiveReleased = new Promise<void>((resolve) => {
            releaseArchive = resolve;
        });
        const happy = await startProtocolHappyServer({
            authorizePairing: true,
            beforeArchive: async (id) => {
                archiveRequested.add(id);
                await archiveReleased;
            },
        });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        try {
            const first = (await gym.client.createBot({ name: "First Viewer" })).bot;
            const second = (await gym.client.createBot({ name: "Second Viewer" })).bot;
            if (first.compute.type !== "host" || second.compute.type !== "host")
                throw new Error("Bot workspaces must be local.");
            await writeFile(join(first.compute.path, "same.txt"), "first");
            await writeFile(join(second.compute.path, "same.txt"), "second");
            await gym.client.startHappyIntegration();
            await waitForIntegration(gym, "connected");
            const session = await gym.waitUntil(
                () => happy.sessions.find((item) => item.metadata.bot?.id === first.id),
                "the first bot session",
            );
            await gym.waitUntil(
                () => happy.hasRpc(`${session.id}:readFile`) || undefined,
                "bot read registration",
            );
            expect(
                await happy.rpc(session.id, "readFile", {
                    path: "same.txt",
                    cwd: second.compute.path,
                    workspaceId: second.workspaceId,
                }),
            ).toMatchObject({ success: true, content: Buffer.from("first").toString("base64") });
            expect(
                await happy.rpc(session.id, "readFile", {
                    path: join(second.compute.path, "same.txt"),
                }),
            ).toMatchObject({ success: false, code: "forbidden" });
            await gym.client.archiveBot(first.id, { ifMatch: first.version });
            await gym.waitUntil(
                () => archiveRequested.has(session.id) || undefined,
                "the held bot archive request",
            );
            expect(await happy.rpc(session.id, "readFile", { path: "same.txt" })).toMatchObject({
                success: false,
                code: "missing",
            });
        } finally {
            releaseArchive();
        }
    }, 60_000);

    it("reads a native child workspace without falling back to its parent folder", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            files: { "same.txt": "parent" },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        const root = (await gym.client.listProjects()).projects.find(
            (project) =>
                project.compute.type === "host" && project.compute.path === gym.workspacePath,
        )!;
        await gym.waitForEvent(
            (event) =>
                event.type === "workspace.updated" &&
                event.payload.workspaceId === root.id &&
                event.payload.changes.initialization?.status === "ready",
            "the root workspace initialization",
        );
        const created = await gym.client.createWorkspace({
            agentId: gym.defaultSessionId,
            name: "Native child",
            parentId: root.id,
        });
        await gym.waitForEvent(
            (event) =>
                event.type === "workspace.updated" &&
                event.payload.workspaceId === created.workspace.id &&
                event.payload.changes.initialization?.status === "ready",
            "the child workspace initialization",
        );
        const child = (await gym.client.getWorkspace(created.workspace.id)).workspace;
        if (child.compute.type !== "host") throw new Error("The child workspace must be local.");
        const childPath = child.compute.path;
        await writeFile(join(childPath, "same.txt"), "child");
        await gym.client.createAgent({ id: "nativechildviewer", workspaceId: child.id });
        await gym.client.startHappyIntegration();
        await waitForIntegration(gym, "connected");
        const session = await gym.waitUntil(
            () => happy.sessions.find((item) => item.metadata.path === childPath),
            "the child session",
        );
        await gym.waitUntil(
            () => happy.hasRpc(`${session.id}:readFile`) || undefined,
            "child read registration",
        );
        expect(await happy.rpc(session.id, "readFile", { path: "same.txt" })).toMatchObject({
            success: true,
            content: Buffer.from("child").toString("base64"),
        });
        expect(
            await happy.rpc(session.id, "readFile", { path: join(gym.workspacePath, "same.txt") }),
        ).toMatchObject({ success: false, code: "forbidden" });
    }, 60_000);

    it("compares native changes with origin/main's merge base and reads pinned before bytes", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            files: {
                "old.txt": "rename me\n",
                "modified.txt": "before\n",
                "deleted.txt": "delete me\n",
                "large.bin": Buffer.alloc(512 * 1024 + 1),
            },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        const git = async (...args: string[]) =>
            (
                await execFile("git", args, { cwd: gym.workspacePath, timeout: 10_000 })
            ).stdout.trim();
        await git("init", "--initial-branch=main");
        await git("config", "user.name", "Gym");
        await git("config", "user.email", "gym@example.test");
        await git("add", ".");
        await git("commit", "-m", "base");
        const base = await git("rev-parse", "HEAD");
        await git("update-ref", "refs/remotes/origin/main", base);
        await git("checkout", "-b", "topic");
        await git("mv", "old.txt", "new.txt");
        await git("commit", "-m", "committed rename");
        await git("branch", "-f", "main", "HEAD");
        await gym.writeFile("modified.txt", "after\n");
        await unlink(join(gym.workspacePath, "deleted.txt"));
        await gym.writeFile("untracked.txt", "untracked\n");
        await gym.client.startHappyIntegration();
        await waitForIntegration(gym, "connected");
        const session = await gym.waitUntil(
            () => happy.sessions.find((item) => item.metadata.path === gym.workspacePath),
            "the repository session",
        );
        await gym.waitUntil(
            () => happy.hasRpc(`${session.id}:gitState`) || undefined,
            "native Git RPC registration",
        );
        const state = await happy.rpc(session.id, "gitState", {});
        expect(state).toMatchObject({
            success: true,
            git: {
                base,
                comparison: "ready",
                changedFiles: 4,
                countsExact: true,
                filesTruncated: false,
                files: expect.arrayContaining([
                    expect.objectContaining({
                        path: "new.txt",
                        previousPath: "old.txt",
                        status: "renamed",
                    }),
                    expect.objectContaining({
                        path: "modified.txt",
                        status: "modified",
                        unstaged: true,
                    }),
                    expect.objectContaining({ path: "deleted.txt", status: "deleted" }),
                    expect.objectContaining({ path: "untracked.txt", status: "untracked" }),
                ]),
            },
        });
        expect(
            await happy.rpc(session.id, "readFileAtRevision", { path: "old.txt", revision: base }),
        ).toEqual({ success: true, content: Buffer.from("rename me\n").toString("base64") });
        expect(await happy.rpc(session.id, "readFile", { path: "new.txt" })).toMatchObject({
            success: true,
            content: Buffer.from("rename me\n").toString("base64"),
        });
        expect(
            await happy.rpc(session.id, "readFileAtRevision", {
                path: "untracked.txt",
                revision: base,
            }),
        ).toMatchObject({ success: false, code: "missing" });
        expect(
            await happy.rpc(session.id, "readFileAtRevision", {
                path: "large.bin",
                revision: base,
            }),
        ).toMatchObject({ success: false, code: "too_large" });
        expect(
            await happy.rpc(session.id, "readFileAtRevision", {
                path: "old.txt",
                revision: "f".repeat(40),
            }),
        ).toMatchObject({ success: false, code: "unavailable" });
        expect(
            await happy.rpc(session.id, "readFileAtRevision", {
                path: "old.txt",
                revision: "HEAD",
            }),
        ).toMatchObject({ success: false, code: "invalid" });
        await git("update-ref", "-d", "refs/remotes/origin/main");
        await gym.waitUntil(async () => {
            const result = (await happy.rpc(session.id, "gitState", {})) as {
                success: boolean;
                git?: { comparison: string };
            };
            return result.git?.comparison === "unavailable" ? result : undefined;
        }, "missing origin/main to make comparison unavailable");
    }, 60_000);

    it("bounds native reads and refuses symlink escapes and FIFOs without blocking", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            files: {
                "maximum.bin": Buffer.alloc(512 * 1024, 255),
                "oversized.bin": Buffer.alloc(512 * 1024 + 1),
                "empty.txt": "",
            },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        const outside = join(dirname(gym.workspacePath), "private.txt");
        await writeFile(outside, "outside");
        await symlink(outside, join(gym.workspacePath, "escape"));
        await execFile("mkfifo", [join(gym.workspacePath, "pipe")], { timeout: 10_000 });
        await gym.client.startHappyIntegration();
        await waitForIntegration(gym, "connected");
        const session = await gym.waitUntil(
            () => happy.sessions.find((item) => item.metadata.path === gym.workspacePath),
            "the workspace session",
        );
        await gym.waitUntil(
            () => happy.hasRpc(`${session.id}:readFile`) || undefined,
            "native file RPC registration",
        );
        expect(await happy.rpc(session.id, "gitState", {})).toMatchObject({
            success: false,
            code: "unsupported",
        });
        expect(await happy.rpc(session.id, "readFile", { path: "maximum.bin" })).toMatchObject({
            success: true,
            content: Buffer.alloc(512 * 1024, 255).toString("base64"),
        });
        expect(await happy.rpc(session.id, "readFile", { path: "oversized.bin" })).toMatchObject({
            success: false,
            code: "too_large",
        });
        for (const path of [outside, "escape"])
            expect(await happy.rpc(session.id, "readFile", { path })).toMatchObject({
                success: false,
                code: "forbidden",
            });
        expect(await happy.rpc(session.id, "readFile", { path: "pipe" })).toMatchObject({
            success: false,
            code: "invalid",
        });
        expect(
            await happy.rpc(session.id, "readFile", {
                path: join(gym.workspacePath, "empty.txt"),
                cwd: dirname(gym.workspacePath),
            }),
        ).toMatchObject({ success: true, content: "" });
        expect(await readFile(outside, "utf8")).toBe("outside");
    }, 60_000);

    it("reads native session files over encrypted RPC without shell access", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            files: { "native.txt": "Native changes\n" },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        await gym.client.startHappyIntegration();
        await waitForIntegration(gym, "connected");
        const session = await gym.waitUntil(
            () => happy.sessions.find((item) => item.metadata.path === gym.workspacePath),
            "the workspace session",
        );
        await gym.waitUntil(
            () => happy.hasRpc(`${session.id}:abort`) || undefined,
            "session RPC registration",
        );
        expect(await happy.rpc(session.id, "readFile", { path: "native.txt" })).toMatchObject({
            success: true,
            content: Buffer.from("Native changes\n").toString("base64"),
        });
        expect(session.metadata.capabilities).toMatchObject({
            files: { read: true, write: false },
            shell: false,
        });
        expect(await happy.rpc(session.id, "readFile", { path: "absent.txt" })).toMatchObject({
            success: false,
            code: "missing",
        });
        expect(await happy.rpc(session.id, "readFile", { path: "../outside.txt" })).toMatchObject({
            success: false,
            code: "invalid",
        });
    }, 60_000);

    it.each(["immediate", "in-flight"] as const)(
        "restores a bot during %s relay archival",
        async (timing) => {
            const archiveRequested = new Set<string>();
            let releaseArchive!: () => void;
            const archiveReleased = new Promise<void>((resolve) => {
                releaseArchive = resolve;
            });
            const happy = await startProtocolHappyServer({
                authorizePairing: true,
                beforeArchive: async (sessionId) => {
                    archiveRequested.add(sessionId);
                    await archiveReleased;
                },
            });
            const gym = await createAgentGym({
                environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
                inference: [{ content: [{ type: "text", text: "Restored bot reply." }] }],
                timeoutMs: 20_000,
            });
            gyms.add(gym);
            let bot = (await gym.client.createBot({ name: "Race Bot" })).bot;
            await gym.client.startHappyIntegration();
            await waitForIntegration(gym, "connected");
            const published = await gym.waitUntil(
                () => happy.sessions.find((session) => session.metadata.bot?.id === bot.id),
                "the bot session",
            );
            try {
                bot = (await gym.client.archiveBot(bot.id, { ifMatch: bot.version })).bot;
                if (timing === "in-flight") {
                    await gym.waitUntil(
                        () => (archiveRequested.has(published.id) ? true : undefined),
                        "the held relay archive request",
                    );
                }
                bot = (await gym.client.unarchiveBot(bot.id, { ifMatch: bot.version })).bot;
                expect(
                    happy.sessions.filter((session) => session.tag === published.tag),
                ).toHaveLength(1);
            } finally {
                releaseArchive();
            }
            // A later name update is an observable barrier even if the immediate archive was
            // coalesced away before reaching the relay. Checking just 'active' could pass too soon.
            bot = (
                await gym.client.renameBot(
                    bot.id,
                    { name: "Restored Race Bot" },
                    { ifMatch: bot.version },
                )
            ).bot;
            await gym.waitUntil(
                () =>
                    happy.metadata.get(published.id)?.name === bot.name &&
                    happy.metadata.get(published.id)?.lifecycleState === "active"
                        ? true
                        : undefined,
                "the restored bot projection",
            );
            expect(happy.metadata.get(published.id)).not.toHaveProperty("archivedBy");
            expect(
                new Set(
                    happy.sessions
                        .filter((session) => session.tag === published.tag)
                        .map((session) => session.id),
                ),
            ).toEqual(new Set([published.id]));
            happy.deliver(published.id, {
                role: "user",
                content: { type: "text", text: "Are you still there?" },
                meta: {
                    model: gym.selection.modelId,
                    modelProviderId: gym.selection.providerId,
                    effort: gym.selection.effort,
                },
            });
            await gym.waitUntil(
                () =>
                    JSON.stringify(happy.outgoing.get(published.id) ?? []).includes(
                        "Restored bot reply.",
                    )
                        ? true
                        : undefined,
                "a phone reply after racing archive and restore",
            );
        },
        60_000,
    );

    it("reserves startup sync slots for bots before filling the 64-session cap with project chats", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        for (let index = 0; index < 64; index += 1) await gym.createSession();
        const bot = (await gym.client.createBot({ name: "Priority Bot" })).bot;
        await gym.client.startHappyIntegration();
        await waitForIntegration(gym, "connected");
        await gym.waitUntil(
            () => (happy.sessions.length === 64 ? true : undefined),
            "the full connection budget",
        );
        expect(happy.sessions.some((session) => session.metadata.bot?.id === bot.id)).toBe(true);
        expect(new Set(happy.sessions.map((session) => session.tag)).size).toBe(64);
    }, 60_000);

    it("keeps bot identity and conversation through relay messages, rename, archive and restore", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            inference: [{ content: [{ type: "text", text: "Mobile bot answer." }] }],
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        let bot = (await gym.client.createBot({ name: "Mobile Lifecycle Bot" })).bot;
        await gym.client.startHappyIntegration();
        await waitForIntegration(gym, "connected");
        const published = await gym.waitUntil(
            () => happy.sessions.find((session) => session.metadata.bot?.id === bot.id),
            "the bot session",
        );
        happy.deliver(published.id, {
            role: "user",
            content: { type: "text", text: "Answer from mobile." },
            meta: {
                model: gym.selection.modelId,
                modelProviderId: gym.selection.providerId,
                effort: gym.selection.effort,
            },
        });
        await gym.waitUntil(
            () =>
                JSON.stringify(happy.outgoing.get(published.id) ?? []).includes(
                    "Mobile bot answer.",
                )
                    ? true
                    : undefined,
            "the bot's reply to reach the phone",
        );
        expect(JSON.stringify(await gym.history(bot.agent.id))).toContain("Answer from mobile.");
        bot = (
            await gym.client.renameBot(
                bot.id,
                { name: "Renamed Mobile Bot" },
                { ifMatch: bot.version },
            )
        ).bot;
        await gym.waitUntil(
            () => (happy.metadata.get(published.id)?.name === bot.name ? true : undefined),
            "the bot name to update on mobile",
        );
        bot = (await gym.client.archiveBot(bot.id, { ifMatch: bot.version })).bot;
        await gym.waitUntil(
            () =>
                happy.metadata.get(published.id)?.lifecycleState === "archived" ? true : undefined,
            "the bot to be archived on mobile",
        );
        bot = (await gym.client.unarchiveBot(bot.id, { ifMatch: bot.version })).bot;
        await gym.waitUntil(
            () =>
                happy.metadata.get(published.id)?.lifecycleState === "active" ? true : undefined,
            "the same conversation to be restored on mobile",
        );
        expect(happy.metadata.get(published.id)).not.toHaveProperty("archivedBy");
        expect(
            new Set(
                happy.sessions
                    .filter((session) => session.metadata.bot?.id === bot.id)
                    .map((session) => session.id),
            ),
        ).toEqual(new Set([published.id]));
        expect(JSON.stringify(await gym.history(bot.agent.id))).toContain("Answer from mobile.");
    }, 60_000);

    it("syncs idle and newly created bots without projects and reuses their sessions after restart", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        const bot = (await gym.client.createBot({ name: "Mobile Assistant" })).bot;
        await gym.client.startHappyIntegration();
        await waitForIntegration(gym, "connected");
        const published = await gym.waitUntil(
            () => happy.sessions.find((session) => session.metadata.bot?.id === bot.id),
            "the idle bot to appear on mobile",
        );
        expect(published.metadata).toMatchObject({
            bot: { id: bot.id, name: bot.name, workspaceId: bot.workspaceId },
        });
        expect(published.metadata).not.toHaveProperty("project");
        expect(published.metadata).not.toHaveProperty("workspace");
        const next = (await gym.client.createBot({ name: "New Mobile Bot" })).bot;
        await gym.waitUntil(
            () => happy.sessions.find((session) => session.metadata.bot?.id === next.id),
            "the new bot to appear without sending it a message",
        );
        await gym.restart();
        await waitForIntegration(gym, "connected");
        await gym.waitUntil(
            () =>
                happy.sessions.filter((session) => session.metadata.bot?.id === bot.id).length >= 2
                    ? true
                    : undefined,
            "the same bot to reconnect",
        );
        expect(
            new Set(
                happy.sessions
                    .filter((session) => session.metadata.bot?.id === bot.id)
                    .map((session) => session.tag),
            ),
        ).toEqual(new Set([published.tag]));
    }, 60_000);

    it("returns pairing data and streams complete pairing and failure snapshots", async () => {
        let requests = 0;
        const serverUrl = await startHappyServer((_request, response) => {
            requests += 1;
            sendJson(
                response,
                requests === 1 ? { state: "requested" } : { state: "not-a-happy-state" },
            );
        });
        const gym = await createAgentGym({
            environment: {
                HAPPY_AGENT_HAPPY_SERVER_URL: serverUrl,
            },
            timeoutMs: 15_000,
        });
        gyms.add(gym);

        const initial = await gym.client.getHappyIntegration();
        expect(initial.integration).toMatchObject({
            authorization: null,
            configured: false,
            error: null,
            status: "disconnected",
        });
        await expect(gym.client.getDesktopBootstrap()).resolves.toMatchObject({
            happyIntegration: initial.integration,
        });

        const stream = gym.stream();
        try {
            await stream.opened();
            const startedAt = Date.now();
            const started = await gym.client.startHappyIntegration();
            expect(started.integration).toMatchObject({
                authorization: {
                    data: expect.stringMatching(/^happy:\/\/terminal\?[A-Za-z0-9_-]+$/u),
                    expiresAt: expect.any(Number),
                    kind: "qr",
                },
                configured: false,
                error: null,
                status: "pairing",
            });
            expect(started.integration.authorization?.expiresAt).toBeGreaterThanOrEqual(
                startedAt + 110_000,
            );
            expect(started.integration.authorization?.expiresAt).toBeLessThanOrEqual(
                Date.now() + 120_000,
            );

            const pairingFrame = await stream.waitFor((frame) => {
                const event = clientFrameEvent(frame);
                return (
                    event?.type === "happy.integration.updated" &&
                    event.payload.integration.status === "pairing"
                );
            }, "the Happy pairing event");
            const pairingEvent = clientFrameEvent(pairingFrame);
            expect(pairingEvent?.type).toBe("happy.integration.updated");
            if (pairingEvent?.type !== "happy.integration.updated") {
                throw new Error("The pairing update was not a typed Happy integration event.");
            }
            expect(pairingEvent.payload.integration).toEqual(started.integration);

            const failedFrame = await stream.waitFor((frame) => {
                const event = clientFrameEvent(frame);
                return (
                    event?.type === "happy.integration.updated" &&
                    event.payload.integration.status === "failed"
                );
            }, "the Happy authorization failure event");
            const failedEvent = clientFrameEvent(failedFrame);
            expect(failedEvent?.type).toBe("happy.integration.updated");
            if (failedEvent?.type !== "happy.integration.updated") {
                throw new Error("The failure update was not a typed Happy integration event.");
            }
            expect(failedEvent.payload.integration).toMatchObject({
                authorization: null,
                configured: false,
                error: {
                    code: "invalid_response",
                    message: expect.any(String),
                },
                status: "failed",
            });
            await expect(gym.client.getHappyIntegration()).resolves.toEqual({
                integration: failedEvent.payload.integration,
            });
        } finally {
            stream.close();
        }
    }, 30_000);

    it("keeps disconnected state when Happy cannot create an authorization request", async () => {
        const serverUrl = await startHappyServer((_request, response) => {
            sendJson(response, { error: "unavailable" }, 503);
        });
        const gym = await createAgentGym({
            environment: {
                HAPPY_AGENT_HAPPY_SERVER_URL: serverUrl,
            },
            timeoutMs: 15_000,
        });
        gyms.add(gym);
        const before = await gym.client.getHappyIntegration();
        const eventsBefore = (await gym.events()).filter(
            (event) => event.type === "happy.integration.updated",
        );

        let caught: unknown;
        try {
            await gym.client.startHappyIntegration();
        } catch (error: unknown) {
            caught = error;
        }
        expect(caught).toMatchObject({
            body: { integration: before.integration },
            code: "happy_unavailable",
            status: 503,
        });
        await expect(gym.client.getHappyIntegration()).resolves.toEqual(before);
        expect(
            (await gym.events()).filter((event) => event.type === "happy.integration.updated"),
        ).toEqual(eventsBefore);
    }, 30_000);

    it("reports a disabled integration and refuses to start it", async () => {
        const gym = await createAgentGym({
            config: "[settings]\nhappy_integration = false\n",
            timeoutMs: 15_000,
        });
        gyms.add(gym);
        const before = await gym.client.getHappyIntegration();
        expect(before.integration).toMatchObject({
            authorization: null,
            configured: false,
            error: null,
            status: "disabled",
        });

        let caught: unknown;
        try {
            await gym.client.startHappyIntegration();
        } catch (error: unknown) {
            caught = error;
        }
        expect(caught).toMatchObject({
            body: { integration: before.integration },
            code: "unsupported",
            status: 503,
        });
        await expect(gym.client.getHappyIntegration()).resolves.toEqual(before);
    }, 30_000);

    it("joins concurrent starts and exposes idempotent cancel, re-pair, and unlink controls", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: false });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 15_000,
        });
        gyms.add(gym);

        const [first, joined] = await Promise.all([
            gym.client.startHappyIntegration(),
            gym.client.startHappyIntegration(),
        ]);
        expect(joined).toEqual(first);
        expect(happy.authorizationRequests).toBe(1);

        const cancelled = await gym.client.cancelHappyIntegration();
        expect(cancelled.integration).toMatchObject({
            authorization: null,
            configured: false,
            error: null,
            status: "disconnected",
        });
        await expect(gym.client.cancelHappyIntegration()).resolves.toEqual(cancelled);

        const replacement = await gym.client.rePairHappyIntegration();
        expect(replacement.integration.status).toBe("pairing");
        if (
            first.integration.status !== "pairing" ||
            replacement.integration.status !== "pairing"
        ) {
            throw new Error("Happy did not return the two pairing authorizations.");
        }
        expect(replacement.integration.authorization.data).not.toBe(
            first.integration.authorization.data,
        );

        const unlinked = await gym.client.disconnectHappyIntegration();
        expect(unlinked.integration).toMatchObject({
            authorization: null,
            configured: false,
            error: null,
            status: "disconnected",
        });

        const externalHome = join(dirname(gym.happyHome), "credentials", "happy");
        await writeLegacyCredentials(externalHome, "changed-after-unlink", happy.url, 9);
        await expect(gym.client.disconnectHappyIntegration()).resolves.toEqual(unlinked);
        await gym.restart();
        await expect(waitForIntegration(gym, "connected")).resolves.toMatchObject({
            configured: true,
        });
    }, 30_000);

    it("authorizes, connects an existing agent, and preserves ordered state across restart", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: true });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 20_000,
        });
        gyms.add(gym);

        const started = await gym.client.startHappyIntegration();
        expect(started.integration.status).toBe("pairing");
        const connected = await waitForIntegration(gym, "connected");
        expect(connected.configured).toBe(true);
        expect(happy.machineRegistrations).toBe(1);
        await gym.waitUntil(
            () => (happy.sessionCreations > 0 ? happy.sessionCreations : undefined),
            "the existing agent to be attached to Happy",
        );

        const publicSnapshot = JSON.stringify(connected);
        expect(publicSnapshot).not.toContain("happy-authorized-token");
        expect(publicSnapshot).not.toContain(Buffer.alloc(32, 7).toString("base64"));
        const settingsPath = join(gym.happyHome, "agent", "happy", "settings.json");
        await expect(readFile(settingsPath, "utf8")).resolves.toContain(happy.url);

        await gym.restart();
        const restarted = await waitForIntegration(gym, "connected");
        expect(restarted.version > connected.version).toBe(true);
        expect(happy.machineRegistrations).toBeGreaterThanOrEqual(2);
        expect(happy.authorizationRequests).toBe(2);
    }, 45_000);

    it("suppresses rejected imported credentials across restart and accepts a changed login", async () => {
        const happy = await startProtocolHappyServer({
            authorizePairing: false,
            registrationStatus: (token) => (token === "rejected-token" ? 401 : 200),
        });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        const externalHome = join(dirname(gym.happyHome), "credentials", "happy");
        await writeLegacyCredentials(externalHome, "rejected-token", happy.url, 3);

        await gym.restart();
        const rejected = await waitForIntegration(gym, "failed");
        expect(rejected).toMatchObject({
            configured: false,
            error: { code: "credentials_rejected" },
        });
        const daemonCredentialPath = join(gym.happyHome, "agent", "happy", "access.key");
        await expect(stat(daemonCredentialPath)).rejects.toMatchObject({ code: "ENOENT" });
        const registrationsAfterRejection = happy.machineRegistrations;

        await gym.restart();
        const suppressed = await gym.client.getHappyIntegration();
        expect(suppressed.integration).toMatchObject({
            configured: false,
            status: "disconnected",
        });
        expect(happy.machineRegistrations).toBe(registrationsAfterRejection);
        const pairing = await gym.client.startHappyIntegration();
        expect(pairing.integration.status).toBe("pairing");
        await gym.client.cancelHappyIntegration();

        await writeLegacyCredentials(externalHome, "replacement-token", happy.url, 4);
        await gym.restart();
        const restored = await waitForIntegration(gym, "connected");
        expect(restored.configured).toBe(true);
        expect(happy.machineRegistrations).toBeGreaterThan(registrationsAfterRejection);
    }, 60_000);

    it("revalidates a failed socket handshake and invalidates credentials rejected by HTTP", async () => {
        const happy = await startProtocolHappyServer({
            authorizePairing: false,
            registrationStatus: (_token, attempt) => (attempt === 1 ? 200 : 401),
            socketMode: "reject",
        });
        const gym = await createAgentGym({
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 20_000,
        });
        gyms.add(gym);
        const externalHome = join(dirname(gym.happyHome), "credentials", "happy");
        await writeLegacyCredentials(externalHome, "socket-token", happy.url, 5);

        await gym.restart();
        const failed = await waitForIntegration(gym, "failed");
        expect(failed).toMatchObject({
            configured: false,
            error: { code: "credentials_rejected" },
        });
        expect(happy.machineRegistrations).toBe(2);
        expect(happy.socketConnections).toBeGreaterThanOrEqual(1);
    }, 45_000);

    it("does not inspect or copy external credentials while the integration is disabled", async () => {
        const happy = await startProtocolHappyServer({ authorizePairing: false });
        const gym = await createAgentGym({
            config: "[settings]\nhappy_integration = false\n",
            environment: { HAPPY_AGENT_HAPPY_SERVER_URL: happy.url },
            timeoutMs: 15_000,
        });
        gyms.add(gym);
        const externalHome = join(dirname(gym.happyHome), "credentials", "happy");
        await writeLegacyCredentials(externalHome, "private-disabled-token", happy.url, 6);

        await gym.restart();
        const state = await gym.client.getHappyIntegration();
        expect(state.integration).toMatchObject({ configured: false, status: "disabled" });
        expect(happy.machineRegistrations).toBe(0);
        await expect(
            stat(join(gym.happyHome, "agent", "happy", "access.key")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
            stat(join(gym.happyHome, "agent", "happy", "machine.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
    }, 30_000);
});

async function startHappyServer(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.add(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${String(address.port)}`;
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
}

interface ProtocolHappyServer {
    hasRpc(method: string): boolean;
    rpc(sessionId: string, method: string, params: unknown): Promise<unknown>;
    readonly metadata: ReadonlyMap<string, Record<string, unknown>>;
    readonly outgoing: ReadonlyMap<string, readonly unknown[]>;
    deliver(sessionId: string, message: unknown): void;
    readonly sessions: readonly {
        id: string;
        tag: string;
        metadata: { bot?: { id: string }; [key: string]: unknown };
    }[];
    readonly url: string;
    readonly authorizationRequests: number;
    readonly machineRegistrations: number;
    readonly sessionCreations: number;
    readonly socketConnections: number;
}

async function startProtocolHappyServer(options: {
    authorizePairing: boolean;
    beforeArchive?: (sessionId: string) => Promise<void>;
    registrationStatus?: (token: string, attempt: number) => number;
    socketMode?: "connect" | "reject";
}): Promise<ProtocolHappyServer> {
    let authorizationRequests = 0;
    let machineRegistrations = 0;
    let sessionCreations = 0;
    let socketConnections = 0;
    const rpcSockets = new Map<string, WebSocket>();
    const rpcAnswers = new Map<string, (value: string) => void>();
    let nextRpc = 0;
    const sessions: {
        id: string;
        tag: string;
        metadata: { bot?: { id: string }; [key: string]: unknown };
    }[] = [];
    const sessionIds = new Map<string, string>();
    const metadata = new Map<string, Record<string, unknown>>();
    const outgoing = new Map<string, unknown[]>();
    const incoming = new Map<
        string,
        {
            seq: number;
            id: string;
            createdAt: number;
            updatedAt: number;
            localId: null;
            content: { t: string; c: string };
        }[]
    >();
    const secret = new Uint8Array(32).fill(7);
    const encode = (value: unknown): string => {
        const nonce = nacl.randomBytes(24);
        return Buffer.concat([
            Buffer.from(nonce),
            Buffer.from(nacl.secretbox(Buffer.from(JSON.stringify(value)), nonce, secret)),
        ]).toString("base64");
    };
    const decode = (value: string): Record<string, unknown> | undefined => {
        const bytes = Buffer.from(value, "base64");
        const plaintext = nacl.secretbox.open(bytes.subarray(24), bytes.subarray(0, 24), secret);
        // Credential-adoption scenarios deliberately use another account key. Those payloads
        // stay opaque to this fixture, just as they do to the real relay.
        if (!plaintext) return undefined;
        return JSON.parse(Buffer.from(plaintext).toString("utf8"));
    };
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://happy.test");
        void readRequestBody(request).then(
            (body) => {
                if (request.method === "POST" && url.pathname === "/v1/auth/request") {
                    authorizationRequests += 1;
                    const parsed = JSON.parse(body) as { publicKey: string };
                    if (!options.authorizePairing || authorizationRequests === 1) {
                        sendJson(response, { state: "requested" });
                        return;
                    }
                    sendJson(response, {
                        response: sealHappyAuthorization(secret, parsed.publicKey),
                        state: "authorized",
                        token: "happy-authorized-token",
                    });
                    return;
                }
                if (request.method === "POST" && url.pathname === "/v1/machines") {
                    machineRegistrations += 1;
                    const token = bearerToken(request.headers.authorization);
                    const status = options.registrationStatus?.(token, machineRegistrations) ?? 200;
                    if (status !== 200) {
                        sendJson(response, { error: "registration rejected" }, status);
                        return;
                    }
                    sendJson(response, {
                        machine: { daemonStateVersion: 1, metadataVersion: 1 },
                    });
                    return;
                }
                if (request.method === "POST" && url.pathname === "/v1/sessions") {
                    sessionCreations += 1;
                    const parsed = JSON.parse(body) as { metadata?: string; tag: string };
                    const id = sessionIds.get(parsed.tag) ?? `happy-session-${sessionIds.size + 1}`;
                    sessionIds.set(parsed.tag, id);
                    if (parsed.metadata !== undefined) {
                        const decoded = decode(parsed.metadata);
                        if (decoded !== undefined) {
                            sessions.push({ id, tag: parsed.tag, metadata: decoded });
                            if (!metadata.has(id)) metadata.set(id, decoded);
                        }
                    }
                    sendJson(response, {
                        session: {
                            agentState: null,
                            agentStateVersion: 0,
                            id,
                            metadata: metadata.has(id) ? encode(metadata.get(id)) : parsed.metadata,
                            metadataVersion: 0,
                        },
                    });
                    return;
                }
                const messagesMatch = /^\/v3\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
                if (request.method === "GET" && messagesMatch) {
                    sendJson(response, {
                        hasMore: false,
                        messages: (incoming.get(messagesMatch[1]!) ?? []).filter(
                            (message) =>
                                message.seq > Number(url.searchParams.get("after_seq") ?? 0),
                        ),
                    });
                    return;
                }
                if (request.method === "POST" && messagesMatch) {
                    const parsed = JSON.parse(body) as { messages: { content: string }[] };
                    outgoing.set(messagesMatch[1]!, [
                        ...(outgoing.get(messagesMatch[1]!) ?? []),
                        ...parsed.messages.map((message) => decode(message.content)),
                    ]);
                    sendJson(response, { success: true });
                    return;
                }
                if (
                    request.method === "POST" &&
                    /^\/v1\/sessions\/[^/]+\/archive$/.test(url.pathname)
                ) {
                    const finish = () => sendJson(response, { success: true });
                    if (options.beforeArchive) {
                        void options
                            .beforeArchive(url.pathname.split("/")[3]!)
                            .then(finish, () =>
                                sendJson(response, { error: "archive failed" }, 500),
                            );
                    } else {
                        finish();
                    }
                    return;
                }
                sendJson(response, { error: "not found" }, 404);
            },
            () => sendJson(response, { error: "invalid request" }, 400),
        );
    });
    servers.add(server);
    const webSockets = new WebSocketServer({ noServer: true });
    webSocketServers.add(webSockets);
    server.on("upgrade", (request, socket, head) => {
        const url = new URL(request.url ?? "/", "http://happy.test");
        if (url.pathname !== "/v1/updates/") {
            socket.destroy();
            return;
        }
        webSockets.handleUpgrade(request, socket, head, (webSocket) => {
            webSockets.emit("connection", webSocket, request);
        });
    });
    webSockets.on("connection", (socket: WebSocket) => {
        socketConnections += 1;
        socket.send(
            `0${JSON.stringify({
                maxPayload: 1_000_000,
                pingInterval: 25_000,
                pingTimeout: 20_000,
                sid: `engine-${String(socketConnections)}`,
                upgrades: [],
            })}`,
        );
        socket.on("message", (value) => {
            const packet = value.toString();
            const answerMatch = /^43(\d+)(\[.*)$/s.exec(packet);
            if (answerMatch) {
                rpcAnswers.get(answerMatch[1]!)?.(JSON.parse(answerMatch[2]!)[0]);
                return;
            }
            const eventMatch = /^42(\d*)(\[.*)$/s.exec(packet);
            if (eventMatch) {
                const [event, payload] = JSON.parse(eventMatch[2]!) as [
                    string,
                    { sid?: string; metadata?: string; expectedVersion?: number; method?: string },
                ];
                if (event === "rpc-register" && payload.method)
                    rpcSockets.set(payload.method, socket);
                if (event === "update-metadata" && payload.sid && payload.metadata) {
                    const decoded = decode(payload.metadata);
                    if (decoded !== undefined) metadata.set(payload.sid, decoded);
                }
                if (eventMatch[1])
                    socket.send(
                        `43${eventMatch[1]}${JSON.stringify([{ result: "success", version: (payload.expectedVersion ?? 0) + 1 }])}`,
                    );
                return;
            }
            if (!packet.startsWith("40")) return;
            if (options.socketMode === "reject") {
                socket.send(`44${JSON.stringify({ message: "Unauthorized" })}`);
                return;
            }
            socket.send(`40${JSON.stringify({ sid: `socket-${String(socketConnections)}` })}`);
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    return {
        hasRpc: (method) => rpcSockets.has(method),
        rpc: async (sessionId, method, params) => {
            const socket = rpcSockets.get(`${sessionId}:abort`);
            if (!socket) throw new Error("The session RPC socket is not connected.");
            const id = String(++nextRpc);
            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    rpcAnswers.delete(id);
                    reject(new Error("The session RPC timed out."));
                }, 10_000);
                rpcAnswers.set(id, (answer) => {
                    clearTimeout(timeout);
                    rpcAnswers.delete(id);
                    resolve(decode(answer));
                });
                socket.send(
                    `42${id}${JSON.stringify(["rpc-request", { method: `${sessionId}:${method}`, params: encode(params) }])}`,
                );
            });
        },
        metadata,
        outgoing,
        deliver: (sessionId, message) => {
            const messages = incoming.get(sessionId) ?? [];
            const seq = messages.length + 1;
            messages.push({
                seq,
                id: `phone-${seq}`,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                localId: null,
                content: { t: "encrypted", c: encode(message) },
            });
            incoming.set(sessionId, messages);
            for (const socket of webSockets.clients) socket.send('42["update",{}]');
        },
        sessions,
        get authorizationRequests() {
            return authorizationRequests;
        },
        get machineRegistrations() {
            return machineRegistrations;
        },
        get sessionCreations() {
            return sessionCreations;
        },
        get socketConnections() {
            return socketConnections;
        },
        url: `http://127.0.0.1:${String(address.port)}`,
    };
}

function sealHappyAuthorization(secret: Uint8Array, publicKeyBase64: string): string {
    const recipient = new Uint8Array(Buffer.from(publicKeyBase64, "base64"));
    const ephemeral = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const ciphertext = nacl.box(secret, nonce, recipient, ephemeral.secretKey);
    return Buffer.concat([
        Buffer.from(ephemeral.publicKey),
        Buffer.from(nonce),
        Buffer.from(ciphertext),
    ]).toString("base64");
}

async function readRequestBody(request: import("node:http").IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
}

function bearerToken(value: string | undefined): string {
    return value?.startsWith("Bearer ") === true ? value.slice("Bearer ".length) : "";
}

async function waitForIntegration(
    gym: AgentGym,
    status: "connected" | "failed",
): Promise<Awaited<ReturnType<AgentGym["client"]["getHappyIntegration"]>>["integration"]> {
    return await gym.waitUntil(async () => {
        const integration = (await gym.client.getHappyIntegration()).integration;
        return integration.status === status ? integration : undefined;
    }, `the Happy integration to become ${status}`);
}

async function writeLegacyCredentials(
    directory: string,
    token: string,
    serverUrl: string,
    fill: number,
): Promise<void> {
    await mkdir(directory, { recursive: true });
    await writeFile(
        join(directory, "access.key"),
        JSON.stringify({ secret: Buffer.alloc(32, fill).toString("base64"), token }),
    );
    await writeFile(join(directory, "settings.json"), JSON.stringify({ serverUrl }));
}
