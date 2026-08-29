import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { AgentBase, AgentProviders, type AgentBaseMessageOptions } from "../../sources/index.js";
import { CrashingPersistence, isCrash } from "../gym/CrashingPersistence.js";
import { InMemoryPersistence } from "../gym/InMemoryPersistence.js";
import { RespondingProvider } from "../gym/RespondingProvider.js";
import { askedIn, chaosSeeds, random, textIn, transcriptOf } from "../gym/chaosWorld.js";
import { user } from "../gym/fixtures.js";

const ctx = createRootContext().named("happy-agent-base-profile-reset-chaos");

/** A profile change and its private-history replacement must survive crashes as one decision. */
describe("durability of a request-profile reset under crashes", () => {
    const seeds: number[] = chaosSeeds();

    it.each(seeds)("lands on one side of the reset %i", async (seed) => {
        const next = random(seed);
        const disk = new InMemoryPersistence();
        const providers = new AgentProviders();
        providers.add("scripted", new RespondingProvider(), "codex");

        const run = async (
            text: string | undefined,
            options: AgentBaseMessageOptions,
            crashAt: number | undefined,
        ): Promise<{ crashed: boolean; queued: boolean }> => {
            const persistence = new CrashingPersistence(disk, crashAt);
            const agent = await AgentBase.create(ctx, {
                id: "profile-reset-agent",
                providers,
                provider: "scripted",
                persistence,
            });
            let queued = text === undefined;
            try {
                if (text !== undefined) {
                    await agent.send(ctx, user(text), options);
                    queued = true;
                }
                agent.start();
                await agent.waitForIdle();
                if (!persistence.crashed) await agent.close();
                return { crashed: persistence.crashed, queued };
            } catch (error: unknown) {
                if (!isCrash(error) && !persistence.crashed) throw error;
                return { crashed: true, queued };
            }
        };

        const first = await run("before the reset", { profile: "profile-a" }, undefined);
        expect(first.crashed).toBe(false);
        expect(askedIn(transcriptOf(disk))).toEqual(["before the reset"]);

        let crashesLeft = 1 + Math.floor(next() * 4);
        let reset = false;
        let offered: string | undefined = "after the reset";
        for (let attempt = 0; attempt < 30; attempt += 1) {
            const result = await run(
                offered,
                { profile: "profile-b" },
                crashesLeft > 0 ? 1 + Math.floor(next() * 25) : undefined,
            );
            if (result.queued) offered = undefined;

            const asked = askedIn(transcriptOf(disk));
            expect([
                "before the reset",
                "before the reset|after the reset",
                "after the reset",
            ]).toContain(asked.join("|"));

            if (result.crashed) {
                crashesLeft -= 1;
                continue;
            }
            if (offered === undefined) {
                reset = true;
                break;
            }
        }
        expect(reset).toBe(true);

        const transcript = transcriptOf(disk);
        expect(askedIn(transcript)).toEqual(["after the reset"]);
        expect(disk.values.get("settings")).toMatchObject({ profile: "profile-b" });
        expect(transcript.at(-1)?.role).toBe("assistant");
        expect(textIn(transcript).at(-1)).toBe("answer-1");
    });
});
