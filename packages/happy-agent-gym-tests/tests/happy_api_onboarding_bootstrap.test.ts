import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    OnboardingGyms,
    flowOf,
    messagesOf,
    startOnboarding,
    textOf,
    uiOf,
    waitForOpening,
    type OnboardingFlow,
} from "./support/onboardingGym.js";

/**
 * Onboarding's scripted opening in the Chief of Staff's conversation, on an empty home: the
 * daemon writes it itself, with a sign-in for each AI below its words, and no model is asked.
 */

const gyms = new OnboardingGyms();
const TEST_TIMEOUT_MS = 60_000;

/** The opening's words. */
const INTRODUCTION = [
    "Hi, I'm your Chief of Staff. Hand me the work you want done, and I'll run agents that do it, several at once, and keep going while you're away.",
    "",
    "First, the AI your agents think with. They use the subscription you already have, so there's nothing new to sign up for. Connect the one you use on this computer.",
].join("\n");

afterEach(async () => {
    await gyms.dispose();
});

describe("Onboarding's scripted opening", () => {
    it(
        "begins once, with a sign-in for each AI it can connect, typed out before it shows whole",
        async () => {
            const { gym } = await gyms.start();
            const health = (await gym.http.ok("GET", "/v0/health")) as {
                capabilities: Record<string, unknown>;
            };
            expect(health.capabilities["inlineActions"]).toBeUndefined();
            expect(health.capabilities["chatOnboarding"]).toBe(true);
            expect(health.capabilities["chatUi"]).toMatchObject({
                version: 1,
                components: expect.arrayContaining(["choice", "provider_sign_in", "phone_pair"]),
            });
            const before = await flowOf(gym);
            expect(before).toMatchObject({
                recipe: "local",
                status: "not_started",
                step: null,
                composer: "enabled",
                skippable: false,
            });

            const started = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {
                mutationId: "start-1",
            })) as { flow: OnboardingFlow };
            // Nothing works before an AI is connected, so the person cannot skip ahead yet.
            expect(started.flow).toMatchObject({
                status: "running",
                step: "opening",
                agentId: before.agentId,
                composer: "disabled",
                composerPlaceholder: "Connect an AI above",
                skippable: false,
            });
            const agentId = started.flow.agentId!;

            const opening = await waitForOpening(gym, agentId);
            expect(opening.role).toBe("agent");
            expect(textOf(opening)).toBe(INTRODUCTION);
            // Claude Code and Codex have installers on Linux; each is offered, none recommended.
            const ui = uiOf(opening)!;
            expect(ui.components.map(({ id, type, props }) => ({ id, type, props }))).toEqual(
                expect.arrayContaining([
                    { id: "claude", type: "provider_sign_in", props: { provider: "claude" } },
                    { id: "codex", type: "provider_sign_in", props: { provider: "codex" } },
                ]),
            );
            expect(ui.components.every((component) => component.fallback.length > 0)).toBe(true);

            // Stored whole, announced at reading speed: the run starts, the words arrive in small
            // deltas, then the whole message with its components, then the run ends.
            await gym.waitForEvent(
                (event) =>
                    event.type === "run.finished" &&
                    (event.payload as { run: { id: string } }).run.id === opening.runId,
                "the opening to finish typing",
            );
            const typed = (await gym.events())
                .map(
                    (event) =>
                        event as unknown as { type: string; payload: Record<string, unknown> },
                )
                .filter(
                    (event) =>
                        (event.payload["message"] as { id?: string } | undefined)?.id ===
                            opening.id ||
                        event.payload["messageId"] === opening.id ||
                        (event.payload["run"] as { id?: string } | undefined)?.id === opening.runId,
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

            // A client below protocol 35 reads the components as their fallback text.
            const old = (await gym.http.ok("GET", `/v0/agents/${agentId}/messages`)) as {
                runs: { messages: { content: { type: string; text?: string }[] }[] }[];
            };
            const oldContent = old.runs.flatMap((run) => run.messages)[0]!.content;
            expect(oldContent.map((block) => block.type)).toEqual(["text", "text"]);
            expect(oldContent[1]!.text).toContain("Sign in to Claude in Happy on your computer.");

            // Starting again, or after a restart, says nothing more.
            const again = (await gym.http.ok("POST", "/v0/onboarding/flow/start", {})) as {
                flow: OnboardingFlow;
            };
            expect(again.flow.version).toBe(started.flow.version);
            await gym.restart();
            expect(await flowOf(gym)).toMatchObject({
                step: "opening",
                version: started.flow.version,
            });
            expect(await messagesOf(gym, agentId)).toHaveLength(1);
            expect(gym.inference.requests).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuses typing while it waits, and keeps nothing typed",
        async () => {
            const { gym } = await gyms.start();
            const agentId = await startOnboarding(gym);
            await waitForOpening(gym, agentId);
            const path = `/v0/agents/${agentId}/send`;
            for (const mode of [{ ...gym.selection, permissionMode: "auto" }, undefined]) {
                const typed = await gym.http.request("POST", path, {
                    text: "hello",
                    ...(mode === undefined ? {} : { mode }),
                });
                expect(typed.status, typed.text).toBe(409);
                expect(typed.body).toMatchObject({ code: "conflict" });
            }
            expect(await messagesOf(gym, agentId)).toHaveLength(1);
            expect(gym.inference.requests).toEqual([]);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "shows the opening typing at once while it still works out what to offer",
        async () => {
            // Claude Code answers its sign-in check only once the test lets it, as a slow check
            // on a Mac would: the opening cannot offer its sign-ins until then.
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
                "the opening's run to start",
            );
            const runId = runOf(thinking)!.id;
            // Typing, with nothing written yet: the opening is still checking Claude Code.
            expect(await flowOf(gym)).toMatchObject({ step: "opening" });
            expect(
                (await messagesOf(gym, agentId)).some((message) => message.runId === runId),
            ).toBe(false);

            await writeFile(join(home, "answer-sign-in-check"), "");
            const opening = await waitForOpening(gym, agentId);
            expect(opening.runId).toBe(runId);
            expect(textOf(opening)).toContain("First, the AI your agents think with.");
            await gym.waitForEvent(
                (event) => event.type === "run.finished" && runOf(event)?.id === runId,
                "the opening to finish typing",
            );
            const kinds = (await gym.events())
                .filter(
                    (event) =>
                        runOf(event)?.id === runId ||
                        (event.payload as { messageId?: string }).messageId === opening.id ||
                        (event.payload as { message?: { id?: string } }).message?.id === opening.id,
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
