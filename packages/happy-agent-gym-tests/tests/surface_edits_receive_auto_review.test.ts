import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running: AgentGym[] = [];
afterEach(async () => {
    await Promise.all(running.splice(0).map((gym) => gym.dispose()));
});

describe("Surface edits receive Auto review", () => {
    it.each(["allow", "deny"] as const)(
        "honors an Auto %s decision for an ordinary todo edit",
        async (decision) => {
            let agentId = "";
            let called = false;
            let edit: Record<string, string> = {};
            const reviews: string[] = [];
            const gym = await createAgentGym({
                permissionMode: "auto",
                inference(request) {
                    if (request.sessionId.startsWith("naming:"))
                        return { content: [{ type: "text", text: "<title>Surface edit</title>" }] };
                    if (request.sessionId !== agentId) {
                        reviews.push(JSON.stringify(request.messages));
                        return {
                            content: [
                                {
                                    type: "text",
                                    text: `<review><outcome>${decision}</outcome><risk>low</risk><user_authorization>high</user_authorization><rationale>Scripted permission decision.</rationale></review>`,
                                },
                            ],
                        };
                    }
                    if (called) return { content: [{ type: "text", text: "Finished." }] };
                    called = true;
                    return {
                        content: [{ type: "tool_call", name: "update_todo", arguments: edit }],
                    };
                },
            });
            running.push(gym);
            agentId = gym.defaultSessionId;
            const surface = (await gym.client.createSurface({ type: "todo", name: "Inbox" }))
                .surface;
            const todo = (await gym.client.createTodo(surface.id, { text: "Original" })).todo;
            edit = {
                tabId: surface.id,
                todoId: todo.id,
                version: todo.version,
                text: "Reviewed edit",
            };

            await gym.send("Change the Inbox todo from Original to Reviewed edit.", {
                permissionMode: "auto",
            });

            expect(reviews).toHaveLength(1);
            expect(reviews[0]).toContain("Change the Inbox todo from Original to Reviewed edit.");
            expect(reviews[0]).toContain("update_todo");
            const current = (await gym.client.listTodos(surface.id)).todos;
            if (decision === "allow") {
                expect(current).toEqual([
                    expect.objectContaining({ id: todo.id, text: "Reviewed edit" }),
                ]);
                expect(current[0]!.version).not.toBe(todo.version);
                await gym.waitForEvent(
                    (event) => event.type === "todo.updated",
                    "the reviewed edit event",
                );
            } else {
                expect(current).toEqual([todo]);
            }
            expect((await gym.client.listTodoVersions(surface.id, todo.id)).versions).toHaveLength(
                decision === "allow" ? 2 : 1,
            );
            const events = (await gym.client.getEvents({ limit: 1000 })).events.filter(
                (event) => event.type === "todo.updated",
            );
            expect(events).toHaveLength(decision === "allow" ? 1 : 0);
            expect(gym.errors).toEqual([]);
            expect(gym.inference.unscripted).toEqual([]);
        },
    );
});
