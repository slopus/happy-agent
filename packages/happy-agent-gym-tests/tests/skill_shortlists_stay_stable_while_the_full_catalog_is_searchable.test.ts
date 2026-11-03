import { createAgentGym } from "@slopus/happy-agent-gym";
import { expect, it } from "vitest";

it("searches and reads beyond the shortlist and preserves the shortlist across use and restart", async () => {
    const files = Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => {
            const name = `skill-${String(index).padStart(4, "0")}`;
            return [
                `.agents/skills/${name}/SKILL.md`,
                `---\nname: ${name}\ndescription: Specialized workflow number ${index}.\n---\nComplete instructions for ${name}.`,
            ];
        }),
    );
    const gym = await createAgentGym({
        files,
        inference: [
            {
                content: [
                    { type: "tool_call", name: "list_skills", arguments: { query: "skill-0256" } },
                ],
            },
            {
                content: [
                    { type: "tool_call", name: "read_skill", arguments: { name: "skill-0256" } },
                ],
            },
            { content: [{ type: "text", text: "Read it." }] },
            { content: [{ type: "text", text: "Still here." }] },
            { content: [{ type: "text", text: "New task." }] },
            { content: [{ type: "text", text: "Invoked the final skill." }] },
        ],
    });
    try {
        const focused = await gym.client.getAgent(gym.defaultSessionId);
        expect(focused.slashCommands.filter((command) => command.kind === "skill")).toHaveLength(
            257,
        );
        expect(focused.slashCommands.some((command) => command.name === "skill-0256")).toBe(true);
        await gym.send("Find and read skill-0256.");
        expect(JSON.stringify(gym.inference.toolResults())).toContain(
            "Complete instructions for skill-0256.",
        );
        const shortlist = (request: (typeof gym.inference.requests)[number]) => {
            const prompt = request.instructions;
            return prompt.match(/<available_skills>[\s\S]*?<\/available_skills>/)?.[0];
        };
        const initial = shortlist(gym.inference.requests[0]!);
        expect(initial).toBeDefined();
        expect(initial!.length).toBeLessThan(12_000);
        expect(initial).not.toContain("<name>skill-0256</name>");
        expect(shortlist(gym.inference.requests[2]!)).toBe(initial);
        await gym.restart();
        await gym.send("Continue.");
        expect(shortlist(gym.inference.requests[3]!)).toBe(initial);
        const next = await gym.createSession({ cwd: gym.workspacePath });
        await gym.send("Start another task.", { sessionId: next.id });
        expect(shortlist(gym.inference.requests[4]!)).toContain("<name>skill-0256</name>");
        const invocation = await gym.client.invokeSlashCommand(gym.defaultSessionId, "skill-0256", {
            mode: { ...gym.selection, permissionMode: "auto" },
        });
        expect(invocation.slashCommands.filter((command) => command.kind === "skill")).toHaveLength(
            257,
        );
        await gym.waitUntil(async () => {
            const messages = await gym.client.getMessages(gym.defaultSessionId);
            return JSON.stringify(messages).includes("Invoked the final skill.") ? true : undefined;
        }, "the final skill invocation to complete");
        expect(gym.inference.requests.at(-1)?.instructions).toContain(
            "Complete instructions for skill-0256.",
        );
        expect(gym.errors).toEqual([]);
        expect(gym.inference.unscripted).toEqual([]);
    } finally {
        await gym.dispose();
    }
}, 60_000);
