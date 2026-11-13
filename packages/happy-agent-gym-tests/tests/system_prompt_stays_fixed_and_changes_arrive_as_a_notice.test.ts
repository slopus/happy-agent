import { createAgentGym, type AgentGym, type GymInferenceRequest } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

const running = new Set<AgentGym>();
afterEach(async () => {
    await Promise.all([...running].map((gym) => gym.dispose()));
    running.clear();
});

/**
 * A provider caches the system prompt and everything after it, and Claude models with preserved
 * thinking reject a replayed thinking block once the prompt before it changed. So the prompt a
 * history started with is the prompt it keeps; what changes afterwards is appended as a notice.
 *
 * Permission mode stands in for every instruction that changes: its guidance is part of the
 * instructions, and nothing gives it a notice of its own.
 */
describe("the system prompt stays fixed for the life of a history", () => {
    it("keeps the prompt across turns and a restart, and says what changed after the next message", async () => {
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

        await gym.send("Look around.", { permissionMode: "auto" });
        expect(turns).toHaveLength(1);
        expect(turns[0]!.instructions).toContain("You are working in Auto mode.");
        expect(changeNotices(turns[0]!)).toEqual([]);

        await gym.send("Now only read.", { permissionMode: "read_only" });
        expect(turns).toHaveLength(2);
        // The prompt is the one the conversation began with, byte for byte.
        expect(turns[1]!.instructions).toBe(turns[0]!.instructions);
        // What changed is said once, right after the message it arrived with.
        const notices = changeNotices(turns[1]!);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain("<removed>\nYou are working in Auto mode.");
        expect(notices[0]).toContain("<added>\nYou are working in Read only mode.");
        expect(turns[1]!.messages.slice(-2).map((message) => message.role)).toEqual([
            "user",
            "system",
        ]);

        await gym.send("Still only read.", { permissionMode: "read_only" });
        expect(turns).toHaveLength(3);
        expect(turns[2]!.instructions).toBe(turns[0]!.instructions);
        // Nothing changed since the last notice, so nothing more is said.
        expect(changeNotices(turns[2]!)).toEqual(notices);

        await gym.restart();
        await gym.send("And after a restart?", { permissionMode: "read_only" });
        expect(turns).toHaveLength(4);
        expect(turns[3]!.instructions).toBe(turns[0]!.instructions);
        expect(changeNotices(turns[3]!)).toEqual(notices);

        // Going back is a change like any other: the earlier notice is superseded in turn.
        await gym.send("Back to normal.", { permissionMode: "auto" });
        expect(turns).toHaveLength(5);
        expect(turns[4]!.instructions).toBe(turns[0]!.instructions);
        const back = changeNotices(turns[4]!);
        expect(back).toHaveLength(2);
        expect(back[1]).toContain("<removed>\nYou are working in Read only mode.");
        expect(back[1]).toContain("<added>\nYou are working in Auto mode.");
        expect(gym.errors).toEqual([]);
    }, 60_000);

    it("takes the current instructions as the prompt again once compaction rebuilt the history", async () => {
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

        await gym.send("Look around.", { permissionMode: "auto" });
        await gym.send("Now only read.", { permissionMode: "read_only" });
        expect(turns[1]!.instructions).toBe(turns[0]!.instructions);
        expect(changeNotices(turns[1]!)).toHaveLength(1);

        await gym.compact();
        await gym.send("Carry on reading.", { permissionMode: "read_only" });

        const last = turns.at(-1)!;
        // No earlier thinking is replayed after compaction, so the prompt may be current again.
        expect(last.instructions).toContain("You are working in Read only mode.");
        expect(last.instructions).not.toContain("You are working in Auto mode.");
        expect(last.instructions).not.toBe(turns[0]!.instructions);
        expect(gym.errors).toEqual([]);
    }, 60_000);
});

function changeNotices(request: GymInferenceRequest): string[] {
    return request.messages.flatMap((message) =>
        message.role === "system"
            ? message.content.flatMap((block) =>
                  block.type === "text" && block.text.startsWith("# Instructions changed\n")
                      ? [block.text]
                      : [],
              )
            : [],
    );
}
