import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

describe("bot creation keeps client-chosen identities", () => {
    it("creates once across concurrent retries and preserves identities after restart", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        const root = (await gym.client.getAgent(gym.defaultSessionId)).agent.workspaceId;
        await gym.waitForEvent(
            (event) =>
                event.type === "workspace.updated" &&
                event.payload.workspaceId === root &&
                event.payload.changes.initialization?.status === "ready",
            "the initial workspace to finish setup",
        );
        const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        const request = { id: "chosenbot", workspaceId: "chosenworkspace", agentId: "chosenagent" };
        const [first, second] = await Promise.all([
            gym.client.createBot({ ...request, mutationId: "first" }),
            gym.client.createBot({ ...request, mutationId: "retry" }),
        ]);
        expect(first.bot).toEqual(second.bot);
        expect(first.bot).toMatchObject({
            id: request.id,
            workspaceId: request.workspaceId,
            agent: { id: request.agentId, workspaceId: request.workspaceId },
        });
        const events = (await gym.client.getEvents({ after: baseline })).events;
        for (const type of ["bot.created", "workspace.created", "agent.created"]) {
            expect(events.filter((event) => event.type === type)).toHaveLength(1);
        }
        const beforeRetry = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        await expect(gym.client.createBot({ id: request.id, name: "Ignored" })).resolves.toEqual(
            first,
        );
        expect((await gym.client.getEvents({ after: beforeRetry })).events).toEqual([]);
        await gym.restart();
        await expect(gym.client.createBot(request)).resolves.toMatchObject({
            bot: {
                id: request.id,
                workspaceId: request.workspaceId,
                agent: { id: request.agentId },
            },
        });
        const current = (await gym.client.getBot(request.id)).bot;
        await expect(
            gym.client.createBot({ ...request, agentId: "differentagent" }),
        ).rejects.toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: current.version, bot: { id: request.id } },
        });
        expect(gym.errors).toEqual([]);
    });

    it("rejects collisions across bot, project, workspace and agent identities without side effects", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        const existing = (await gym.client.createBot({ name: "Existing" })).bot;
        const root = (await gym.client.getAgent(gym.defaultSessionId)).agent.workspaceId;
        await gym.waitForEvent(
            (event) =>
                event.type === "workspace.updated" &&
                event.payload.workspaceId === root &&
                event.payload.changes.initialization?.status === "ready",
            "the initial workspace to finish setup",
        );
        const occupied = [
            existing.id,
            existing.workspaceId,
            existing.agent.id,
            root,
            gym.defaultSessionId,
        ];
        const before = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        for (const id of occupied) {
            for (const key of ["workspaceId", "agentId"] as const) {
                await expect(gym.client.createBot({ [key]: id })).rejects.toMatchObject({
                    status: 409,
                    code: "conflict",
                });
            }
        }
        await expect(
            gym.client.createBot({ id: "sameid", workspaceId: "sameid" }),
        ).rejects.toMatchObject({ status: 409, code: "conflict" });
        await expect(
            gym.client.createBot({ workspaceId: "sameid", agentId: "sameid" }),
        ).rejects.toMatchObject({ status: 409, code: "conflict" });
        await expect(gym.client.createBot({ workspaceId: "invalid/id" })).rejects.toMatchObject({
            status: 400,
            code: "invalid_request",
        });
        expect((await gym.client.getEvents({ after: before })).events).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("generates omitted identities and keeps renamed and archived retries unchanged", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        for (const request of [
            { id: "onlybot" },
            { workspaceId: "onlyworkspace" },
            { agentId: "onlyagent" },
        ]) {
            const bot = (await gym.client.createBot(request)).bot;
            expect(new Set([bot.id, bot.workspaceId, bot.agent.id]).size).toBe(3);
            if (request.id !== undefined) expect(bot.id).toBe(request.id);
            if (request.workspaceId !== undefined)
                expect(bot.workspaceId).toBe(request.workspaceId);
            if (request.agentId !== undefined) expect(bot.agent.id).toBe(request.agentId);
        }
        const bot = (await gym.client.getBot("onlybot")).bot;
        const renamed = (
            await gym.client.renameBot(
                bot.id,
                { name: "Deliberate Name" },
                { ifMatch: bot.version },
            )
        ).bot;
        const archived = (await gym.client.archiveBot(bot.id, { ifMatch: renamed.version })).bot;
        const before = (await gym.client.getEvents({ limit: 1 })).latestCursor;
        await expect(
            gym.client.createBot({
                id: bot.id,
                name: "Ignored",
                workspaceId: bot.workspaceId,
                agentId: bot.agent.id,
            }),
        ).resolves.toMatchObject({
            bot: {
                id: bot.id,
                name: "Deliberate Name",
                status: "archived",
                version: archived.version,
            },
        });
        await expect(
            gym.client.createBot({ id: bot.id, workspaceId: "wrongworkspace" }),
        ).rejects.toMatchObject({
            status: 409,
            code: "conflict",
            body: { currentVersion: archived.version, bot: { status: "archived" } },
        });
        for (const id of [bot.id, bot.workspaceId, bot.agent.id]) {
            await expect(gym.client.createBot({ workspaceId: id })).rejects.toMatchObject({
                status: 409,
                code: "conflict",
            });
        }
        expect((await gym.client.getEvents({ after: before })).events).toEqual([]);
        expect(gym.errors).toEqual([]);
    });

    it("rolls back every reserved identity when folder setup fails", async () => {
        const gym = await createAgentGym();
        running.add(gym);
        const existing = (await gym.client.createBot({ name: "Existing" })).bot;
        if (existing.compute.type !== "host") throw new Error("The bot must have a local folder.");
        const blockingPath = join(dirname(existing.compute.path), "blocked_bot");
        await writeFile(blockingPath, "Keep this file.");
        const request = {
            id: "rolledbackbot",
            workspaceId: "rolledbackworkspace",
            agentId: "rolledbackagent",
            username: "blocked_bot",
        };
        await expect(gym.client.createBot(request)).rejects.toMatchObject({
            status: 409,
            code: "conflict",
        });
        await expect(gym.client.getBot(request.id)).rejects.toMatchObject({ status: 404 });
        await expect(gym.client.getWorkspace(request.workspaceId)).rejects.toMatchObject({
            status: 404,
        });
        await expect(gym.client.getAgent(request.agentId)).rejects.toMatchObject({ status: 404 });
        expect(await readFile(blockingPath, "utf8")).toBe("Keep this file.");
        await expect(
            gym.client.createBot({ ...request, username: "available_bot" }),
        ).resolves.toMatchObject({
            bot: {
                id: request.id,
                workspaceId: request.workspaceId,
                agent: { id: request.agentId },
            },
        });
        expect(gym.errors).toEqual([]);
    });
});
