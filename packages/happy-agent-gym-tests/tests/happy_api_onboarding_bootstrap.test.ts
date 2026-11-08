import { writeFile } from "node:fs/promises";
import { join } from "node:path";

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

/** The first message's prose on a computer where no AI is signed in. */
const INTRODUCTION = [
    "Hi, I'm your Chief of Staff. Hand me the work you want done, and I'll run agents that do it, several at once, and keep going while you're away.",
    "",
    "First, the AI your agents think with. They use the subscription you already have, so there's nothing new to sign up for. I didn't find one signed in on this computer. Which do you use?",
].join("\n");

afterEach(async () => {
    await gyms.dispose();
});

describe("Onboarding's scripted bootstrap", () => {
    it(
        "begins once, introducing the Chief of Staff, and types its first message out before showing it whole",
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
                skippable: false,
                onboardingVersion: 1,
                completedVersion: null,
            });

            const started = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {
                mutationId: "start-1",
            })) as { flow: OnboardingFlow };
            // Nothing works before an AI is connected, so the person cannot skip ahead yet.
            expect(started.flow).toMatchObject({
                status: "running",
                step: "providers",
                agentId: before.agentId,
                composer: "disabled",
                composerPlaceholder: "Choose an answer above",
                skippable: false,
            });
            const agentId = started.flow.agentId!;
            const announced = await gym.waitForEvent(
                (event) =>
                    (event as { type: string }).type === "onboarding.flow.updated" &&
                    (event.payload as { mutationId?: string }).mutationId === "start-1",
                "the start to be announced",
            );
            expect(announced.payload).toMatchObject({
                flow: { status: "running", step: "providers" },
            });

            // Nothing is found on this empty home, so it introduces itself and asks which AI the
            // person uses, recommending none.
            const opening = await waitForStep(gym, agentId, "providers");
            expect(opening).toMatchObject({ role: "agent" });
            expect(textOf(opening)).toBe(
                [
                    INTRODUCTION,
                    "",
                    "<menu>",
                    '  <button data-action="onboarding.next" data-step="choose" data-provider="claude" data-mark="claude">Claude</button>',
                    '  <button data-action="onboarding.next" data-step="choose" data-provider="codex" data-mark="openai">ChatGPT</button>',
                    '  <button data-action="onboarding.next" data-step="choose" data-provider="grok" data-mark="grok">Grok</button>',
                    '  <button data-action="onboarding.next" data-step="choose" data-provider="antigravity" data-mark="gemini">Gemini (Antigravity)</button>',
                    '  <button data-action="onboarding.next" data-step="none-yet">None yet</button>',
                    '  <button data-action="onboarding.next" data-step="other">API key or other</button>',
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
            ).toBe(INTRODUCTION);

            // Starting again, or after a restart, says nothing more.
            const again = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {})) as {
                flow: OnboardingFlow;
            };
            expect(again.flow.version).toBe(started.flow.version);
            await gym.restart();
            expect(await flowOf(gym)).toMatchObject({
                step: "providers",
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
            const opening = (await waitForStep(gym, agentId, "providers"))!;
            const path = `/v0/agents/${agentId}/send`;
            const start = { messageId: opening.id, controlIndex: 4, params: { step: "none-yet" } };

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
                [pressBody({ ...start, controlIndex: 6 }), 400],
                [pressBody({ ...start, params: { step: "finish" } }), 400],
                [pressBody({ ...start, params: { step: "none-yet", provider: "claude" } }), 400],
                [pressBody({ ...start, actionId: "reply" }), 400],
                [pressBody(start, { text: "None yet" }), 400],
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
                message: {
                    id: PRESS_ID,
                    role: "user",
                    content: [{ type: "text", text: "None yet" }],
                },
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
                message: { id: opening.id, actionChoices: { "0": { kind: "button", index: 4 } } },
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

            const advice = (await waitForStep(gym, agentId, "none-yet"))!;
            expect(textOf(advice)).toContain(
                "If your work already pays for ChatGPT or Claude, sign in with that account. If not, you can create one as you sign in.",
            );
            // Picking an AI recommends none.
            expect(textOf(advice)).not.toContain("data-emphasis");
            const all = await messagesOf(gym, agentId);
            expect(all.map((message) => message.role)).toEqual(["agent", "user", "agent"]);
            expect(new Set(all.map((message) => message.runId)).size).toBe(3);

            // Pressing an earlier step after the flow moved on is refused.
            const late = await gym.http.request(
                "POST",
                path,
                pressBody({ ...start, controlIndex: 5, params: { step: "other" } }),
            );
            expect(late.status).toBe(409);

            // Then See all options.
            await press(gym, agentId, {
                messageId: advice.id,
                controlIndex: 2,
                params: { step: "more" },
            });
            const catalog = (await waitForStep(gym, agentId, "more"))!;
            expect(textOf(catalog)).toContain("Here's every AI I can connect.");
            expect(textOf(catalog)).not.toContain('data-step="none-yet"');

            // Every choice outlives a restart.
            await gym.restart();
            const after = await messagesOf(gym, agentId);
            expect(after).toHaveLength(5);
            expect(after[0]?.actionChoices).toEqual({ "0": { kind: "button", index: 4 } });
            expect(after[2]?.actionChoices).toEqual({ "0": { kind: "button", index: 2 } });
            expect(await flowOf(gym)).toMatchObject({ step: "more", composer: "disabled" });
            expect(gym.inference.requests).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "shows the first step typing at once while it still works out what to say",
        async () => {
            // Claude Code answers its sign-in check only once the test lets it, as a slow check
            // on a Mac would: the providers step cannot say what it found until then.
            const { gym, home } = await gyms.start({
                stubs: {
                    claude: [
                        "#!/bin/sh",
                        'case "$*" in',
                        '  "--version") echo "2.1.312 (Claude Code)" ;;',
                        '  "auth status --json")',
                        '    while [ ! -f "$HOME/answer-sign-in-check" ]; do sleep 0.05; done',
                        `    echo '{"loggedIn":true,"authMethod":"claude.ai","email":"ada@example.com","subscriptionType":"max"}' ;;`,
                        "  *) exit 2 ;;",
                        "esac",
                        "",
                    ].join("\n"),
                },
            });
            const agentId = await startOnboarding(gym);
            const runOf = (event: { payload: unknown }) =>
                (event.payload as { run?: { id: string; status: string } }).run;
            const thinking = await gym.waitForEvent(
                (event) =>
                    event.type === "run.started" &&
                    (event.payload as { agentId?: string }).agentId === agentId &&
                    runOf(event)?.status === "running",
                "the providers step's run to start",
            );
            const runId = runOf(thinking)!.id;
            // Typing, with nothing written yet: the step is still checking Claude Code.
            expect(await flowOf(gym)).toMatchObject({ step: "providers" });
            expect(
                (await messagesOf(gym, agentId)).some((message) => message.runId === runId),
            ).toBe(false);

            await writeFile(join(home, "answer-sign-in-check"), "");
            const routes = (await waitForStep(gym, agentId, "providers"))!;
            expect(routes.runId).toBe(runId);
            expect(textOf(routes)).toContain("First, the AI your agents think with.");
            await gym.waitForEvent(
                (event) => event.type === "run.finished" && runOf(event)?.id === runId,
                "the providers step to finish typing",
            );
            const kinds = (await gym.events())
                .filter(
                    (event) =>
                        runOf(event)?.id === runId ||
                        (event.payload as { messageId?: string }).messageId === routes.id ||
                        (event.payload as { message?: { id?: string } }).message?.id === routes.id,
                )
                .map((event) => event.type);
            expect(kinds.filter((kind) => kind === "run.started")).toHaveLength(1);
            expect(kinds[0]).toBe("run.started");
            expect(kinds[1]).toBe("message.created");
            expect(kinds).toContain("message.delta");
            expect(kinds.slice(-2)).toEqual(["message.updated", "run.finished"]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
