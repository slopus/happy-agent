import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

it("uses tab-only tools against existing API records and preserves them after restart", async () => {
    let nextTool: { name: string; arguments: unknown } | undefined;
    const gym = await createAgentGym({
        permissionMode: "full_access",
        inference(request) {
            if (request.sessionId.startsWith("naming:"))
                return { content: [{ type: "text", text: "<title>Tabs</title>" }] };
            if (nextTool !== undefined) {
                const tool = nextTool;
                nextTool = undefined;
                return { content: [{ type: "tool_call", ...tool }] };
            }
            return { content: [{ type: "text", text: "Finished." }] };
        },
    });
    running.push(gym);
    const tab = (await gym.client.createSurface({ type: "todo", name: "Existing list" })).surface;
    const original = (await gym.client.createTodo(tab.id, { text: "Existing content" })).todo;

    nextTool = {
        name: "create_todo",
        arguments: { surfaceId: tab.id, text: "Rejected", authorUserId: null },
    };
    await gym.send("Try the obsolete argument.", { permissionMode: "full_access" });
    expect((await gym.client.listTodos(tab.id)).todos).toEqual([original]);

    nextTool = { name: "update_tab", arguments: { tabId: tab.id, name: "Renamed tab" } };
    await gym.send("Rename the list to Renamed tab.", { permissionMode: "full_access" });
    expect((await gym.client.listSurfaces()).surfaces).toContainEqual(
        expect.objectContaining({ id: tab.id, name: "Renamed tab" }),
    );

    nextTool = { name: "list_todos", arguments: { tabId: tab.id } };
    await gym.send("Read the existing content.", { permissionMode: "full_access" });
    const results = JSON.stringify(gym.inference.toolResults());
    expect(results).toContain("tabId");
    expect(results).toContain("Existing content");
    const names = gym.inference.lastTools();
    expect(names).not.toContain("list_surfaces");
    expect(names).not.toContain("update_surface");
    expect(names).toContain("list_tabs");
    expect(names).toContain("update_tab");

    await gym.restart();
    expect((await gym.client.listTodos(tab.id)).todos).toEqual([original]);
    expect((await gym.client.listSurfaces()).surfaces).toContainEqual(
        expect.objectContaining({ id: tab.id, name: "Renamed tab", members: tab.members }),
    );
    expect((await gym.client.listTodoVersions(tab.id, original.id)).versions).toHaveLength(1);
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
}, 60_000);
