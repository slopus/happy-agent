import { stat } from "node:fs/promises";

import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

describe("persistent bots through the public API", () => {
    it(
        "creates an isolated bot, runs its agent, archives it logically, and restores it",
        { timeout: 60_000 },
        async () => {
            const gym = await createAgentGym({
                inference: [
                    { content: [{ text: "The bot answered its first request.", type: "text" }] },
                    { content: [{ text: "The restored bot answered again.", type: "text" }] },
                ],
                timeoutMs: 20_000,
            });
            running.add(gym);

            const baseline = (await gym.client.getEvents({ limit: 1 })).latestCursor;
            const created = (
                await gym.client.createBot({
                    id: "researchassistant",
                    isAdmin: true,
                    mutationId: "create-research-bot",
                    name: "Research Assistant",
                })
            ).bot;
            expect(created).toMatchObject({
                id: "researchassistant",
                isAdmin: true,
                username: "research_assistant",
                status: "active",
                agent: {
                    managedByAnotherAgent: false,
                    orderKey: null,
                    status: "idle",
                    // A bot is one conversation, so its session is named after the bot from birth
                    // and automatic naming never writes over it.
                    title: "Research Assistant",
                    titleStatus: "ready",
                    userVisible: true,
                    workspaceId: created.workspaceId,
                },
            });
            if (created.compute.type !== "host") throw new Error("Bot compute must be local.");
            expect((await stat(created.compute.path)).isDirectory()).toBe(true);

            const workspace = (await gym.client.getWorkspace(created.workspaceId)).workspace;
            expect(workspace).toMatchObject({
                id: created.workspaceId,
                botId: created.id,
                kind: "bot",
                parentId: null,
                projectId: null,
                agents: [expect.objectContaining({ id: created.agent.id })],
            });
            expect((await gym.client.listWorkspaces()).workspaces).not.toContainEqual(
                expect.objectContaining({ id: created.workspaceId }),
            );
            await expect(gym.client.getDesktopBootstrap()).resolves.toMatchObject({
                bots: [expect.objectContaining({ id: created.id })],
                workspaces: expect.not.arrayContaining([
                    expect.objectContaining({ id: created.workspaceId }),
                ]),
            });

            const fileContent = Buffer.from("bot-owned file\n").toString("base64");
            await expect(
                gym.client.writeFile(created.workspaceId, {
                    content: fileContent,
                    expectedHash: null,
                    path: "memory.txt",
                }),
            ).resolves.toMatchObject({ hash: expect.stringMatching(/^[a-f0-9]{64}$/u) });
            await expect(
                gym.client.readFile(created.workspaceId, "memory.txt"),
            ).resolves.toMatchObject({ content: fileContent });
            const terminal = (
                await gym.client.openTerminal(created.workspaceId, { command: "sleep 30" })
            ).terminal;
            expect(terminal).toMatchObject({
                status: "running",
                workspaceId: created.workspaceId,
            });

            await gym.send("Answer from the persistent bot.", { sessionId: created.agent.id });
            expect(JSON.stringify(await gym.sessionEvents(created.agent.id))).toContain(
                "The bot answered its first request.",
            );
            const botRequest = gym.inference.requests.find(
                (request) => request.sessionId === created.agent.id,
            );
            expect(botRequest?.instructions).toContain(
                [
                    "# Bot identity",
                    "",
                    'You are the persistent bot named "Research Assistant". Use this bot identity when referring to yourself. Happy Agent is the runtime that powers you, not your bot name.',
                    "- Bot ID: `researchassistant`",
                    "- Username: `research_assistant`",
                ].join("\n"),
            );
            expect(botRequest?.tools.map((tool) => tool.name)).toContain("create_bot");

            await expect(gym.client.archiveAgent(created.agent.id)).rejects.toMatchObject({
                code: "conflict",
                status: 409,
            });
            const archived = (
                await gym.client.archiveBot(created.id, {
                    ifMatch: created.version,
                    mutationId: "archive-research-bot",
                })
            ).bot;
            expect(archived).toMatchObject({
                status: "archived",
                archivedAt: expect.any(Number),
                agent: { archivedAt: expect.any(Number), canSendMessages: false },
            });
            if (archived.compute.type !== "host") throw new Error("Bot compute must be local.");
            expect((await stat(archived.compute.path)).isDirectory()).toBe(true);
            await gym.waitUntil(async () => {
                const terminalExit = (await gym.client.getEvents({ after: baseline })).events.find(
                    (event) =>
                        event.type === "terminal.updated" &&
                        event.payload.terminalId === terminal.id &&
                        event.payload.changes.status === "exited",
                );
                return terminalExit === undefined ? undefined : terminalExit;
            }, "the bot terminal to close after archival");
            await expect(
                gym.send("This must be refused while archived.", {
                    sessionId: archived.agent.id,
                }),
            ).rejects.toMatchObject({ code: "conflict", status: 409 });

            const restored = (
                await gym.client.unarchiveBot(archived.id, {
                    ifMatch: archived.version,
                    mutationId: "restore-research-bot",
                })
            ).bot;
            expect(restored).toMatchObject({
                status: "active",
                archivedAt: null,
                agent: { archivedAt: null, canSendMessages: true },
            });
            await gym.send("Answer after restoration.", { sessionId: restored.agent.id });
            expect(JSON.stringify(await gym.sessionEvents(restored.agent.id))).toContain(
                "The restored bot answered again.",
            );

            const renamed = (
                await gym.client.renameBot(
                    restored.id,
                    { name: "Research Buddy", mutationId: "rename-research-bot" },
                    { ifMatch: restored.version },
                )
            ).bot;
            expect(renamed).toMatchObject({
                name: "Research Buddy",
                // The folder never moves, so only the display name and the session title follow.
                username: "research_assistant",
                agent: { title: "Research Buddy", titleStatus: "ready" },
            });
            await expect(gym.client.getAgent(renamed.agent.id)).resolves.toMatchObject({
                agent: { title: "Research Buddy" },
            });

            const events = (await gym.client.getEvents({ after: baseline })).events;
            expect(events).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ type: "bot.created" }),
                    expect.objectContaining({ type: "workspace.created" }),
                    expect.objectContaining({ type: "agent.created" }),
                    expect.objectContaining({ type: "bot.updated" }),
                    expect.objectContaining({ type: "workspace.updated" }),
                    expect.objectContaining({
                        type: "agent.updated",
                        payload: expect.objectContaining({
                            agentId: renamed.agent.id,
                            changes: expect.objectContaining({
                                title: "Research Buddy",
                                titleStatus: "ready",
                            }),
                        }),
                    }),
                ]),
            );
            expect(gym.errors).toEqual([]);
        },
    );

    it(
        "derives distinct usernames and refuses a rename that presents a stale version",
        { timeout: 60_000 },
        async () => {
            const gym = await createAgentGym({ inference: [], timeoutMs: 20_000 });
            running.add(gym);

            // Two creations of the same display name compete for one derived username. Each reads
            // the catalog inside its own transaction, so the second must see the first and step
            // aside. This asserts the outcome; it does not by itself force the two to interleave.
            const [first, second] = await Promise.all([
                gym.client.createBot({ name: "Racing Bot" }),
                gym.client.createBot({ name: "Racing Bot" }),
            ]);
            expect(new Set([first.bot.username, second.bot.username])).toEqual(
                new Set(["racing_bot", "racing_bot_2"]),
            );
            expect(new Set([first.bot.id, second.bot.id]).size).toBe(2);
            for (const created of [first.bot, second.bot]) {
                expect(created.isAdmin).toBe(false);
                if (created.compute.type !== "host") throw new Error("Bot compute must be local.");
                expect((await stat(created.compute.path)).isDirectory()).toBe(true);
            }

            // Two renames present the same version. Exactly one may win, and the loser must be
            // told it conflicted rather than failing some other way — the version check lives
            // inside the transaction that writes, so no lock is needed to produce that answer.
            const target = first.bot;
            const outcomes = await Promise.allSettled([
                gym.client.renameBot(target.id, { name: "Winner A" }, { ifMatch: target.version }),
                gym.client.renameBot(target.id, { name: "Winner B" }, { ifMatch: target.version }),
            ]);
            const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
            const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
            expect(fulfilled).toHaveLength(1);
            expect(rejected).toHaveLength(1);
            expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
                code: "conflict",
                status: 409,
            });

            // The winner's name and its conversation title agree, and nothing landed in between.
            const settled = (await gym.client.getBot(target.id)).bot;
            expect(["Winner A", "Winner B"]).toContain(settled.name);
            expect(settled.agent.title).toBe(settled.name);
            await expect(gym.client.getAgent(target.agent.id)).resolves.toMatchObject({
                agent: { title: settled.name },
            });
            expect(gym.errors).toEqual([]);
        },
    );

    it(
        "keeps bot discovery and messaging available when project workspaces are disabled",
        { timeout: 60_000 },
        async () => {
            const gym = await createAgentGym({
                config: "[features]\nworkspaces = false\n",
                inference: [
                    {
                        content: [
                            {
                                arguments: { name: "Denied Child" },
                                callId: "denied-bot-creation",
                                name: "create_bot",
                                type: "tool_call",
                            },
                        ],
                    },
                    { content: [{ text: "The independent bot route works.", type: "text" }] },
                ],
                timeoutMs: 20_000,
            });
            running.add(gym);

            const created = (
                await gym.client.createBot({
                    id: "independentbot",
                    name: "Independent Bot",
                })
            ).bot;
            expect(created.isAdmin).toBe(false);
            await expect(gym.client.getBot(created.id)).resolves.toEqual({ bot: created });
            await expect(gym.client.listBots()).resolves.toMatchObject({
                bots: [expect.objectContaining({ id: created.id })],
            });
            await expect(gym.client.getDesktopBootstrap()).resolves.toMatchObject({
                bots: [expect.objectContaining({ id: created.id })],
            });

            await expect(gym.client.listWorkspaces()).rejects.toMatchObject({
                code: "unsupported",
                status: 503,
            });
            await expect(gym.client.getWorkspace(created.workspaceId)).rejects.toMatchObject({
                code: "unsupported",
                status: 503,
            });

            await gym.send("Confirm bot messaging remains available.", {
                sessionId: created.agent.id,
            });
            expect(JSON.stringify(await gym.sessionEvents(created.agent.id))).toContain(
                "The independent bot route works.",
            );
            const botRequest = gym.inference.requests.find(
                (request) => request.sessionId === created.agent.id,
            );
            expect(botRequest?.tools.map((tool) => tool.name)).toContain("create_bot");
            expect(botRequest?.tools.map((tool) => tool.name)).toEqual(
                expect.arrayContaining(["list_bots", "send_bot_message", "set_bot_avatar"]),
            );
            expect(
                gym.inference
                    .toolResults()
                    .find((result) => result.callId === "denied-bot-creation")?.text,
            ).toContain(
                "Only an admin bot can create other bots. There are no admin bots on this installation.",
            );
            await expect(gym.client.listBots()).resolves.toMatchObject({
                bots: [expect.objectContaining({ id: created.id })],
            });
            expect(gym.errors).toEqual([]);
        },
    );
});
