import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

const AWAY =
    "Current user presence: Away 🌙. The user is away and cannot be reached. Do not wait for an answer. Decide with your best judgement, keep working, and record anything the user should look at later.";

/**
 * Claude models with preserved thinking bind every thinking block to the `system` prompt, tools,
 * and messages before it, and reject a replayed block once any of them changed. Presence changes
 * while agents work, so it must never be part of `system`.
 */
describe("the user's presence stays out of the system prompt", () => {
    it("keeps the instructions byte-identical when presence changes mid-turn and says so in the conversation", async () => {
        const turns: GymInferenceRequest[] = [];
        const gym = await createAgentGym({
            inference(request) {
                if (request.sessionId.startsWith("naming:")) {
                    return { content: [{ type: "text", text: "<title>Unused</title>" }] };
                }
                turns.push(request);
                // The first request of the first turn sets Away; the first of the third, Online.
                const status = turns.length === 1 ? "away" : turns.length === 4 ? "online" : null;
                if (status === null) return { content: [{ type: "text", text: "Done." }] };
                return {
                    content: [
                        { type: "reasoning", text: "They asked for their presence to change." },
                        {
                            type: "tool_call",
                            name: "set_presence",
                            arguments: { input: { status } },
                        },
                    ],
                };
            },
        });
        running.add(gym);

        await gym.send("Mark me as away.", { permissionMode: "auto" });

        expect(turns).toHaveLength(2);
        expect(turns[1]!.instructions).toBe(turns[0]!.instructions);
        expect(turns[1]!.instructions).not.toContain("Current user presence");
        // Nobody had set a presence, so the first request says nothing about it.
        expect(systemTexts(turns[0]!).filter(isPresenceNotice)).toEqual([]);
        // The change is the last thing in the conversation, after the tool result that caused it.
        expect(turns[1]!.messages.at(-2)!.role).toBe("tool");
        expect(systemTexts(turns[1]!).filter(isPresenceNotice)).toEqual([AWAY]);
        expect(turns[1]!.messages.at(-1)!.role).toBe("system");

        await gym.send("Carry on.", { permissionMode: "auto" });

        expect(turns).toHaveLength(3);
        expect(turns[2]!.instructions).toBe(turns[0]!.instructions);
        // An unchanged presence is not repeated.
        expect(systemTexts(turns[2]!).filter(isPresenceNotice)).toEqual([AWAY]);

        await gym.send("I am back.", { permissionMode: "auto" });

        expect(turns).toHaveLength(5);
        expect(new Set(turns.map((turn) => turn.instructions)).size).toBe(1);
        const notices = systemTexts(turns[4]!).filter(isPresenceNotice);
        expect(notices).toHaveLength(2);
        expect(notices[0]).toBe(AWAY);
        expect(notices[1]).toMatch(/^Current user presence: Online /u);
        expect(gym.errors).toEqual([]);
    }, 30_000);
});

function isPresenceNotice(text: string): boolean {
    return text.startsWith("Current user presence: ");
}

function systemTexts(request: GymInferenceRequest): string[] {
    return request.messages.flatMap((message) =>
        message.role === "system"
            ? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
            : [],
    );
}
