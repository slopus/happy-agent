import { GYM_MODELS, createAgentGym, type AgentGym } from "@slopus/happy-agent-gym";
import { afterEach, describe, expect, it } from "vitest";

import { actionOn, messagesOf, showing, shownIn, uiOf } from "./support/chatUiGym.js";
import { surfaceTeamClients } from "./support/surfaceTeamClients.js";

/**
 * Chat UI actions: a click on a component a model showed is `POST /v0/agents/:agentId/actions`.
 * It changes server state through the component's module, leaves an attempt record with its
 * outcome in a finished run of its own, and is no one's message, so no turn starts. A refusal
 * stores nothing.
 */

const running = new Set<AgentGym>();
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
    await Promise.all([...running].map(async (gym) => await gym.dispose()));
    running.clear();
});

const SETTINGS = [
    { id: "model", type: "default_model", props: {} },
    { id: "tree", type: "file_tree", props: { paths: ["src/app.ts", "README.md"] } },
];

type JournalEvent = { type: string; payload: Record<string, unknown> };

/** Every event about the message `id`, oldest first. */
async function messageEvents(gym: AgentGym, id: string): Promise<JournalEvent[]> {
    const { events } = (await gym.client.getEvents({ limit: 2000 })) as unknown as {
        events: JournalEvent[];
    };
    return events.filter(
        (event) => (event.payload["message"] as { id?: string } | undefined)?.id === id,
    );
}

function actionRecords(messages: Awaited<ReturnType<typeof messagesOf>>) {
    return messages.filter((message) => message.content[0]?.type === "action");
}

