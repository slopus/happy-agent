import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runGymSql, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { OnboardingGyms, flowOf, messagesOf } from "./support/onboardingGym.js";

/**
 * An upgrade never sends a person who already uses this installation through onboarding: the
 * first start of a daemon with onboarding counts an installation in use as finished, and a preview
 * that stored onboarding in an older shape starts over from that same check.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

/** Leave the database as a release without onboarding left it: no table and no ledger rows. */
const BEFORE_ONBOARDING = [
    "DROP TABLE happy_agent_onboarding",
    "DELETE FROM happy_agent_migrations WHERE module_key = 'onboarding'",
];

async function expectFinishedWithoutOnboarding(gym: AgentGym): Promise<void> {
    const flow = await flowOf(gym);
    expect(flow).toMatchObject({ status: "finished", step: null, completedVersion: null });
    expect(await gym.http.ok("GET", "/v0/onboarding")).toMatchObject({
        completed: true,
        completedVersion: null,
    });
    const started = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {})) as {
        flow: { version: string; status: string };
    };
    expect(started.flow).toMatchObject({ status: "finished", version: flow.version });
    expect(await messagesOf(gym, flow.agentId!)).toEqual([]);
}

describe("Onboarding on an installation already in use", () => {
    it(
        "never runs where a person has already sent a message",
        async () => {
            const { gym } = await gyms.start({
                inference: [{ content: [{ type: "text", text: "Hello." }] }],
            });
            await gym.send("Hi there.");
            await gym.restart({
                whileStopped: async () => await runGymSql(gym.happyHome, BEFORE_ONBOARDING),
            });
            await expectFinishedWithoutOnboarding(gym);
            // It stays that way across later starts.
            await gym.restart();
            await expectFinishedWithoutOnboarding(gym);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "never runs where the completion marker or a named profile shows setup happened",
        async () => {
            const marked = (await gyms.start()).gym;
            await marked.restart({
                whileStopped: async () => {
                    await runGymSql(marked.happyHome, BEFORE_ONBOARDING);
                    await writeFile(join(marked.happyHome, "agent", "onboarding-v0"), "complete\n");
                },
            });
            await expectFinishedWithoutOnboarding(marked);

            const named = (await gyms.start()).gym;
            const { profile } = await named.client.getProfile();
            await named.client.updateProfile(
                { name: "Ada Lovelace" },
                { ifMatch: profile.version },
            );
            await named.restart({
                whileStopped: async () => await runGymSql(named.happyHome, BEFORE_ONBOARDING),
            });
            await expectFinishedWithoutOnboarding(named);
            expect([...marked.errors, ...named.errors]).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "starts a preview's onboarding over from the same check, whatever shape it stored",
        async () => {
            const { gym } = await gyms.start();
            const fresh = await flowOf(gym);
            // A preview applied only the first migration and stored a state this release cannot read.
            await gym.restart({
                whileStopped: async () =>
                    await runGymSql(gym.happyHome, [
                        "DELETE FROM happy_agent_migrations WHERE module_key = 'onboarding' AND migration_key <> '001-onboarding'",
                        "DELETE FROM happy_agent_onboarding",
                        `INSERT INTO happy_agent_onboarding (owner_id, state_json, updated_at)
                         VALUES ('standalone', '{"step":"guided","happyAgentId":"old","exampleSidebar":false}', 1)`,
                    ]),
            });
            // Nobody had used it, so onboarding is owed again and runs from its first step.
            const flow = await flowOf(gym);
            expect(flow).toMatchObject({
                status: "not_started",
                step: null,
                agentId: fresh.agentId,
                completedVersion: null,
            });
            expect(await gym.http.ok("GET", "/v0/onboarding")).toMatchObject({ completed: false });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
