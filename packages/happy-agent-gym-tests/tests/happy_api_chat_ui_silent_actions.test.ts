import type { HappyAgentClient } from "@slopus/happy-agent-client";
import {
    GYM_MODELS,
    createAgentGym,
    type AgentGym,
    type GymInferenceRequest,
    type GymTurn,
} from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import {
    OnboardingGyms,
    actionId,
    messagesOf,
    uiOf,
    type OnboardingMessage,
} from "./support/onboardingGym.js";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

/**
 * Silent chat UI actions: a click that changes server state, records its attempt with the
 * outcome, and is no one's message, so no turn starts. Each action carries its declared
 * permission, checked under the clicker's own authority.
 */

const running = new Set<AgentGym>();
const TEST_TIMEOUT_MS = 60_000;

const gyms = new OnboardingGyms();

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
    await gyms.dispose();
});

/** A stand-in Codex whose key sign-in never answers, so the action is still running. */
const STALLED_CODEX = `#!/bin/sh
case "$*" in
  "--version") echo "codex-cli 0.164.0" ;;
  "login status") echo "Not logged in" ;;
  "login --with-api-key") touch "$HOME/key-sign-in-started"; sleep 60 ;;
  *) exit 2 ;;
esac
`;

/** The model shows a Codex sign-in, then stops. */
function showCodex(request: GymInferenceRequest): GymTurn {
    if (request.sessionId.endsWith(":title")) {
        return { content: [{ type: "text", text: "<title>Codex</title><slug>codex</slug>" }] };
    }
    if (request.messages.at(-1)?.role === "tool") return { content: [] };
    return {
        content: [
            { type: "text", text: "Sign in to Codex here." },
            {
                type: "tool_call",
                name: "show_ui",
                arguments: {
                    components: [
                        { id: "codex", type: "provider_sign_in", props: { provider: "codex" } },
                    ],
                },
            },
        ],
    };
}

/** Every conversation's model shows the default model and a Claude sign-in, then stops. */
function showSettings(request: GymInferenceRequest): GymTurn {
    if (request.sessionId.endsWith(":title")) {
        return {
            content: [{ type: "text", text: "<title>Settings</title><slug>settings</slug>" }],
        };
    }
    if (request.messages.at(-1)?.role === "tool") return { content: [] };
    return {
        content: [
            { type: "text", text: "Here is your default model." },
            {
                type: "tool_call",
                name: "show_ui",
                arguments: {
                    components: [
                        { id: "model", type: "default_model", props: {} },
                        { id: "claude", type: "provider_sign_in", props: { provider: "claude" } },
                    ],
                },
            },
        ],
    };
}

async function shownIn(client: HappyAgentClient, gym: AgentGym, agentId: string) {
    return await gym.waitUntil(async () => {
        const page = (await client.getMessages(agentId)) as unknown as {
            runs: { id: string; messages: Omit<OnboardingMessage, "runId">[] }[];
        };
        return page.runs
            .flatMap((run) => run.messages.map((message) => ({ ...message, runId: run.id })))
            .find((message) => uiOf(message) !== undefined);
    }, "the settings to be shown");
}

function request(
    message: OnboardingMessage,
    componentId: string,
    type: string,
    payload: Record<string, unknown>,
) {
    return {
        id: actionId(),
        messageId: message.id,
        uiId: uiOf(message)!.id,
        componentId,
        action: { type, payload },
    };
}

