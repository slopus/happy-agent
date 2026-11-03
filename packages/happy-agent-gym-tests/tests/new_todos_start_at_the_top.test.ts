import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

it("prepends API and tool-created todos but appends reactivated todos", async () => {
    let surfaceId = "";
    let called = false;
    const gym = await createAgentGym({
        inference(request) {
            if (request.sessionId.startsWith("naming:"))
                return { content: [{ type: "text", text: "<title>Todo ordering</title>" }] };
            if (called) return { content: [{ type: "text", text: "Added." }] };
            called = true;
            return {
                content: [
                    {
                        type: "tool_call",
                        name: "create_todo",
                        arguments: {
                            tabId: surfaceId,
                            text: "From the agent",
                            authorUserId: null,
                        },
                    },
                ],
            };
        },
    });
    running.push(gym);
    surfaceId = (await gym.client.createSurface({ type: "todo", name: "Inbox" })).surface.id;
    const first = (await gym.client.createTodo(surfaceId, { text: "First" })).todo;
    const second = (await gym.client.createTodo(surfaceId, { text: "Second" })).todo;
    expect((await gym.client.listTodos(surfaceId)).todos).toEqual([second, first]);
    expect(second.orderKey! < first.orderKey!).toBe(true);

    await gym.send("Add From the agent to Inbox, with no author attribution.", {
        permissionMode: "full_access",
    });
    const created = (await gym.client.listTodos(surfaceId)).todos;
    expect(created.map((todo) => todo.text)).toEqual(["From the agent", "Second", "First"]);
    expect(created.slice(1)).toEqual([second, first]);

    const completed = (
        await gym.client.updateTodo(
            surfaceId,
            second.id,
            { status: "completed" },
            { ifMatch: second.version },
        )
    ).todo;
    const restored = (
        await gym.client.updateTodo(
            surfaceId,
            second.id,
            { status: "active" },
            { ifMatch: completed.version },
        )
    ).todo;
    const ordered = [created[0], first, restored];
    expect((await gym.client.listTodos(surfaceId)).todos).toEqual(ordered);
    expect(restored.orderKey! > first.orderKey!).toBe(true);
    expect(
        (await gym.client.listTodoVersions(surfaceId, second.id)).versions.map(
            (revision) => revision.todo,
        ),
    ).toEqual([second, completed, restored]);
    expect((await gym.client.createTodo(surfaceId, { id: second.id, text: "Retry" })).todo).toEqual(
        restored,
    );
    expect((await gym.client.listTodos(surfaceId)).todos).toEqual(ordered);
    await gym.restart();
    expect((await gym.client.listTodos(surfaceId)).todos).toEqual(ordered);
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
});
