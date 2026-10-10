import { createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const activeGyms = new Set<AgentGym>();

afterEach(async () => {
    await Promise.all([...activeGyms].map(async (gym) => await gym.dispose()));
    activeGyms.clear();
});

describe("the public slash command API", () => {
    it("discovers, invokes, refreshes, and notifies through the real daemon boundary", async () => {
        const gym = await createAgentGym({
            files: {
                ".agents/skills/review/SKILL.md": skill(
                    "review",
                    "Review the current changes.",
                    "Inspect authentication carefully.",
                ),
            },
            inference: (request) => {
                expect(request.instructions).toContain("Inspect authentication carefully.");
                expect(JSON.stringify(request.messages.at(-1))).toContain(
                    "focus on authentication",
                );
                return { content: [{ text: "Skill invocation finished.", type: "text" }] };
            },
        });
        activeGyms.add(gym);

        const focused = await gym.client.getAgent(gym.defaultSessionId);
        expect(focused.slashCommands).toEqual([
            {
                description: "Summarize older messages to free context space.",
                hasArguments: false,
                kind: "compaction",
                name: "compact",
            },
            {
                description: "Review the current changes.",
                hasArguments: true,
                kind: "skill",
                name: "review",
            },
        ]);
        await expect(gym.client.getAgentBootstrap(gym.defaultSessionId)).resolves.toMatchObject({
            slashCommands: focused.slashCommands,
        });

        const invoked = await gym.client.invokeSlashCommand(gym.defaultSessionId, "review", {
            arguments: "focus on authentication",
            mode: modeFor(gym),
            mutationId: "slash-review",
        });
        expect(invoked.command).toMatchObject({ kind: "skill", name: "review" });
        expect(invoked.slashCommands).toEqual(focused.slashCommands);

        await gym.waitUntil(async () => {
            const history = await gym.client.getMessages(gym.defaultSessionId);
            return JSON.stringify(history).includes("Skill invocation finished.")
                ? history
                : undefined;
        }, "the invoked skill run to finish");
        expect(JSON.stringify(await gym.client.getMessages(gym.defaultSessionId))).toContain(
            "Use the /review skill.",
        );
        await expect(
            gym.client.getSlashCommandImage(gym.defaultSessionId, "review"),
        ).rejects.toMatchObject({ status: 404 });

        await gym.writeFile(
            ".agents/skills/review/SKILL.md",
            skill("audit", "Audit the current changes.", "Audit everything."),
        );
        await expect(
            gym.client.invokeSlashCommand(gym.defaultSessionId, "review", {
                mode: modeFor(gym),
                mutationId: "slash-refresh",
            }),
        ).rejects.toMatchObject({ status: 404 });

        const changed = await gym.waitForEvent(
            (event) =>
                event.type === "agent.slash_commands.updated" &&
                event.payload.agentId === gym.defaultSessionId &&
                event.payload.mutationId === "slash-refresh",
            "the changed slash command catalog",
        );
        if (changed.type !== "agent.slash_commands.updated") {
            throw new Error("The matched event was not a slash command update.");
        }
        expect(changed.payload.slashCommands).toEqual([
            expect.objectContaining({ name: "compact" }),
            expect.objectContaining({ name: "audit" }),
        ]);
        expect((await gym.client.getAgent(gym.defaultSessionId)).slashCommands).toEqual(
            changed.payload.slashCommands,
        );

        const compacted = await gym.client.invokeSlashCommand(gym.defaultSessionId, "compact", {
            mode: modeFor(gym),
            mutationId: "slash-compact",
        });
        expect(compacted.command).toMatchObject({ kind: "compaction", name: "compact" });
        expect(JSON.stringify(await gym.client.getMessages(gym.defaultSessionId))).toContain(
            '"type":"compaction"',
        );

        await expect(
            gym.client.invokeSlashCommand(gym.defaultSessionId, "compact", {
                arguments: "not allowed",
                mode: modeFor(gym),
            }),
        ).rejects.toMatchObject({ status: 400 });

        await gym.restart();
        await expect(gym.client.getAgent(gym.defaultSessionId)).resolves.toMatchObject({
            slashCommands: [
                expect.objectContaining({ name: "compact" }),
                expect.objectContaining({ name: "audit" }),
            ],
        });
    });
});

function modeFor(gym: AgentGym) {
    return {
        effort: gym.selection.effort,
        modelId: gym.selection.modelId,
        permissionMode: "auto" as const,
        providerId: gym.selection.providerId,
        serviceTier: null,
    };
}

function skill(name: string, description: string, instructions: string): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}`;
}