describe("Silent chat UI actions", () => {
    it(
        "change server state, record the outcome, and start no turn",
        async () => {
            const gym = await createAgentGym({ inference: showSettings });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            await gym.send("Show me my settings.");
            const shown = await shownIn(gym.client, gym, agentId);
            const asked = gym.inference.requests.length;

            const second = GYM_MODELS[1]!;
            const set = await gym.client.sendUiAction(
                agentId,
                request(shown, "model", "default_model.set", {
                    providerId: second.providerId,
                    modelId: second.id,
                    effort: "high",
                }),
            );
            expect(set.message).toBeNull();
            expect(set.record).toMatchObject({
                role: "service",
                content: [
                    {
                        type: "action",
                        action: {
                            type: "default_model.set",
                            payload: { providerId: second.providerId, modelId: second.id },
                        },
                        outcome: { status: "accepted" },
                    },
                ],
            });
            const { config } = (await gym.http.ok("GET", "/v0/config")) as {
                config: { defaults: Record<string, unknown> };
            };
            expect(config.defaults).toMatchObject({ modelId: second.id, effort: "high" });

            // A model this server does not serve is refused by the module, and recorded so.
            const unavailable = await gym.client.sendUiAction(
                agentId,
                request(shown, "model", "default_model.set", {
                    providerId: "nowhere",
                    modelId: "no-model",
                    effort: "high",
                }),
            );
            expect(unavailable.record).toMatchObject({
                content: [{ outcome: { status: "rejected", code: "unavailable" } }],
            });

            // Silent actions are no one's message: no turn ran for either.
            expect(gym.inference.requests).toHaveLength(asked);
            // The records are history, but never model input.
            await gym.send("Thanks.");
            const next = gym.inference.requests.at(-2)!;
            expect(JSON.stringify(next.messages)).not.toContain("default_model.set");
            const records = (await messagesOf(gym, agentId)).filter(
                (message) => message.content[0]?.type === "action",
            );
            expect(records).toHaveLength(2);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuse a member what their team role does not allow, storing nothing",
        async () => {
            const team = await surfaceTeamClients({ inference: showSettings });
            const { gym, alice, bob } = team;
            running.add(gym);
            const owned = await gym.createSession({ title: "Shared" });
            const mode = {
                effort: "medium",
                modelId: gym.selection.modelId,
                permissionMode: "auto" as const,
                providerId: gym.selection.providerId,
                serviceTier: null,
            };
            const { agent } = await bob.createAgent({
                workspaceId: owned.workspaceId,
                title: "Bob's settings",
            });
            await bob.sendMessage(agent.id, { text: "Show me my settings.", mode });
            const shown = await shownIn(bob, gym, agent.id);

            // Changing the server's default model and installing an AI are the owner's.
            for (const [componentId, type, payload] of [
                [
                    "model",
                    "default_model.set",
                    { providerId: mode.providerId, modelId: mode.modelId, effort: "high" },
                ],
                ["claude", "provider_sign_in.install", {}],
            ] as const) {
                await expect(
                    bob.sendUiAction(agent.id, request(shown, componentId, type, payload)),
                ).rejects.toMatchObject({ status: 403, code: "forbidden" });
            }
            const after = (await bob.getMessages(agent.id)) as unknown as {
                runs: { messages: { content: { type: string }[] }[] }[];
            };
            expect(
                after.runs
                    .flatMap((run) => run.messages)
                    .some((message) => message.content[0]?.type === "action"),
            ).toBe(false);

            // The owner may, in a conversation of their own.
            const own = await alice.createAgent({
                workspaceId: owned.workspaceId,
                title: "Alice's settings",
            });
            await alice.sendMessage(own.agent.id, { text: "Show me my settings.", mode });
            const ownShown = await shownIn(alice, gym, own.agent.id);
            const allowed = await alice.sendUiAction(
                own.agent.id,
                request(ownShown, "model", "default_model.set", {
                    providerId: mode.providerId,
                    modelId: mode.modelId,
                    effort: "high",
                }),
            );
            expect(allowed.record).toMatchObject({
                content: [{ outcome: { status: "accepted" } }],
            });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "fail an action the daemon stopped in the middle of once it starts again",
        async () => {
            const { gym, home } = await gyms.start({
                stubs: { codex: STALLED_CODEX },
                inference: showCodex,
            });
            const agentId = gym.defaultSessionId;
            await gym.send("Connect Codex.");
            const shown = await shownIn(gym.client, gym, agentId);
            const token = "sk-stalled-SECRET-0a1b2c3d4e5f";
            const action = request(shown, "codex", "provider_sign_in.submit_token", { token });
            const pending = gym.client
                .sendUiAction(agentId, action)
                .catch((error: unknown) => error);
            await gym.waitUntil(async () => {
                const { stat } = await import("node:fs/promises");
                return await stat(`${home}/key-sign-in-started`).then(
                    () => true,
                    () => undefined,
                );
            }, "the key sign-in to start");
            // Recorded as pending while it runs, with the token left out.
            const before = (await messagesOf(gym, agentId)).find(
                (message) => message.id === action.id,
            );
            expect(before?.content[0]).toMatchObject({
                action: { type: "provider_sign_in.submit_token", payload: {} },
                outcome: { status: "pending" },
            });

            await gym.restart();
            await pending;
            const after = await gym.waitUntil(async () => {
                const record = (await messagesOf(gym, agentId)).find(
                    (message) => message.id === action.id,
                );
                const outcome = record?.content[0]?.["outcome"] as { status?: string } | undefined;
                return outcome?.status === "pending" ? undefined : record;
            }, "the interrupted action to fail");
            expect(after.content[0]).toMatchObject({
                outcome: { status: "failed", code: "interrupted" },
            });
            const said = JSON.stringify({
                messages: await messagesOf(gym, agentId),
                events: await gym.events(),
                inference: gym.inference.requests,
            });
            expect(said).not.toContain(token);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );
});
