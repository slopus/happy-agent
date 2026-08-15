import { describe, expect, it } from "vitest";
import { defineModel } from "@slopus/rig-execution";

import type { GymInferenceRequest } from "../../agent/gym-types.js";
import { PresenceStore, resolvePresences } from "../../presence/index.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";

const ctx = createTestRootContext();
import { isOpenQuestion } from "../../user-input/index.js";
import type { ModelCatalog } from "../../protocol/index.js";
import { InMemorySessionStore } from "../InMemorySessionStore.js";

const model = defineModel({
    defaultThinkingLevel: "off",
    id: "openai/gym",
    name: "Gym",
    thinkingLevels: ["off"],
});

const catalog: ModelCatalog = {
    defaultModelId: model.id,
    defaultProviderId: "gym",
    models: [model],
    providers: [{ models: [model], providerId: "gym" }],
};

const askCall = {
    arguments: {
        questions: [
            {
                header: "Database",
                id: "database",
                options: [
                    { description: "Use PostgreSQL.", label: "PostgreSQL" },
                    { description: "Use SQLite.", label: "SQLite" },
                ],
                question: "Which database should be used?",
            },
        ],
    },
    id: "presence-question",
    name: "request_user_input",
    type: "toolCall",
};

interface GymInference {
    readonly requests: GymInferenceRequest[];
    restore(): void;
}

/** Answers every inference call in order: the first asks the question, the rest just talk. */
function installGymInference(
    reply: (request: GymInferenceRequest, index: number) => unknown = () => ({
        content: [{ text: "Carried on.", type: "text" }],
    }),
): GymInference {
    const requests: GymInferenceRequest[] = [];
    const originalFetch = globalThis.fetch;
    const originalInferenceUrl = process.env.RIG_GYM_INFERENCE_URL;
    process.env.RIG_GYM_INFERENCE_URL = "http://gym.test/inference";
    globalThis.fetch = async (_input, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected request JSON.");
        const request = JSON.parse(init.body) as GymInferenceRequest;
        if (request.options.sessionId?.endsWith(":title") === true) {
            return new Response(
                JSON.stringify({
                    content: [
                        {
                            text: "<title>Presence</title>\n<recap>Presence test.</recap>",
                            type: "text",
                        },
                    ],
                    stopReason: "stop",
                }),
                { headers: { "content-type": "application/json" }, status: 200 },
            );
        }
        requests.push(request);
        return new Response(
            JSON.stringify(
                requests.length === 1 ? { content: [askCall] } : reply(request, requests.length),
            ),
            { headers: { "content-type": "application/json" }, status: 200 },
        );
    };
    return {
        requests,
        restore: () => {
            globalThis.fetch = originalFetch;
            if (originalInferenceUrl === undefined) delete process.env.RIG_GYM_INFERENCE_URL;
            else process.env.RIG_GYM_INFERENCE_URL = originalInferenceUrl;
        },
    };
}

async function createPresenceStore(
    presenceId: string,
    states?: Parameters<typeof resolvePresences>[0],
): Promise<PresenceStore> {
    const presence = new PresenceStore({ presences: resolvePresences(states) });
    await presence.setPresence({ presenceId });
    return presence;
}

type Session = Awaited<ReturnType<InMemorySessionStore["create"]>>;

async function createSession(store: InMemorySessionStore): Promise<Session> {
    return await store.create(ctx, {
        cwd: "/tmp/rig-presence-session",
        modelId: model.id,
        permissionMode: "full_access",
        providerId: "gym",
    });
}