describe("Chat UI actions", () => {
    it(
        "change server state, record and announce the outcome, and start no turn",
        async () => {
            const gym = await createAgentGym({ inference: showing(SETTINGS) });
            running.add(gym);
            const agentId = gym.defaultSessionId;

            // The server says what it serves before anything is shown.
            const health = await gym.client.getHealth();
            expect(health.version.protocol).toBe(35);
            expect(health.capabilities?.chatUi).toEqual({
                version: 1,
                components: ["file_tree", "default_model", "media"],
            });

            await gym.send("Show me my settings.");
            const shown = await shownIn(gym, agentId);
            expect(uiOf(shown)?.components).toEqual([
                {
                    id: "model",
                    type: "default_model",
                    fallback: "The default model is in Settings.",
                    props: {},
                },
                {
                    id: "tree",
                    type: "file_tree",
                    fallback: "src/app.ts, README.md",
                    props: { paths: ["src/app.ts", "README.md"] },
                },
            ]);
            const asked = gym.inference.requests.length;

            const second = GYM_MODELS[1]!;
            const click = actionOn(shown, "model", "default_model.set", {
                providerId: second.providerId,
                modelId: second.id,
                effort: "high",
            });
            const set = await gym.client.sendUiAction(agentId, click);
            expect(set.record).toMatchObject({
                id: click.id,
                role: "service",
                content: [
                    {
                        type: "action",
                        messageId: shown.id,
                        uiId: uiOf(shown)!.id,
                        componentId: "model",
                        action: {
                            type: "default_model.set",
                            payload: {
                                providerId: second.providerId,
                                modelId: second.id,
                                effort: "high",
                            },
                        },
                        outcome: { status: "accepted" },
                    },
                ],
            });
            expect(set.result).toBeNull();
            expect(typeof set.cursor).toBe("string");

            // The module did the work, and every client is told the configuration changed.
            const { config } = (await gym.http.ok("GET", "/v0/config")) as {
                config: { defaults: Record<string, unknown> };
            };
            expect(config.defaults).toMatchObject({ modelId: second.id, effort: "high" });
            const after = (await gym.client.getEvents({ after: set.cursor!, limit: 2000 })) as {
                events: JournalEvent[];
            };
            expect(after.events.map((event) => event.type)).toContain("config.updated");

            // The record was announced pending when stored and again with its outcome.
            const announced = await messageEvents(gym, click.id);
            expect(
                announced.map((event) => [
                    event.type,
                    (
                        event.payload["message"] as {
                            content: { outcome: { status: string } }[];
                        }
                    ).content[0]!.outcome.status,
                ]),
            ).toEqual([
                ["message.created", "pending"],
                ["message.updated", "accepted"],
            ]);

            // A model this server does not serve is the module's refusal, recorded as one.
            const unavailable = await gym.client.sendUiAction(
                agentId,
                actionOn(shown, "model", "default_model.set", {
                    providerId: "nowhere",
                    modelId: "no-model",
                    effort: "high",
                }),
            );
            expect(unavailable.record).toMatchObject({
                content: [{ outcome: { status: "rejected", code: "unavailable" } }],
            });

            // An action is no one's message: no turn ran for either.
            expect(gym.inference.requests).toHaveLength(asked);
            // Each record is history in a finished run of its own, and never model input.
            const records = actionRecords(await messagesOf(gym, agentId));
            expect(records.map((record) => record.runStatus)).toEqual(["completed", "completed"]);
            expect(new Set([shown.runId, ...records.map((record) => record.runId)]).size).toBe(3);
            const { events } = (await gym.client.getEvents({ limit: 2000 })) as unknown as {
                events: JournalEvent[];
            };
            for (const record of records) {
                // The run is announced as already finished, and never as started.
                expect(
                    events
                        .filter(
                            (event) =>
                                (event.payload["run"] as { id?: string } | undefined)?.id ===
                                record.runId,
                        )
                        .map((event) => event.type),
                ).toEqual(["run.finished"]);
            }
            await gym.send("Thanks.");
            const next = gym.inference.requests.findLast(
                (request) => request.sessionId === agentId,
            )!;
            expect(JSON.stringify(next.messages)).not.toContain("default_model.set");
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "answer a repeated ID with the stored attempt, and refuse what does not hold, storing nothing",
        async () => {
            const gym = await createAgentGym({ inference: showing(SETTINGS) });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            await gym.send("Show me my settings.");
            const shown = await shownIn(gym, agentId);
            const first = GYM_MODELS[0]!;
            const payload = { providerId: first.providerId, modelId: first.id, effort: "high" };

            // A retry of the same click reuses its ID and reads the attempt as it stands.
            const click = actionOn(shown, "model", "default_model.set", payload);
            const set = await gym.client.sendUiAction(agentId, click);
            const again = await gym.client.sendUiAction(agentId, click);
            expect(again.record).toEqual(set.record);
            expect(again.result).toBeNull();
            expect(actionRecords(await messagesOf(gym, agentId))).toHaveLength(1);

            const refusals = [
                // 409: the ID is already a message of this conversation.
                [409, "conflict", actionOn(shown, "model", "default_model.set", payload, shown.id)],
                // 404: no such message, document, or component.
                [
                    404,
                    "not_found",
                    {
                        ...actionOn(shown, "model", "default_model.set", payload),
                        messageId: "nosuchmessage",
                    },
                ],
                [
                    404,
                    "not_found",
                    {
                        ...actionOn(shown, "model", "default_model.set", payload),
                        uiId: "nosuchdocument",
                    },
                ],
                [404, "not_found", actionOn(shown, "nobody", "default_model.set", payload)],
                // 400: not this component's action, or not this action's payload.
                [400, "invalid_request", actionOn(shown, "tree", "default_model.set", payload)],
                [400, "invalid_request", actionOn(shown, "model", "default_model.reset", {})],
                [
                    400,
                    "invalid_request",
                    actionOn(shown, "model", "default_model.set", { modelId: first.id }),
                ],
                [
                    400,
                    "invalid_request",
                    actionOn(shown, "model", "default_model.set", { ...payload, extra: true }),
                ],
            ] as const;
            for (const [status, code, request] of refusals) {
                await expect(gym.client.sendUiAction(agentId, request)).rejects.toMatchObject({
                    status,
                    code,
                });
            }
            // A body that is not a click at all.
            const malformed = await gym.http.request("POST", `/v0/agents/${agentId}/actions`, {
                id: "malformedclick",
                messageId: shown.id,
            });
            expect(malformed.status).toBe(400);
            expect(malformed.body).toMatchObject({ code: "invalid_request" });
            const missing = await gym.http.request("POST", "/v0/agents/nosuchagent/actions", click);
            expect(missing.status).toBe(404);

            expect(actionRecords(await messagesOf(gym, agentId))).toHaveLength(1);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuse the 21st action on one component within a minute",
        async () => {
            const gym = await createAgentGym({ inference: showing(SETTINGS) });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            await gym.send("Show me my settings.");
            const shown = await shownIn(gym, agentId);
            // A model nobody serves: each click is recorded as the module's refusal, cheaply.
            const click = () =>
                actionOn(shown, "model", "default_model.set", {
                    providerId: "nowhere",
                    modelId: "no-model",
                    effort: "high",
                });

            for (let index = 0; index < 20; index += 1) {
                const answer = await gym.client.sendUiAction(agentId, click());
                expect(answer.record).toMatchObject({
                    content: [{ outcome: { status: "rejected" } }],
                });
            }
            await expect(gym.client.sendUiAction(agentId, click())).rejects.toMatchObject({
                status: 429,
                code: "rate_limited",
            });
            expect(actionRecords(await messagesOf(gym, agentId))).toHaveLength(20);
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "refuse a team member what only the owner may change",
        async () => {
            const team = await surfaceTeamClients({ inference: showing(SETTINGS) });
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
            const payload = { providerId: mode.providerId, modelId: mode.modelId, effort: "high" };
            const { agent } = await bob.createAgent({
                workspaceId: owned.workspaceId,
                title: "Bob's settings",
            });
            await bob.sendMessage(agent.id, { text: "Show me my settings.", mode });
            const shown = await shownIn(gym, agent.id, bob);

            // The server's default model is the owner's to change.
            await expect(
                bob.sendUiAction(agent.id, actionOn(shown, "model", "default_model.set", payload)),
            ).rejects.toMatchObject({ status: 403, code: "forbidden" });
            expect(actionRecords(await messagesOf(gym, agent.id, bob))).toEqual([]);

            // The owner may, in a conversation of their own.
            const own = await alice.createAgent({
                workspaceId: owned.workspaceId,
                title: "Alice's settings",
            });
            await alice.sendMessage(own.agent.id, { text: "Show me my settings.", mode });
            const ownShown = await shownIn(gym, own.agent.id, alice);
            const allowed = await alice.sendUiAction(
                own.agent.id,
                actionOn(ownShown, "model", "default_model.set", payload),
            );
            expect(allowed.record).toMatchObject({
                content: [{ outcome: { status: "accepted" } }],
            });
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "read as fallback text, without attempt records, for a client below protocol 35",
        async () => {
            const gym = await createAgentGym({ inference: showing(SETTINGS, "Your settings:") });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            await gym.send("Show me my settings.");
            const shown = await shownIn(gym, agentId);
            const second = GYM_MODELS[1]!;
            const click = actionOn(shown, "model", "default_model.set", {
                providerId: second.providerId,
                modelId: second.id,
                effort: "high",
            });
            await gym.client.sendUiAction(agentId, click);

            // The raw client sends no Happy-Protocol header, as a client older than chat UI.
            const old = (await gym.http.ok("GET", `/v0/agents/${agentId}/messages`)) as {
                runs: {
                    id: string;
                    messages: { id: string; content: { type: string; text?: string }[] }[];
                }[];
            };
            const oldMessages = old.runs.flatMap((run) => run.messages);
            expect(oldMessages.find((message) => message.id === shown.id)?.content).toEqual([
                { type: "text", text: "Your settings:" },
                {
                    type: "text",
                    text: "The default model is in Settings.\n\nsrc/app.ts, README.md",
                },
            ]);
            // The attempt record is left out, with the run it alone was in.
            expect(oldMessages.some((message) => message.id === click.id)).toBe(false);
            const record = actionRecords(await messagesOf(gym, agentId))[0]!;
            expect(old.runs.some((run) => run.id === record.runId)).toBe(false);

            // The same holds for the events it pulls.
            const pulled = (await gym.http.ok("GET", "/v0/events?limit=2000")) as {
                events: JournalEvent[];
            };
            const about = (id: string) =>
                pulled.events.filter(
                    (event) => (event.payload["message"] as { id?: string } | undefined)?.id === id,
                );
            expect(about(click.id)).toEqual([]);
            const lastShown = about(shown.id).at(-1)!;
            expect(JSON.stringify(lastShown.payload)).toContain(
                "The default model is in Settings.",
            );
            expect(JSON.stringify(lastShown.payload)).not.toContain('"ui"');
            expect(gym.errors).toEqual([]);
        },
        TEST_TIMEOUT_MS,
    );

    it(
        "are not offered to, or taken for, an agent another agent manages",
        async () => {
            const gym = await createAgentGym({
                inference: (request) => {
                    if (request.sessionId.startsWith("naming:")) {
                        return { content: [{ type: "text", text: "<title>Helper</title>" }] };
                    }
                    const last = request.messages.at(-1);
                    if (request.sessionId === gym.defaultSessionId && last?.role === "user") {
                        return {
                            content: [
                                {
                                    type: "tool_call",
                                    name: "create_agent",
                                    arguments: {
                                        title: "Layout check",
                                        text: "List the project layout.",
                                        model: gym.selection.modelId,
                                        effort: gym.selection.effort,
                                        provider: gym.selection.providerId,
                                    },
                                },
                            ],
                        };
                    }
                    return { content: [{ type: "text", text: "Done." }] };
                },
            });
            running.add(gym);
            const agentId = gym.defaultSessionId;
            await gym.send("Check the layout with a helper.");
            const child = await gym.waitUntil(
                async () =>
                    (await gym.client.getAgentActivity(agentId)).subagents.find(
                        (candidate) => candidate.title === "Layout check",
                    ),
                "the helper to be created",
            );
            const childRequest = await gym.waitUntil(
                async () =>
                    gym.inference.requests.find((request) => request.sessionId === child.id),
                "the helper's first turn",
            );

            // A person can press nothing in the helper's conversation, so its model is given
            // nothing to show there; the person's own agent has both tools.
            const offered = (sessionId: string) =>
                gym.inference.requests
                    .find((request) => request.sessionId === sessionId)!
                    .tools.map((tool) => tool.name);
            expect(offered(agentId)).toEqual(
                expect.arrayContaining(["show_ui", "suggest_replies"]),
            );
            expect(childRequest.tools.map((tool) => tool.name)).not.toContain("show_ui");
            expect(childRequest.tools.map((tool) => tool.name)).not.toContain("suggest_replies");

            const refused = await gym.http.request("POST", `/v0/agents/${child.id}/actions`, {
                id: "clickonhelper",
                messageId: "anymessage",
                uiId: "anydocument",
                componentId: "model",
                action: { type: "default_model.set", payload: {} },
            });
            expect(refused.status).toBe(409);
            expect(refused.body).toMatchObject({ code: "conflict" });
        },
        TEST_TIMEOUT_MS,
    );
});
