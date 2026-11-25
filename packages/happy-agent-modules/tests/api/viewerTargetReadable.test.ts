import { describe, expect, it } from "vitest";

import { notFound } from "../../sources/api/ApiError.js";
import { viewerTargetReadable } from "../../sources/api/impl/viewerTargetReadable.js";

/** One agent, read the way the API walks it: its configuration first, then its ancestry. */
function agents(...ids: string[]) {
    const stored = new Set(ids);
    return {
        stored,
        exists: async (id: string) => stored.has(id),
        /** The API's agent check, with `during` landing between its two reads. */
        check: async (id: string, during?: () => void) => {
            if (!stored.has(id)) throw notFound("The agent was not found.");
            during?.();
            // Agent Base's parentOf refuses an identity that is gone with a plain error.
            if (!stored.has(id)) throw new Error(`Agent "${id}" has not been created.`);
        },
    };
}

describe("viewerTargetReadable", () => {
    it("reads an agent that exists and refuses one that does not", async () => {
        const world = agents("agentone");
        for (const [id, readable] of [
            ["agentone", true],
            ["agenttwo", false],
        ] as const)
            expect(
                await viewerTargetReadable(
                    async () => await world.check(id),
                    async () => await world.exists(id),
                ),
            ).toBe(readable);
    });

    it("answers an agent erased partway through its check as unreadable", async () => {
        const world = agents("agentone");
        expect(
            await viewerTargetReadable(
                async () => await world.check("agentone", () => world.stored.delete("agentone")),
                async () => await world.exists("agentone"),
            ),
        ).toBe(false);
    });

    it("throws any other failure while the agent still exists", async () => {
        const failure = new Error("database is locked");
        await expect(
            viewerTargetReadable(
                async () => {
                    throw failure;
                },
                async () => true,
            ),
        ).rejects.toBe(failure);
    });
});
