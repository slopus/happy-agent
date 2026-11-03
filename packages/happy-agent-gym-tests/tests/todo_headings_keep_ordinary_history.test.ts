import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

it("preserves heading prefixes as plain todo text through ordinary edits, ordering, states, and history", async () => {
    let surfaceId = "";
    let called = false;
    const gym = await createAgentGym({
        inference(request) {
            if (request.sessionId.startsWith("naming:"))
                return { content: [{ type: "text", text: "<title>Sections</title>" }] };
            if (called) return { content: [{ type: "text", text: "Added section." }] };
            called = true;
            return {
                content: [
                    {
                        type: "tool_call",
                        name: "create_todo",
                        arguments: {
                            tabId: surfaceId,
                            text: "#  Section with retained spacing  ",
                            authorUserId: null,
                        },
                    },
                ],
            };
        },
    });
    running.push(gym);
    surfaceId = (await gym.client.createSurface({ type: "todo", name: "Sections" })).surface.id;
    const texts = ["## Title", " # Title", "#\tTitle", "#Title", "Regular task"];
    const ordinaryIds: string[] = [];
    for (const text of texts)
        ordinaryIds.push((await gym.client.createTodo(surfaceId, { text })).todo.id);
    expect((await gym.client.listTodos(surfaceId)).todos.map((todo) => todo.text)).toEqual(
        [...texts].reverse(),
    );

    await gym.send(
        "Add a section heading with text #  Section with retained spacing  and no author attribution.",
        { permissionMode: "full_access" },
    );
    const heading = (await gym.client.listTodos(surfaceId)).todos[0]!;
    expect(heading.text).toBe("#  Section with retained spacing  ");
    expect(heading.status).toBe("active");
    const moved = (
        await gym.client.reorderTodo(
            surfaceId,
            heading.id,
            { afterId: ordinaryIds[0]! },
            { ifMatch: heading.version },
        )
    ).todo;
    expect((await gym.client.listTodos(surfaceId)).todos.at(-1)).toEqual(moved);
    const edited = (
        await gym.client.updateTodo(
            surfaceId,
            heading.id,
            { text: "Now an ordinary task" },
            { ifMatch: moved.version },
        )
    ).todo;
    const completed = (
        await gym.client.updateTodo(
            surfaceId,
            heading.id,
            { text: "# Historical section", status: "completed" },
            { ifMatch: edited.version },
        )
    ).todo;
    expect(completed.text).toBe("# Historical section");
    const deleted = (
        await gym.client.deleteTodo(surfaceId, heading.id, { ifMatch: completed.version })
    ).todo;
    const versions = [heading, moved, edited, completed, deleted];
    expect(
        (await gym.client.listTodoVersions(surfaceId, heading.id)).versions.map(
            (revision) => revision.todo,
        ),
    ).toEqual(versions);
    await gym.restart();
    expect(
        (await gym.client.listTodoVersions(surfaceId, heading.id)).versions.map(
            (revision) => revision.todo,
        ),
    ).toEqual(versions);
    expect((await gym.client.getTodo(surfaceId, heading.id)).todo).toEqual(deleted);
    expect(gym.errors).toEqual([]);
    expect(gym.inference.unscripted).toEqual([]);
});
