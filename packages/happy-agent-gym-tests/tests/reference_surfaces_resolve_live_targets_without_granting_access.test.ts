import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("reference Surfaces resolve live targets without granting access", () => {
    it("refreshes bot metadata without changing the Surface, hides unavailable metadata, and keeps its immutable binding", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        const bot = (await client.createBot({ name: "Original bot" })).bot;
        const surface = (
            await client.createSurface({
                type: "bot",
                name: "Stored fallback",
                botId: bot.id,
                mutationId: "reference-created",
            })
        ).surface;
        expect(surface).toMatchObject({
            type: "bot",
            name: "Stored fallback",
            image: null,
            creatorUserId: null,
            members: [{ userId: null }],
            target: {
                type: "bot",
                state: "available",
                botId: bot.id,
                name: bot.name,
                hasImage: bot.avatar !== null,
                version: bot.version,
            },
        });
        const renamed = (
            await client.renameBot(bot.id, { name: "Current bot" }, { ifMatch: bot.version })
        ).bot;
        const resolved = (await client.listSurfaces()).surfaces.find(
            (entry) => entry.id === surface.id,
        )!;
        expect(resolved.version).toBe(surface.version);
        expect(resolved.name).toBe("Stored fallback");
        expect(resolved.target).toMatchObject({ name: "Current bot", version: renamed.version });
        const archived = (await client.archiveBot(bot.id, { ifMatch: renamed.version })).bot;
        const unavailable = (await client.listSurfaces()).surfaces.find(
            (entry) => entry.id === surface.id,
        )!;
        expect(unavailable.target).toEqual({ type: "bot", state: "unavailable" });
        expect(JSON.stringify(unavailable)).not.toContain(bot.id);
        expect(unavailable.version).toBe(surface.version);
        expect(
            (
                await client.createSurface({
                    id: surface.id,
                    type: "bot",
                    name: "Ignored",
                    botId: "missingbot",
                })
            ).surface,
        ).toEqual(unavailable);
        await expect(
            client.createSurface({ type: "bot", name: "Rejected", botId: bot.id }),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });
        const events = (await client.getEvents({ limit: 1000 })).events;
        expect(events.filter((event) => event.type === "surface.updated")).toEqual([]);
        const created = events.filter(
            (event) => event.type === "surface.created" && event.payload.surface.id === surface.id,
        );
        expect(created).toHaveLength(1);
        expect(created[0]!.payload).toMatchObject({ mutationId: "reference-created" });
        expect(created[0]!.payload).not.toHaveProperty("surface.target");
        expect(JSON.stringify(created[0])).not.toContain(bot.id);

        await gym.restart();
        expect((await gym.client.getDesktopBootstrap()).surfaces).toContainEqual(unavailable);
        const restored = (await gym.client.unarchiveBot(bot.id, { ifMatch: archived.version })).bot;
        const joined = (await gym.client.joinSurface(surface.id)).surface;
        expect(joined.version).toBe(surface.version);
        expect(joined.target).toEqual({
            type: "bot",
            state: "available",
            botId: bot.id,
            name: restored.name,
            hasImage: restored.avatar !== null,
            version: restored.version,
        });
        expect(gym.errors).toEqual([]);
    });

    it("resolves artifacts and tasks live, rejects unusable targets, and survives their lifecycle", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        const { upload } = await client.uploadArtifactFile({ data: new Uint8Array([1, 2, 3]) });
        const artifact = (
            await client.createArtifact({
                type: "image",
                title: "Chart",
                files: [{ path: "chart.png", uploadId: upload.id }],
            })
        ).artifact;
        const task = (await client.createTask({ name: "Launch work" })).task;
        const artifactSurface = (
            await client.createSurface({
                type: "artifact",
                name: "Pinned chart",
                artifactId: artifact.id,
            })
        ).surface;
        const taskSurface = (
            await client.createSurface({ type: "task", name: "Pinned task", taskId: task.id })
        ).surface;
        expect(artifactSurface.target).toEqual({
            type: "artifact",
            state: "available",
            artifactId: artifact.id,
            name: "Chart",
            hasImage: true,
            version: artifact.version,
        });
        expect(taskSurface.target).toEqual({
            type: "task",
            state: "available",
            taskId: task.id,
            name: "Launch work",
            hasImage: false,
            version: task.version,
        });

        const retitled = (
            await client.updateArtifact(
                artifact.id,
                { title: "Quarterly chart" },
                { ifMatch: artifact.version },
            )
        ).artifact;
        const afterRetitle = (await client.listSurfaces()).surfaces.find(
            (entry) => entry.id === artifactSurface.id,
        )!;
        expect(afterRetitle).toMatchObject({
            name: "Pinned chart",
            version: artifactSurface.version,
            target: { name: "Quarterly chart", version: retitled.version },
        });

        const before = (await client.listSurfaces()).surfaces;
        for (const invalid of [
            { type: "artifact", name: "Wrong field", botId: task.id },
            { type: "task", name: "Malformed", taskId: "Not-An-Id" },
            { type: "bot", name: "Missing field" },
        ])
            await expect(client.createSurface(invalid as never)).rejects.toMatchObject({
                status: 400,
                code: "invalid_request",
            });
        await expect(
            client.createSurface({ type: "artifact", name: "Missing", artifactId: "missingart" }),
        ).rejects.toMatchObject({ status: 404, code: "not_found" });

        await client.deleteArtifact(artifact.id, { ifMatch: retitled.version });
        const taskResponse = (await client.getTask(task.id)).task;
        const archivedTask = (await client.archiveTask(task.id, { ifMatch: taskResponse.version }))
            .task;
        const afterLifecycle = (await client.listSurfaces()).surfaces;
        const deletedView = afterLifecycle.find((entry) => entry.id === artifactSurface.id)!;
        const archivedView = afterLifecycle.find((entry) => entry.id === taskSurface.id)!;
        expect(deletedView.target).toEqual({ type: "artifact", state: "unavailable" });
        expect(archivedView.target).toEqual({ type: "task", state: "unavailable" });
        expect(JSON.stringify(afterLifecycle)).not.toContain(artifact.id);
        expect(JSON.stringify(afterLifecycle)).not.toContain(task.id);
        await expect(
            client.createSurface({ type: "artifact", name: "Deleted", artifactId: artifact.id }),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
            client.createSurface({ type: "task", name: "Archived", taskId: task.id }),
        ).rejects.toMatchObject({ status: 404 });
        expect(afterLifecycle).toHaveLength(before.length);

        await gym.restart();
        await gym.client.unarchiveTask(task.id, { ifMatch: archivedTask.version });
        const reopened = (await gym.client.listSurfaces()).surfaces;
        expect(reopened.find((entry) => entry.id === taskSurface.id)!.target).toMatchObject({
            state: "available",
            taskId: task.id,
        });
        expect(reopened.find((entry) => entry.id === artifactSurface.id)!.target).toEqual({
            type: "artifact",
            state: "unavailable",
        });
        expect(gym.errors).toEqual([]);
    });

    it("lets every team member see a reference without joining its task or widening task rights", async () => {
        const { gym, alice, bob, aliceId, bobId } = await surfaceTeamClients();
        running.push(gym);
        // Exercise explicit reference membership without either automatic participation policy.
        await bob.saveUserSetting("tasks.autoJoin", { value: false });
        await bob.saveUserSetting("surfaces.autoJoin", { value: false });
        const task = (await alice.createTask({ name: "Alice's launch" })).task;
        const surface = (
            await alice.createSurface({ type: "task", name: "Launch", taskId: task.id })
        ).surface;
        expect(surface).toMatchObject({
            creatorUserId: aliceId,
            members: [{ userId: aliceId }],
            target: { state: "available", taskId: task.id },
        });
        const bobView = (await bob.listSurfaces()).surfaces.find(
            (entry) => entry.id === surface.id,
        )!;
        expect(bobView.target).toEqual(surface.target);
        const joined = (await bob.joinSurface(surface.id)).surface;
        expect(joined.members.map((member) => member.userId).sort()).toEqual(
            [aliceId, bobId].sort(),
        );
        expect(
            (await bob.listTasks({ scope: "joined" })).tasks.map((entry) => entry.id),
        ).not.toContain(task.id);
        const bobTask = (await bob.getTask(task.id)).task;
        expect(bobTask.canArchive).toBe(false);
        await expect(bob.archiveTask(task.id, { ifMatch: bobTask.version })).rejects.toMatchObject({
            status: 403,
        });
        expect((await bob.getDesktopBootstrap()).surfaces).toContainEqual(joined);
        expect(gym.errors).toEqual([]);
    });

    it("refuses an admin reference to an archived target without creating anything", async () => {
        let adminId = "";
        let taskId = "";
        let called = false;
        const gym = await createAgentGym({
            permissionMode: "full_access",
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Reference</title>" }] };
                if (request.sessionId !== adminId || called)
                    return { content: [{ type: "text", text: "Finished." }] };
                called = true;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_task_tab",
                            arguments: { name: "Gone", creatorUserId: null, taskId },
                        },
                    ],
                };
            },
        });
        running.push(gym);
        adminId = (await gym.client.createBot({ name: "Administrator", isAdmin: true })).bot.agent
            .id;
        const task = (await gym.client.createTask({ name: "Finished work" })).task;
        await gym.client.archiveTask(task.id, { ifMatch: task.version });
        taskId = task.id;
        await gym.send("Pin the finished task.", {
            sessionId: adminId,
            permissionMode: "full_access",
        });
        expect(JSON.stringify(gym.inference.toolResults())).toContain("not found");
        expect((await gym.client.listSurfaces()).surfaces).toEqual([]);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });

    it.each([
        ["create_artifact_tab", "artifactId", "auto-allow"],
        ["create_artifact_tab", "artifactId", "auto-deny"],
        ["create_bot_tab", "botId", "auto-allow"],
        ["create_bot_tab", "botId", "auto-deny"],
        ["create_task_tab", "taskId", "auto-allow"],
        ["create_task_tab", "taskId", "auto-deny"],
    ] as const)("reviews %s (%s) as %s before a shared write", async (tool, field, mode) => {
        let adminId = "";
        let targetId = "";
        let called = false;
        const reviews: string[] = [];
        const gym = await createAgentGym({
            permissionMode: "auto",
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Reference</title>" }] };
                if (request.sessionId !== adminId) {
                    reviews.push(JSON.stringify(request.messages));
                    return {
                        content: [
                            {
                                type: "text",
                                text: `<review><outcome>${mode === "auto-allow" ? "allow" : "deny"}</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted permission decision.</rationale></review>`,
                            },
                        ],
                    };
                }
                if (called) return { content: [{ type: "text", text: "Finished." }] };
                called = true;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: tool,
                            arguments: { name: "Pinned", creatorUserId: null, [field]: targetId },
                        },
                    ],
                };
            },
        });
        running.push(gym);
        adminId = (await gym.client.createBot({ name: "Administrator", isAdmin: true })).bot.agent
            .id;
        targetId =
            field === "artifactId"
                ? (
                      await gym.client.createArtifact({
                          type: "markdown",
                          title: "Notes",
                          files: [{ path: "index.md", text: "# Notes\n" }],
                      })
                  ).artifact.id
                : field === "botId"
                  ? (await gym.client.createBot({ name: "Helper" })).bot.id
                  : (await gym.client.createTask({ name: "Launch" })).task.id;
        await gym.send("Pin it to the shared sidebar.", {
            sessionId: adminId,
            permissionMode: "auto",
        });
        const surfaces = (await gym.client.listSurfaces()).surfaces;
        expect(reviews).toHaveLength(1);
        expect(reviews[0]).toContain("Pin it to the shared sidebar.");
        expect(reviews[0]).toContain(tool);
        expect(reviews[0]).toContain(targetId);
        expect(reviews[0]).toContain("shared data write");
        if (mode === "auto-deny") expect(surfaces).toEqual([]);
        else {
            expect(surfaces).toHaveLength(1);
            expect(surfaces[0]).toMatchObject({
                name: "Pinned",
                creatorUserId: null,
                members: [{ userId: null }],
                target: { state: "available", [field]: targetId },
            });
            await gym.restart();
            expect((await gym.client.listSurfaces()).surfaces).toEqual(surfaces);
        }
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });
});
