import { describe, expect, it, vi } from "vitest";

import { formatUserInputForModel, userInputMigrations } from "../../sources/userInput/index.js";
import { cancelAskTool } from "../../sources/userInput/tools/cancel_ask.js";
import { requestUserInputTool } from "../../sources/userInput/tools/request_user_input.js";
import { resolveModuleHooks } from "../support/moduleHooks.js";
import {
    createPresenceModule,
    createUserInputDatabase,
    createUserInputModule,
} from "./userInputTestSupport.js";

const agentId = "agent-one";
const askInput = {
    question: "Which option should I use?",
    context: "The choice changes the implementation.",
} as const;

describe("UserInputModule", () => {
    it("uses ctx.db to create and resume the stable request identity", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-resume");
        await database.ready;
        try {
            const created = await module.ask(database.context, agentId, askInput, "stable-request");
            const resumed = await module.ask(database.context, agentId, askInput, "stable-request");

            expect(created.id).toBe("stable-request");
            expect(resumed).toEqual(created);
            await expect(
                module.ask(
                    database.context,
                    agentId,
                    { ...askInput, question: "A different question" },
                    "stable-request",
                ),
            ).rejects.toThrow("different input");
        } finally {
            database.close();
        }
    });

    it("gives every request its own identity when the caller names none", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-generated-identity");
        await database.ready;
        try {
            const first = await module.ask(database.context, agentId, askInput);
            const second = await module.ask(database.context, agentId, askInput);

            expect(first.id).not.toBe(second.id);
            expect(first.id).toMatch(/^[0-9a-f]{32}$/u);
            await expect(module.get(database.context, agentId, first.id)).resolves.toEqual(first);
        } finally {
            database.close();
        }
    });

    it("uses the provider call ID, does not commit manually, and waits outside its transaction", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-tool-wait");
        await database.ready;
        try {
            const tool = requestUserInputTool(module, agentId);
            expect(tool.durable).toBe(true);
            expect(tool.transactional).toBeUndefined();
            const running = tool.execute(database.context, { input: askInput }, {
                id: "tool-call",
                providerCallId: "provider-call",
            } as never);

            await vi.waitFor(async () => {
                expect(await module.get(database.context, agentId, "provider-call")).toBeDefined();
            });
            const settled = await module.answer(database.context, agentId, {
                requestId: "provider-call",
                answer: "Use the first option.",
            });
            if (settled.status !== "answered") throw new Error("expected an answer");

            await expect(running).resolves.toMatchObject({
                id: "provider-call",
                status: "answered",
            });
        } finally {
            database.close();
        }
    });

    it("settles a request nobody is there to answer in a narrow second transaction", async () => {
        const presence = createPresenceModule();
        const module = createUserInputModule(presence);
        const database = createUserInputDatabase(module, "user-input-away");
        await database.ready;
        try {
            await presence.setPresence(database.context, { status: "away" });
            const tool = requestUserInputTool(module, agentId);

            await expect(
                tool.execute(database.context, { input: askInput }, {
                    id: "internal-away-call",
                    providerCallId: "away-call",
                } as never),
            ).resolves.toMatchObject({ id: "away-call", status: "away" });
        } finally {
            database.close();
        }
    });

    it("publishes transactional and post-commit events around the mutation", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-events");
        await database.ready;
        try {
            const order: string[] = [];
            module.onEventTransactional((ctx) => {
                order.push(ctx.db === database.database ? "wrong" : "transactional");
            });
            module.onEvent(() => {
                order.push("post-commit");
            });

            await module.ask(database.context, agentId, askInput, "event-request");
            await vi.waitFor(() => expect(order).toEqual(["transactional", "post-commit"]));
        } finally {
            database.close();
        }
    });

    it("stops telling a watcher that has unsubscribed", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-unsubscribe");
        await database.ready;
        try {
            const seen: string[] = [];
            const stop = module.onEvent((_ctx, event) => {
                seen.push(event.type);
            });
            await module.ask(database.context, agentId, askInput, "watched");
            await vi.waitFor(() => expect(seen).toEqual(["user_input_requested"]));

            stop();
            await module.answer(database.context, agentId, {
                requestId: "watched",
                answer: "Done.",
            });
            expect(seen).toEqual(["user_input_requested"]);
        } finally {
            database.close();
        }
    });

    it("refuses a watcher that is not a function", () => {
        const module = createUserInputModule();
        for (const candidate of [undefined, null, 42, "listener", {}]) {
            expect(() => module.onEvent(candidate as never)).toThrow(
                "User input event listener must be a function.",
            );
            expect(() => module.onEventTransactional(candidate as never)).toThrow(
                "User input event listener must be a function.",
            );
        }
    });

    it("keeps cross-agent access denied when nothing says the agents are related", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-auth");
        await database.ready;
        try {
            const request = await module.ask(
                database.context,
                agentId,
                askInput,
                "private-request",
            );
            await expect(module.get(database.context, "other-agent", request.id)).rejects.toThrow(
                "not authorized",
            );
        } finally {
            database.close();
        }
    });

    it("keeps the forward migration that drops obsolete replay tables", () => {
        expect(userInputMigrations.map(([id]) => id)).toEqual([
            "001-user-input",
            "002-drop-user-input-idempotency",
        ]);
    });

    it("exposes cancel_ask and withdraws a pending request", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-cancel-tool");
        await database.ready;
        try {
            const hooks = await resolveModuleHooks(database.context, module);
            const tools = await hooks.tools!(database.context, {
                agent: { id: agentId },
            } as never);
            expect(tools.map((tool) => tool.name)).toEqual(["request_user_input", "cancel_ask"]);
            const request = await module.ask(database.context, agentId, askInput, "cancel-call");
            const result = await cancelAskTool(module, agentId).execute(
                database.context,
                { input: { requestId: request.id } },
                {} as never,
            );
            expect(result).toMatchObject({ id: request.id, status: "cancelled" });
        } finally {
            database.close();
        }
    });

    it("stores and settles a related batch of questions as one Inbox request", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-batch");
        await database.ready;
        try {
            const waiting = requestUserInputTool(module, agentId).execute(
                database.context,
                {
                    input: {
                        context: "Choose the scope and rollout.",
                        questions: [
                            {
                                id: "scope",
                                header: "Scope",
                                question: "Which scope should I use?",
                                options: [
                                    { label: "Small", description: "Safer first step." },
                                    { label: "Wide", description: "Faster broad rollout." },
                                ],
                                multiSelect: false,
                            },
                            {
                                id: "rollout",
                                header: "Rollout",
                                question: "Should rollout be gradual?",
                                options: {
                                    choices: [
                                        { label: "Yes", description: "Reduce deployment risk." },
                                        { label: "No", description: "Finish sooner." },
                                    ],
                                    multiSelect: false,
                                },
                            },
                        ],
                    },
                },
                { id: "internal-batch-call", providerCallId: "batch-call" } as never,
            );
            await vi.waitFor(async () => {
                expect(await module.get(database.context, agentId, "batch-call")).toBeDefined();
            });
            const request = await module.get(database.context, agentId, "batch-call");
            if (request === undefined) throw new Error("expected batch request");
            expect(request.questions?.map((question) => question.header)).toEqual([
                "Scope",
                "Rollout",
            ]);
            await module.answer(database.context, agentId, {
                requestId: request.id,
                answers: {
                    scope: "Small",
                    rollout: "Yes",
                },
            });
            await expect(waiting).resolves.toMatchObject({
                id: "batch-call",
                status: "answered",
                answers: { scope: "Small", rollout: "Yes" },
            });
        } finally {
            database.close();
        }
    });

    it("records the auto-resolution window on the request it waits on", async () => {
        const module = createUserInputModule();
        const database = createUserInputDatabase(module, "user-input-auto-resolution");
        await database.ready;
        try {
            const waiting = requestUserInputTool(module, agentId).execute(
                database.context,
                {
                    input: {
                        question: "Should I continue?",
                        context: "This is useful but not blocking.",
                        header: "Continue",
                        autoResolutionMs: 60_000,
                    },
                },
                { id: "internal-auto-call", providerCallId: "auto-call" } as never,
            );
            await vi.waitFor(async () => {
                expect(await module.get(database.context, agentId, "auto-call")).toMatchObject({
                    autoResolutionMs: 60_000,
                });
            });
            await module.answer(database.context, agentId, {
                requestId: "auto-call",
                answer: "Yes",
            });
            await expect(waiting).resolves.toMatchObject({ status: "answered" });
        } finally {
            database.close();
        }
    });

    it("re-evaluates a live presence change while a wait is in flight", async () => {
        const presence = createPresenceModule();
        const module = createUserInputModule(presence);
        const database = createUserInputDatabase(module, "user-input-presence-change");
        await database.ready;
        try {
            await presence.setPresence(database.context, { status: "online" });
            const request = await module.ask(database.context, agentId, askInput, "presence-call");
            const waiting = module.wait(database.context, agentId, request.id);

            // The person steps away: presence tells everyone watching, and the wait it was
            // holding open ends with the guidance that state carries.
            await presence.setPresence(database.context, { status: "away" });
            const result = await waiting;
            expect(result.status).toBe("away");
            const text = formatUserInputForModel(result);
            expect(text).toContain("Away 🌙");
            expect(text).toContain("cancel_ask");
            expect(text).toContain("best judgement");
        } finally {
            database.close();
        }
    });
});
