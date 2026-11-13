import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/**
 * Claude models with preserved thinking bind every thinking block to the `system` prompt, tools,
 * and messages before it, and reject a replayed block once any of them changed. A task's name
 * changes on its own a few seconds into its first turn, so it must never be part of `system`.
 */
describe("a task's name stays out of the system prompt", () => {
    it("keeps the instructions byte-identical when automatic naming lands mid-turn", async () => {
        const turns: GymInferenceRequest[] = [];
        let taskId: string | undefined;
        const gym = await createAgentGym({
            async inference(request) {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ type: "text", text: "<title>Release Notes</title>" }] };
                }
                turns.push(request);
                if (turns.length !== 1) return { content: [{ type: "text", text: "Done." }] };
                // The first request is already built. Let naming land before the tool call comes
                // back, so the second request of the same turn is built under the new name.
                await gym.waitUntil(
                    async () =>
                        taskId !== undefined &&
                        (await gym.client.getTask(taskId)).task.name === "Release Notes"
                            ? true
                            : undefined,
                    "automatic naming to rename the task during its first turn",
                );
                return {
                    content: [
                        { type: "reasoning", text: "The folder is the place to look." },
                        {
                            type: "tool_call",
                            name: firstShellTool(request),
                            arguments: { cmd: "ls", command: "ls" },
                        },
                    ],
                };
            },
        });
        running.add(gym);
        const task = (await gym.client.createTask({})).task;
        taskId = task.id;
        expect(task.name).toBe("New Task");

        await gym.send("Write the release notes.", { sessionId: task.agent.id });

        expect(turns).toHaveLength(2);
        expect((await gym.client.getTask(task.id)).task.name).toBe("Release Notes");
        expect(turns[1]!.instructions).toBe(turns[0]!.instructions);
        expect(turns[0]!.instructions).not.toContain("New Task");
        expect(turns[1]!.instructions).not.toContain("Release Notes");
        // The rename waits for the next message: nothing lands between the thinking block and
        // its tool result, or anywhere else in the turn that was running.
        expect(systemTexts(turns[1]!).filter(isNameNotice)).toEqual([]);

        await gym.send("Also check spelling.", { sessionId: task.agent.id });

        expect(turns).toHaveLength(3);
        expect(turns[2]!.instructions).toBe(turns[0]!.instructions);
        const roles = turns[2]!.messages.map((message) =>
            message.role === "system" && systemText(message).some(isNameNotice)
                ? "name-notice"
                : message.role === "user"
                  ? `user:${userText(message)}`
                  : message.role,
        );
        // The notice sits immediately before the message it arrived with.
        expect(roles.slice(-2)).toEqual(["name-notice", "user:Also check spelling."]);
        expect(systemTexts(turns[2]!).filter(isNameNotice)).toEqual([
            '# Task name\nThis task is named "Release Notes". Use this name when referring to the work; it replaces any earlier name.',
        ]);
        expect(gym.errors).toEqual([]);
    }, 30_000);

    it("collapses several renames into one notice and tells a named task its name once", async () => {
        const turns: GymInferenceRequest[] = [];
        const gym = await createAgentGym({
            inference(request) {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ type: "text", text: "<title>Unused</title>" }] };
                }
                turns.push(request);
                return { content: [{ type: "text", text: "Done." }] };
            },
        });
        running.add(gym);
        const task = (await gym.client.createTask({ name: "Launch plan" })).task;

        await gym.send("Draft the plan.", { sessionId: task.agent.id });
        // A task created with a name hears it with its first message.
        expect(systemTexts(turns[0]!).filter(isNameNotice)).toEqual([
            '# Task name\nThis task is named "Launch plan". Use this name when referring to the work; it replaces any earlier name.',
        ]);

        await gym.send("Add a timeline.", { sessionId: task.agent.id });
        // An unchanged name is not repeated.
        expect(systemTexts(turns[1]!).filter(isNameNotice)).toHaveLength(1);

        const first = await gym.client.renameTask(
            task.id,
            { name: "Launch plan v2" },
            { ifMatch: (await gym.client.getTask(task.id)).task.version },
        );
        await gym.client.renameTask(
            task.id,
            { name: "Spring launch" },
            { ifMatch: first.task.version },
        );
        // A rename is not a message: it starts nothing on its own.
        expect(turns).toHaveLength(2);

        await gym.send("Share it.", { sessionId: task.agent.id });
        expect(systemTexts(turns[2]!).filter(isNameNotice)).toEqual([
            '# Task name\nThis task is named "Launch plan". Use this name when referring to the work; it replaces any earlier name.',
            '# Task name\nThis task is named "Spring launch". Use this name when referring to the work; it replaces any earlier name.',
        ]);
        expect(new Set(turns.map((turn) => turn.instructions)).size).toBe(1);
        expect(turns[0]!.instructions).not.toContain("Launch plan");
        expect(turns[2]!.instructions).not.toContain("Spring launch");
        expect(gym.errors).toEqual([]);
    }, 30_000);
});

function firstShellTool(request: GymInferenceRequest): string {
    const tool = request.tools.find((candidate) =>
        ["exec_command", "Bash", "bash", "run_terminal_command"].includes(candidate.name),
    );
    if (tool === undefined) throw new Error("The gym model was offered no shell tool.");
    return tool.name;
}

function isNameNotice(text: string): boolean {
    return text.startsWith("# Task name\n");
}

function systemTexts(request: GymInferenceRequest): string[] {
    return request.messages.flatMap((message) =>
        message.role === "system" ? systemText(message) : [],
    );
}

function systemText(message: GymInferenceRequest["messages"][number]): string[] {
    if (message.role !== "system") return [];
    return message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
}

function userText(message: GymInferenceRequest["messages"][number]): string {
    if (message.role !== "user") return "";
    return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
}
