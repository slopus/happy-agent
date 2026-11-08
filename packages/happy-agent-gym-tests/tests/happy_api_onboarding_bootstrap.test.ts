import { afterEach, describe, expect, it } from "vitest";

import {
    OnboardingGyms,
    flowOf,
    messagesOf,
    press,
    pressBody,
    startOnboarding,
    textOf,
    waitForStep,
    type OnboardingFlow,
} from "./support/onboardingGym.js";

/**
 * Onboarding's scripted bootstrap in the Chief of Staff's conversation, on an empty home: the
 * daemon writes every message itself and answers every press, and no model is ever asked.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await gyms.dispose();
});

describe("Onboarding's scripted bootstrap", () => {
    it(
        "begins once, under the bot's live name, and types its first message out before showing it whole",
        async () => {
            const { gym } = await gyms.start();
            const health = (await gym.http.ok("GET", "/v0/health")) as {
                capabilities: Record<string, unknown>;
            };
            expect(health.capabilities["inlineActions"]).toBe(true);
            expect(health.capabilities["chatOnboarding"]).toBe(true);
            expect(await gym.http.ok("GET", "/v0/onboarding")).toMatchObject({
                completed: false,
                onboardingVersion: 1,
                completedVersion: null,
            });
            const before = await flowOf(gym);
            expect(before).toMatchObject({
                recipe: "local",
                status: "not_started",
                step: null,
                composer: "enabled",
                composerPlaceholder: null,
                restartRequired: false,
                onboardingVersion: 1,
                completedVersion: null,
            });

            // The person renamed the Chief of Staff; the first message says the name it has now.
            const { bots } = await gym.client.listBots();
            const chief = bots.find((bot) => bot.agent.id === before.agentId);
            if (chief === undefined) throw new Error("The Chief of Staff is not a bot.");
            await gym.client.renameBot(
                chief.id,
                { name: "Ada's Office" },
                { ifMatch: chief.version },
            );

            const started = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {
                mutationId: "start-1",
            })) as { flow: OnboardingFlow };
            expect(started.flow).toMatchObject({
                status: "running",
                step: "welcome",
                agentId: before.agentId,
                composer: "disabled",
                composerPlaceholder: "Choose an answer above",
            });
            const agentId = started.flow.agentId!;
            const announced = await gym.waitForEvent(
                (event) =>
                    (event as { type: string }).type === "onboarding.flow.updated" &&
                    (event.payload as { mutationId?: string }).mutationId === "start-1",
                "the start to be announced",
            );
            expect(announced.payload).toMatchObject({
                flow: { status: "running", step: "welcome" },
            });

            const opening = await waitForStep(gym, agentId, "welcome");
            expect(opening).toMatchObject({ role: "agent" });
            expect(textOf(opening)).toBe(
                [
                    "Hi, I'm Ada&#39;s Office. I run and coordinate agents across your work, and I'll get this computer set up with you. It takes a couple of minutes.",
                    "",
                    "<menu>",
                    '  <button data-action="onboarding.next" data-step="providers" data-emphasis>Start</button>',
                    "</menu>",
                ].join("\n"),
            );

            // Stored whole, announced at reading speed: the run starts, the prose arrives in small
            // deltas, then the whole message with its button, then the run ends.
            await gym.waitForEvent(
                (event) =>
                    event.type === "run.finished" &&
                    (event.payload as { run: { id: string } }).run.id === opening!.runId,
                "the first message to finish typing",
            );
            const typed = (await gym.events())
                .map(
                    (event) =>
                        event as unknown as { type: string; payload: Record<string, unknown> },
                )
                .filter(
                    (event) =>
                        (event.payload["message"] as { id?: string } | undefined)?.id ===
                            opening!.id ||
                        event.payload["messageId"] === opening!.id ||
                        (event.payload["run"] as { id?: string } | undefined)?.id ===
                            opening!.runId,
                );
            const kinds = typed.map((event) => event.type);
            expect(kinds[0]).toBe("run.started");
            expect(kinds[1]).toBe("message.created");
            expect(kinds.filter((kind) => kind === "message.delta").length).toBeGreaterThan(5);
            expect(kinds.slice(-2)).toEqual(["message.updated", "run.finished"]);
            expect(
                typed
                    .filter((event) => event.type === "message.delta")
                    .map((event) => event.payload["append"])
                    .join(""),
            ).toBe(
                "Hi, I'm Ada&#39;s Office. I run and coordinate agents across your work, and I'll get this computer set up with you. It takes a couple of minutes.",
            );

            // Starting again, or after a restart, says nothing more.
            const again = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {})) as {
                flow: OnboardingFlow;
            };
            expect(again.flow.version).toBe(started.flow.version);
            await gym.restart();
            expect(await flowOf(gym)).toMatchObject({
                step: "welcome",
                version: started.flow.version,
            });
            expect(await messagesOf(gym, agentId)).toHaveLength(1);
            expect(gym.inference.requests).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "answers a press from the daemon's own copy of the control, once, and refuses typing",
        async () => {
            const { gym } = await gyms.start();
            const agentId = await startOnboarding(gym);
            const opening = (await waitForStep(gym, agentId, "welcome"))!;
            const path = `/v0/agents/${agentId}/send`;
            const start = { messageId: opening.id, params: { step: "providers" } };

            // The composer is disabled: a typed message is refused whatever it names, and kept
            // nowhere.
            for (const mode of [{ ...gym.selection, permissionMode: "auto" }, undefined]) {
                const typed = await gym.http.request("POST", path, {
                    text: "hello",
                    ...(mode === undefined ? {} : { mode }),
                });
                expect(typed.status, typed.text).toBe(409);
                expect(typed.body).toMatchObject({ code: "conflict" });
            }

            // Nothing in the request is trusted: a block, a control, a parameter, or an action the
            // stored message does not hold, words beside the press, or a message that is not there.
            const refused = [
                [pressBody({ ...start, blockIndex: 1 }), 404],
                [pressBody({ ...start, messageId: "nosuchmessage1234567890ab" }), 404],
                [pressBody({ ...start, controlIndex: 1 }), 400],
                [pressBody({ ...start, params: { step: "finish" } }), 400],
                [pressBody({ ...start, params: { step: "providers", provider: "claude" } }), 400],
                [pressBody({ ...start, actionId: "reply" }), 400],
                [pressBody(start, { text: "Start" }), 400],
                [{ content: [{ type: "action", messageId: opening.id }] }, 400],
            ] as const;
            for (const [body, status] of refused) {
                const response = await gym.http.request("POST", path, body);
                expect(response.status, `${JSON.stringify(body)}: ${response.text}`).toBe(status);
            }
            expect(await messagesOf(gym, agentId)).toHaveLength(1);

            // A press needs no mode, since no model answers it, and is the person's own words.
            const PRESS_ID = "q2w8e4r6t1y3u5i7o9p0a2s4";
            const pressed = await gym.http.request(
                "POST",
                path,
                pressBody(start, { id: PRESS_ID }),
            );
            expect(pressed.status, pressed.text).toBe(202);
            expect(pressed.body).toMatchObject({
                message: { id: PRESS_ID, role: "user", content: [{ type: "text", text: "Start" }] },
            });
            // The same message again is the same message, not a second press.
            const resent = await gym.http.request("POST", path, pressBody(start, { id: PRESS_ID }));
            expect(resent.status).toBe(202);
            expect(resent.body).toMatchObject({ message: { id: PRESS_ID } });
            // Another press on the chosen block conflicts, and carries the message as it stands.
            const twice = await gym.http.request("POST", path, pressBody(start));
            expect(twice.status).toBe(409);
            expect(twice.body).toMatchObject({
                code: "conflict",
                message: { id: opening.id, actionChoices: { "0": { kind: "button", index: 0 } } },
            });
            await gym.waitForEvent(
                (event) =>
                    event.type === "message.updated" &&
                    (event.payload as { message: { id: string; actionChoices?: unknown } }).message
                        .id === opening.id &&
                    (event.payload as { message: { actionChoices?: unknown } }).message
                        .actionChoices !== undefined,
                "the choice to be announced",
            );

            // Nothing is found on this empty home, so it asks which AI the person uses.
            const asked = (await waitForStep(gym, agentId, "providers"))!;
            expect(textOf(asked)).toContain(
                "I didn't find any signed in on this computer. Which do you use?",
            );
            expect(textOf(asked)).toContain(
                '<button data-action="onboarding.next" data-step="choose" data-provider="claude" data-mark="claude">Claude</button>',
            );
            const all = await messagesOf(gym, agentId);
            expect(all.map((message) => message.role)).toEqual(["agent", "user", "agent"]);
            expect(new Set(all.map((message) => message.runId)).size).toBe(3);

            // Pressing an earlier step after the flow moved on is refused.
            const late = await gym.http.request("POST", path, pressBody(start));
            expect(late.status).toBe(409);

            // None yet, then See all options.
            const noneYet = await press(gym, agentId, {
                messageId: asked.id,
                controlIndex: 4,
                params: { step: "none-yet" },
            });
            expect(textOf(noneYet)).toBe("None yet");
            const advice = (await waitForStep(gym, agentId, "none-yet"))!;
            expect(textOf(advice)).toContain(
                "I reuse the subscription you already pay for, so there's nothing new to pay for.",
            );
            await press(gym, agentId, {
                messageId: advice.id,
                controlIndex: 2,
                params: { step: "more" },
            });
            const catalog = (await waitForStep(gym, agentId, "more"))!;
            expect(textOf(catalog)).toContain("Here's every AI I can connect:");
            expect(textOf(catalog)).not.toContain('data-step="none-yet"');

            // Every choice outlives a restart.
            await gym.restart();
            const after = await messagesOf(gym, agentId);
            expect(after).toHaveLength(7);
            expect(after[0]?.actionChoices).toEqual({ "0": { kind: "button", index: 0 } });
            expect(after[2]?.actionChoices).toEqual({ "0": { kind: "button", index: 4 } });
            expect(await flowOf(gym)).toMatchObject({ step: "more", composer: "disabled" });
            expect(gym.inference.requests).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
