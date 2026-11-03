import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createAgentGym, createUnixSocketFetch, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("Surface chats are shared lazy conversations", () => {
    it("creates exactly one chat under concurrent ensures and keeps it across restart", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        const created = (await client.createSurface({ type: "todo", name: "Groceries" })).surface;
        expect(created.chatAgentId).toBeNull();

        const ensured = await Promise.all(
            [0, 1, 2, 3, 4].map(
                async (index) =>
                    await client.ensureSurfaceChat(created.id, { mutationId: `chat-${index}` }),
            ),
        );
        const { surface, agent } = ensured[0]!;
        for (const result of ensured) {
            expect(result.agent.id).toBe(agent.id);
            expect(result.surface).toEqual(surface);
        }
        expect(surface).toMatchObject({
            id: created.id,
            chatAgentId: agent.id,
            members: created.members,
            name: "Groceries",
        });
        expect(surface.version > created.version).toBe(true);
        expect(agent).toMatchObject({
            managedByAnotherAgent: false,
            canSendMessages: true,
            orderKey: null,
            title: "Groceries",
        });

        await gym.waitForEvent(
            (event) => event.type === "surface.updated" && event.payload.surfaceId === created.id,
            "chat association notification",
        );
        const again = await client.ensureSurfaceChat(created.id);
        expect(again.surface).toEqual(surface);
        expect(again.agent.id).toBe(agent.id);

        const events = (await client.getEvents({ limit: 1000 })).events;
        const updates = events.filter(
            (event) => event.type === "surface.updated" && event.payload.surfaceId === created.id,
        );
        expect(updates).toHaveLength(1);
        expect(updates[0]!.payload).toMatchObject({
            previousVersion: created.version,
            version: surface.version,
            changes: { chatAgentId: agent.id, members: created.members },
        });
        expect([0, 1, 2, 3, 4].map((index) => `chat-${index}`)).toContain(
            (updates[0]!.payload as { mutationId?: string }).mutationId,
        );
        const announcements = events.filter(
            (event) => event.type === "agent.created" && event.payload.agent.id === agent.id,
        );
        expect(announcements).toHaveLength(1);
        expect(events.indexOf(announcements[0]!)).toBeLessThan(events.indexOf(updates[0]!));
        const catalogs = events.filter(
            (event) =>
                event.type === "agent.slash_commands.updated" && event.payload.agentId === agent.id,
        );
        for (const catalog of catalogs)
            expect(events.indexOf(catalog)).toBeLessThan(events.indexOf(announcements[0]!));

        const workspace = (await client.getWorkspace(agent.workspaceId)).workspace;
        expect(workspace).toMatchObject({
            id: agent.workspaceId,
            kind: "surface",
            surfaceId: created.id,
            projectId: null,
            parentId: null,
            botId: null,
            status: "active",
            agents: [{ id: agent.id }],
        });
        expect(workspace).not.toHaveProperty("taskId");
        const folder = join(gym.publicHomePath, "Surfaces", created.id);
        expect(workspace.compute).toMatchObject({ type: "host", path: folder });
        expect((await stat(folder)).isDirectory()).toBe(true);
        await client.writeFile(agent.workspaceId, {
            path: "notes.md",
            content: Buffer.from("# Notes\n").toString("base64"),
            expectedHash: null,
        });
        expect((await client.getFileTree(agent.workspaceId)).entries).toContainEqual(
            expect.objectContaining({ path: "notes.md" }),
        );
        const listed = (await client.listWorkspaces()).workspaces.map((entry) => entry.id);
        expect(listed).not.toContain(agent.workspaceId);
        const bootstrap = await client.getDesktopBootstrap();
        expect(bootstrap.workspaces.map((entry) => entry.id)).not.toContain(agent.workspaceId);
        expect(bootstrap.surfaces).toContainEqual(surface);

        await gym.restart();
        const restarted = await gym.client.ensureSurfaceChat(created.id);
        expect(restarted.surface).toEqual(surface);
        expect(restarted.agent.id).toBe(agent.id);
        expect((await gym.client.listSurfaces()).surfaces).toContainEqual(surface);
        expect(gym.errors).toEqual([]);
    });

    it("refuses chats for unknown Surfaces and keeps the chat's lifecycle owned by its Surface", async () => {
        const gym = await createAgentGym();
        running.push(gym);
        const client = gym.client;
        await expect(client.ensureSurfaceChat("abcdefghijklmnopqrstuvwx")).rejects.toMatchObject({
            status: 404,
        });
        await expect(client.ensureSurfaceChat("todo")).rejects.toMatchObject({ status: 404 });
        const document = (await client.createSurface({ type: "document", name: "Plan" })).surface;
        const invalid = await createUnixSocketFetch(gym.socketPath)(
            new URL(`v0/surfaces/${document.id}/chat`, client.endpoint),
            {
                method: "POST",
                headers: {
                    authorization: `Bearer ${gym.token}`,
                    "content-type": "application/json",
                },
                body: JSON.stringify({ extra: true }),
            },
        );
        expect(invalid.status).toBe(400);
        await invalid.body?.cancel();
        expect((await client.listSurfaces()).surfaces).toContainEqual(document);

        const { agent } = await client.ensureSurfaceChat(document.id);
        const workspace = (await client.getWorkspace(agent.workspaceId)).workspace;
        for (const refused of [
            client.archiveAgent(agent.id),
            client.unarchiveAgent(agent.id),
            client.reorderAgent(agent.id, { afterId: null }),
            client.renameWorkspace(
                agent.workspaceId,
                { name: "renamed" },
                { ifMatch: workspace.version },
            ),
            client.archiveWorkspace(agent.workspaceId, { ifMatch: workspace.version }),
            client.reorderWorkspace(
                agent.workspaceId,
                { afterId: null },
                { ifMatch: workspace.version },
            ),
            client.createWorkspace({ parentId: agent.workspaceId, name: "child" }),
            client.createAgent({ workspaceId: agent.workspaceId }),
        ])
            await expect(refused).rejects.toMatchObject({ status: 409 });
        expect((await client.getAgent(agent.id)).agent).toMatchObject({
            id: agent.id,
            archivedAt: null,
        });
        expect(gym.errors).toEqual([]);
    });

    it("names its Surface in context and works on it with ordinary non-admin tools", async () => {
        let chatId = "";
        let surfaceId = "";
        let called = false;
        const gym = await createAgentGym({
            permissionMode: "full_access",
            inference(request) {
                if (request.sessionId.startsWith("naming:"))
                    return { content: [{ type: "text", text: "<title>Chat</title>" }] };
                if (request.sessionId !== chatId || called)
                    return { content: [{ type: "text", text: "Done." }] };
                called = true;
                return {
                    content: [
                        {
                            type: "tool_call",
                            name: "create_todo",
                            arguments: {
                                tabId: surfaceId,
                                text: "From the chat",
                                authorUserId: null,
                            },
                        },
                    ],
                };
            },
        });
        running.push(gym);
        const surface = (await gym.client.createSurface({ type: "todo", name: "Errands" })).surface;
        surfaceId = surface.id;
        const { agent } = await gym.client.ensureSurfaceChat(surface.id);
        chatId = agent.id;
        await gym.send("Add a todo from the chat.", {
            sessionId: chatId,
            permissionMode: "full_access",
        });
        const chatRequest = gym.inference.requests.find((request) => request.sessionId === chatId)!;
        expect(chatRequest.instructions).toContain("# Tab chat");
        expect(chatRequest.instructions).toContain(surface.id);
        expect(chatRequest.instructions).toContain('side chat of the todo list "Errands"');
        expect(chatRequest.instructions).toContain("Call list_todos with this Tab ID");
        const tools = gym.inference.lastTools();
        expect(tools).toEqual(expect.arrayContaining(["create_todo", "list_todos"]));
        expect(tools).not.toContain("create_todo_tab");
        expect(tools).not.toContain("add_tab_user");
        const todos = (await gym.client.listTodos(surface.id)).todos;
        expect(todos).toMatchObject([{ text: "From the chat", authorUserId: null }]);
        const revision = (await gym.client.listTodoVersions(surface.id, todos[0]!.id)).versions[0]!;
        expect(revision).toMatchObject({ actor: { agentId: chatId }, source: "tool" });
        expect((await gym.client.listSurfaces()).surfaces[0]!.members).toEqual(surface.members);
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    });

    it("shares one conversation between team members and attributes each sender", async () => {
        const { gym, alice, bob, aliceId, bobId } = await surfaceTeamClients({
            inference: () => ({ content: [{ type: "text", text: "Noted." }] }),
        });
        running.push(gym);
        const surface = (await alice.createSurface({ type: "todo", name: "Team list" })).surface;
        const { agent } = await alice.ensureSurfaceChat(surface.id);
        const bobView = (await bob.listSurfaces()).surfaces.find(
            (entry) => entry.id === surface.id,
        )!;
        expect(bobView.chatAgentId).toBe(agent.id);
        expect((await bob.ensureSurfaceChat(surface.id)).agent.id).toBe(agent.id);
        const mode = { ...gym.selection, permissionMode: "full_access" as const };
        const fromBob = await bob.sendMessage(agent.id, { text: "Bob here.", mode });
        expect(fromBob.message.metadata).toMatchObject({ userId: bobId });
        await gym.waitUntil(async () => {
            const history = await alice.getMessages(agent.id);
            return history.runs.length > 0 &&
                history.runs.every((run) => run.status === "completed")
                ? history
                : undefined;
        }, "Bob's message to settle");
        const fromAlice = await alice.sendMessage(agent.id, { text: "Alice here.", mode });
        expect(fromAlice.message.metadata).toMatchObject({ userId: aliceId });
        const members = (await alice.listSurfaces()).surfaces.find(
            (entry) => entry.id === surface.id,
        )!.members;
        expect(members).toEqual(surface.members);
        expect(gym.errors).toEqual([]);
    });
});
