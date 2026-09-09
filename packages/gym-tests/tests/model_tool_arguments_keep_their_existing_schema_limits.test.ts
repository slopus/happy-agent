import { expect, it } from "vitest";
import { createGym } from "@slopus/happy-terminal-gym";

it("executes an ordinary model call whose valid metadata exceeds History's structured depth", async () => {
    const metadata = { a: { b: { c: { d: { e: { f: { g: { h: "kept" } } } } } } } };
    const gym = await createGym({
        inference: [
            {
                content: [
                    {
                        type: "toolCall",
                        id: "create-deep-task",
                        name: "create_task",
                        arguments: { title: "Keep nested metadata", metadata },
                    },
                ],
            },
            { content: [{ type: "text", text: "NESTED_TASK_FINISHED" }] },
        ],
    });
    try {
        gym.terminal.type("Create a task and preserve its nested metadata.");
        gym.terminal.press("enter");
        await gym.terminal.waitForText("NESTED_TASK_FINISHED", 20_000);
        const requests = gym.inference.requests.filter(
            (request) => !request.options.sessionId?.endsWith(":title"),
        );
        const results = requests
            .flatMap((request) => request.context.messages)
            .filter((message) => message.role === "tool");
        expect(JSON.stringify(results)).toContain("Task created:");
        expect(JSON.stringify(results)).not.toContain("Tool arguments exceed");
    } finally {
        await gym.dispose();
    }
}, 60_000);
