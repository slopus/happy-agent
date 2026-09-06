import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SessionEvent } from "@slopus/happy-providers";
import { createRootContext } from "@steve.kite/stdlib";
import { expect, it } from "vitest";

import { openClaudeRestartGym } from "../gym/openClaudeRestartGym.js";
import { loadRealProvider } from "./loadRealProvider.js";

const live = process.env.RIG_LIVE_TEST === "1";

it.skipIf(!live)(
    "receives real Claude cache hits before and after reopening Agent Base and SQLite",
    async () => {
        const ctx = createRootContext().named("claude-live-cache-restart");
        const directory = await mkdtemp(join(tmpdir(), "agent-base-live-cache-"));
        // Exceed the model's minimum cache size with a stable, synthetic, non-sensitive prefix.
        const instructions = [
            "This is an automated prompt-cache check. Solve the user's problem carefully and give a concise answer with verification.",
            ...Array.from(
                { length: 512 },
                (_, index) =>
                    `Reference item ${index}: preserve signed reasoning and the complete stable conversation prefix across agent restarts.`,
            ),
        ].join("\n");
        let gym: Awaited<ReturnType<typeof openClaudeRestartGym>> | undefined;
        const open = async () => {
            const real = await loadRealProvider("claude");
            if (real === null)
                throw new Error("Sign in to Claude Code before running the live cache test.");
            return await openClaudeRestartGym(ctx, {
                databasePath: join(directory, "agent.sqlite"),
                provider: real.provider,
                instructions,
                model: "anthropic/fable-5-1",
            });
        };
        try {
            gym = await open();
            const first = usageOf(
                await gym.ask(
                    "Find the smallest integer n greater than 1000000 such that n mod 97 = 31, n mod 89 = 47, and n mod 83 = 59. Solve the simultaneous congruences carefully, then return n and verify all three remainders.",
                ),
            );
            const warm = usageOf(
                await gym.ask(
                    "For that same n, calculate the least positive integer k for which n + 97*89*83*k is divisible by 73. Return k and verify the divisibility.",
                ),
            );
            console.log("Claude live cache usage before restart:", { first, warm });
            expect(warm.cacheRead).toBeGreaterThan(0);
            const records = await gym.records();
            const signedReasoning = records.filter(
                (record) =>
                    record.type === "block" &&
                    record.block.type === "reasoning" &&
                    Boolean(record.block.reasoning),
            );
            expect(signedReasoning.length).toBeGreaterThan(0);
            await gym.close();
            gym = undefined;

            gym = await open();
            expect(await gym.records()).toEqual(records);
            const restarted = usageOf(
                await gym.ask(
                    "Using the n and k already calculated, verify that the resulting number still satisfies all three original congruences. Give the four remainders concisely.",
                ),
            );
            console.log("Claude live cache usage (cold, warm, restarted):", {
                first,
                warm,
                restarted,
            });
            expect(restarted.cacheRead).toBeGreaterThan(0);
            expect(restarted.cacheRead).toBeGreaterThanOrEqual(warm.cacheRead);
        } finally {
            await gym?.close();
            await rm(directory, { recursive: true, force: true });
        }
    },
    180_000,
);

function usageOf(events: readonly SessionEvent[]) {
    expect(events.at(-1)).toMatchObject({ type: "done", state: "normal" });
    const usage = events.filter((event) => event.type === "token_usage").at(-1)?.usage;
    if (usage === undefined) throw new Error("Claude did not report token usage.");
    return usage;
}
