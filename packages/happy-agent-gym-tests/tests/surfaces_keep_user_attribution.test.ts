import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

it("keeps standalone attribution null and requires explicit creation-tool attribution", async () => {
    let nextTool: { name: string; arguments: unknown } | undefined;
    const gym = await createAgentGym({
        permissionMode: "full_access",
        timeoutMs: 20_000,
        inference(request) {
            if (request.sessionId.startsWith("naming:"))
                return { content: [{ type: "text", text: "<title>Attribution</title>" }] };
            if (nextTool !== undefined) {
                const tool = nextTool;
                nextTool = undefined;
                return { content: [{ type: "tool_call", ...tool }] };
            }
            return { content: [{ type: "text", text: "Finished." }] };
        },
    });
    running.push(gym);
    const surface = (await gym.client.createSurface({ type: "todo", name: "Personal" })).surface;
    expect(surface.creatorUserId).toBeNull();
    const original = (await gym.client.createTodo(surface.id, { text: "From HTTP" })).todo;
    expect(original.authorUserId).toBeNull();

    for (const attribution of [{}, { authorUserId: "unknownuser" }]) {
        nextTool = {
            name: "create_todo",
            arguments: { tabId: surface.id, text: "Rejected", ...attribution },
        };
        await gym.send("Try the todo creation arguments.", { permissionMode: "full_access" });
        expect((await gym.client.listTodos(surface.id)).todos).toEqual([original]);
    }
    nextTool = {
        name: "create_todo",
        arguments: { tabId: surface.id, text: "From a tool", authorUserId: null },
    };
    await gym.send("Create a todo with no attributed user.", { permissionMode: "full_access" });
    const todos = (await gym.client.listTodos(surface.id)).todos;
    expect(todos).toHaveLength(2);
    const authored = todos.find((todo) => todo.id !== original.id)!;
    expect(authored.authorUserId).toBeNull();
    expect((await gym.client.listTodoVersions(surface.id, authored.id)).versions).toMatchObject([
        { todo: { authorUserId: null }, actor: { userId: null, agentId: gym.defaultSessionId } },
    ]);

    const admin = (await gym.client.createBot({ name: "Administrator", isAdmin: true })).bot;
    for (const attribution of [{}, { creatorUserId: "unknownuser" }]) {
        nextTool = {
            name: "create_todo_tab",
            arguments: { name: "Rejected", ...attribution },
        };
        await gym.send("Try the Surface creation arguments.", {
            sessionId: admin.agent.id,
            permissionMode: "full_access",
        });
        expect((await gym.client.listSurfaces()).surfaces).toEqual([surface]);
    }
    nextTool = {
        name: "create_todo_tab",
        arguments: { name: "Tool list", creatorUserId: null },
    };
    await gym.send("Create a Surface with no attributed user.", {
        sessionId: admin.agent.id,
        permissionMode: "full_access",
    });
    const toolSurface = (await gym.client.listSurfaces()).surfaces.find(
        (s) => s.name === "Tool list",
    )!;
    expect(toolSurface).toMatchObject({ creatorUserId: null, members: [{ userId: null }] });

    const edited = (
        await gym.client.updateTodo(
            surface.id,
            authored.id,
            { status: "completed" },
            {
                ifMatch: authored.version,
            },
        )
    ).todo;
    expect(edited.authorUserId).toBeNull();
    await gym.waitUntil(async () => {
        const events = (await gym.client.getEvents({ limit: 1000 })).events;
        return events.some(
            (event) =>
                event.type === "surface.created" && event.payload.surface.id === toolSurface.id,
        )
            ? events
            : undefined;
    }, "Surface creation event");
    const events = (await gym.client.getEvents({ limit: 1000 })).events;
    expect(
        events.find(
            (event) => event.type === "todo.created" && event.payload.todo.id === authored.id,
        )?.payload,
    ).toMatchObject({ todo: { authorUserId: null } });
    expect(
        events.find(
            (event) =>
                event.type === "surface.created" && event.payload.surface.id === toolSurface.id,
        )?.payload,
    ).toMatchObject({ surface: { creatorUserId: null } });
    const revisions = await gym.client.listTodoVersions(surface.id, authored.id);
    expect(revisions.versions.every((revision) => revision.todo.authorUserId === null)).toBe(true);
    await gym.restart();
    expect((await gym.client.getTodo(surface.id, authored.id)).todo).toEqual(edited);
    expect(await gym.client.listTodoVersions(surface.id, authored.id)).toEqual(revisions);
    expect((await gym.client.getDesktopBootstrap()).surfaces).toContainEqual(toolSurface);
    expect(gym.errors).toEqual([]);
}, 60_000);
