import { afterEach, describe, expect, it } from "vitest";

import { OnboardingGyms, flowOf, messagesOf } from "./support/onboardingGym.js";

/**
 * A server that advertises chat onboarding changes nothing until a client starts it. A client that
 * predates it, or keeps it behind a flag that is off, sees exactly the classic behavior: nothing
 * stored, nothing written in the Chief of Staff's conversation, and an ordinary chat there. Turning
 * chat onboarding on later never sends that person through it.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

describe("Chat onboarding nobody started", () => {
    it(
        "leaves the Chief of Staff's conversation an ordinary chat, and finishes without a word when started later",
        async () => {
            const { gym } = await gyms.start({
                inference: [{ content: [{ type: "text", text: "Hello, Ada." }] }],
            });
            const health = (await gym.http.ok("GET", "/v0/health")) as {
                capabilities: Record<string, unknown>;
            };
            expect(health.capabilities["chatOnboarding"]).toBe(true);

            // Nothing is stored: the flow reads as not started, with the same version every time.
            const flow = await flowOf(gym);
            expect(flow).toMatchObject({
                status: "not_started",
                step: null,
                composer: "enabled",
                composerPlaceholder: null,
                completedVersion: null,
            });
            expect((await flowOf(gym)).version).toBe(flow.version);
            expect(await gym.http.ok("GET", "/v0/onboarding")).toMatchObject({
                completed: false,
                completedVersion: null,
            });
            const agentId = flow.agentId!;
            expect(await messagesOf(gym, agentId)).toEqual([]);

            // The classic setup: a profile, a typed message to the Chief of Staff, and completion.
            const { profile } = await gym.client.getProfile();
            await gym.client.updateProfile(
                { name: "Ada Lovelace", email: "ada@example.com" },
                { ifMatch: profile.version },
            );
            await gym.send("Hi there.", { sessionId: agentId });
            const request = gym.inference.requests.at(-1);
            expect(request?.instructions).not.toContain("# Onboarding");
            expect(request?.tools.map((tool) => tool.name)).not.toEqual(
                expect.arrayContaining(["save_profile"]),
            );
            expect(request?.tools.map((tool) => tool.name)).not.toContain("finish_onboarding");
            // A named profile completes nothing that never started.
            expect(await flowOf(gym)).toMatchObject({
                status: "not_started",
                version: flow.version,
                completedVersion: null,
            });
            expect(await gym.http.ok("GET", "/v0/onboarding")).toMatchObject({ completed: false });
            await gym.http.ok("POST", "/v0/onboarding/complete", {});
            expect(await gym.http.ok("GET", "/v0/onboarding")).toMatchObject({
                completed: true,
                completedVersion: null,
            });

            await gym.restart();
            expect(await flowOf(gym)).toMatchObject({ status: "not_started", step: null });
            const conversation = await messagesOf(gym, agentId);
            // The first message records its model in a configuration note, as in any chat.
            expect(
                conversation.map((message) => [
                    message.role,
                    message.content.map((block) => block.text ?? block.type).join(""),
                ]),
            ).toEqual([
                ["user", "Hi there."],
                ["service", "configuration"],
                ["agent", "Hello, Ada."],
            ]);

            // A client that turns chat onboarding on later finds the installation in use.
            const started = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {})) as {
                flow: { status: string; completedVersion: number | null };
            };
            expect(started.flow).toMatchObject({ status: "finished", completedVersion: null });
            expect(await messagesOf(gym, agentId)).toEqual(conversation);
            expect(gym.inference.unscripted).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