async function waitForOpenQuestion(session: Session): Promise<string> {
    const deadline = Date.now() + 5_000;
    while (session.snapshot().pendingUserInputs.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    const pending = session.snapshot().pendingUserInputs[0];
    if (pending === undefined) throw new Error("Expected a waiting question.");
    return pending.requestId;
}

describe("presence and questions", () => {
    it("keeps a question open in the inbox but lets the agent finish while the user is Away", async () => {
        const inference = installGymInference();
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
            presence: await createPresenceStore("away"),
        });
        try {
            const session = await createSession(store);
            const submitted = await session.submit(ctx, { text: "Choose a database." });
            await session.waitForRun(ctx, submitted.runId);

            expect(inference.requests).toHaveLength(2);
            expect(JSON.stringify(inference.requests[0])).toContain(
                "The user is away and cannot be reached",
            );
            const toolResultText = JSON.stringify(inference.requests.at(-1));
            expect(toolResultText).toContain("the user is Away");
            expect(toolResultText).toContain("cancel_ask");
            const open = (await store.listDurableUserInputs(ctx)).filter((call) =>
                isOpenQuestion(call),
            );
            expect(open).toHaveLength(1);
            expect(open[0]?.detachedAt).toBeTypeOf("number");
        } finally {
            inference.restore();
        }
    });

    it("releases an open question when the user goes Away", async () => {
        const inference = installGymInference();
        const presence = new PresenceStore({ presences: resolvePresences() });
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
            presence,
        });
        try {
            const session = await createSession(store);
            const submitted = await session.submit(ctx, { text: "Choose a database." });
            await waitForOpenQuestion(session);

            await presence.setPresence({ presenceId: "away" });
            await session.waitForRun(ctx, submitted.runId);

            expect(JSON.stringify(inference.requests.at(-1))).toContain("the user is Away");
            expect(
                (await store.listDurableUserInputs(ctx)).filter((call) => isOpenQuestion(call)),
            ).toHaveLength(1);
        } finally {
            inference.restore();
        }
    });

    it("notifies an existing agent when presence changes", async () => {
        const inference = installGymInference();
        const presence = new PresenceStore({ presences: resolvePresences() });
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
            presence,
        });
        try {
            const session = await createSession(store);
            const first = await session.submit(ctx, { text: "Choose a database." });
            const requestId = await waitForOpenQuestion(session);
            await session.answerUserInput(ctx, requestId, { answers: { database: ["SQLite"] } });
            await session.waitForRun(ctx, first.runId);

            await presence.setPresence({ presenceId: "away" });
            const second = await session.submit(ctx, { text: "Keep going." });
            await session.waitForRun(ctx, second.runId);

            const latest = JSON.stringify(inference.requests.at(-1));
            expect(latest).toContain("The user's presence changed to Away");
            expect(latest).toContain("Do not wait for an answer");
        } finally {
            inference.restore();
        }
    });

    it("stops waiting once a custom state's answer window runs out", async () => {
        const inference = installGymInference();
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
            presence: await createPresenceStore("errands", {
                errands: { answerWaitMs: 25, emoji: "🚶", title: "Running errands" },
            }),
        });
        try {
            const session = await createSession(store);
            const submitted = await session.submit(ctx, { text: "Choose a database." });
            await session.waitForRun(ctx, submitted.runId);

            const toolResultText = JSON.stringify(inference.requests.at(-1));
            expect(toolResultText).toContain("Nobody answered within");
            expect(toolResultText).toContain("Running errands");
            const open = (await store.listDurableUserInputs(ctx)).filter((call) =>
                isOpenQuestion(call),
            );
            expect(open).toHaveLength(1);
        } finally {
            inference.restore();
        }
    });

    it("tells the agent about an answer that arrives after it stopped waiting", async () => {
        const inference = installGymInference();
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
            presence: await createPresenceStore("away"),
        });
        try {
            const session = await createSession(store);
            const first = await session.submit(ctx, { text: "Choose a database." });
            await session.waitForRun(ctx, first.runId);
            const open = (await store.listDurableUserInputs(ctx)).filter((call) =>
                isOpenQuestion(call),
            );
            const requestId = open[0]?.request.requestId;
            if (requestId === undefined) throw new Error("Expected an open question.");

            await session.answerUserInput(ctx, requestId, { answers: { database: ["SQLite"] } });
            const second = await session.submit(ctx, { text: "Carry on." });
            await session.waitForRun(ctx, second.runId);

            const latest = JSON.stringify(inference.requests.at(-1));
            expect(latest).toContain("answered the question you asked earlier");
            expect(latest).toContain("SQLite");
        } finally {
            inference.restore();
        }
    });

    it("lets the agent withdraw a question it no longer needs answered", async () => {
        const inference = installGymInference((request, index) => {
            if (index > 2) return { content: [{ text: "Carried on.", type: "text" }] };
            const askId = /as ask (?<id>[^;\s"]+)/u.exec(JSON.stringify(request))?.groups?.["id"];
            if (askId === undefined) throw new Error("Expected the ask id in the tool result.");
            return {
                content: [
                    {
                        arguments: { ask_id: askId, reason: "I found the answer myself." },
                        id: "cancel-call",
                        name: "cancel_ask",
                        type: "toolCall",
                    },
                ],
            };
        });
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
            presence: await createPresenceStore("away"),
        });
        try {
            const session = await createSession(store);
            const submitted = await session.submit(ctx, { text: "Choose a database." });
            await session.waitForRun(ctx, submitted.runId);

            expect(JSON.stringify(inference.requests.at(-1))).toContain(
                "The question was withdrawn",
            );
            expect(
                (await store.listDurableUserInputs(ctx)).filter((call) => isOpenQuestion(call)),
            ).toEqual([]);
        } finally {
            inference.restore();
        }
    });

    it("blocks on the question while the user is Online", async () => {
        const inference = installGymInference();
        const store = await InMemorySessionStore.open(ctx, {
            modelCatalog: catalog,
            presence: new PresenceStore({ presences: resolvePresences() }),
        });
        try {
            const session = await createSession(store);
            const submitted = await session.submit(ctx, { text: "Choose a database." });
            const requestId = await waitForOpenQuestion(session);

            await session.answerUserInput(ctx, requestId, { answers: { database: ["SQLite"] } });
            await session.waitForRun(ctx, submitted.runId);

            expect(inference.requests).toHaveLength(2);
            expect(JSON.stringify(inference.requests.at(-1))).toContain("SQLite");
        } finally {
            inference.restore();
        }
    });
});
