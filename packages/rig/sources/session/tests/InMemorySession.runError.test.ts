import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { HappyMessageMapper } from "../../happy/mapSessionEventToHappyMessages.js";
import { NativeProcessManager } from "../../processes/index.js";
import { createEventIdFactory, type ModelCatalog } from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
    type ProviderError,
} from "@slopus/rig-execution";
import { InMemorySession } from "../InMemorySession.js";
import { PersistentSessionStore } from "../PersistentSessionStore.js";

const PROVIDER_FAILURE =
    "An error occurred while processing your request. Please include the request ID 2c64043a in your message.";
const PROVIDER_ERROR = {
    diagnostics: {
        attempts: 3,
        code: "model_backend_failure",
        errorType: "server_error",
        requestId: "2c64043a",
        responseId: "response-1",
        retryDirective: false,
        status: 502,
        upstreamMessage: PROVIDER_FAILURE,
    },
    type: "internal_server_error",
} as const satisfies ProviderError;

describe("InMemorySession provider failures", () => {
    it("keeps the provider error text on the durable run boundary", async () => {
        const session = createSession();

        const run = session.submit({ text: "Fail this turn." });
        await expect(session.waitForRun(run.runId)).resolves.toEqual({
            errorMessage: PROVIDER_FAILURE,
            status: "error",
        });
        await expect(session.waitForRun(run.runId)).resolves.toEqual({
            errorMessage: PROVIDER_FAILURE,
            status: "error",
        });

        const boundary = runBoundary(session, run.runId);
        expect(boundary.data).toMatchObject({
            errorMessage: PROVIDER_FAILURE,
            providerError: PROVIDER_ERROR,
            providerId: "test",
            requestedModelId: "test/provider-failure",
        });
        expect(session.state().messages.map((entry) => entry.message)).toContainEqual(
            expect.objectContaining({
                blocks: [{ text: PROVIDER_FAILURE, type: "text" }],
                outcome: "failed",
                providerError: PROVIDER_ERROR,
                providerId: "test",
                requestedModelId: "test/provider-failure",
                role: "error",
            }),
        );
        expect(session.state().contextMessages).toContainEqual(
            expect.objectContaining({
                blocks: [{ text: PROVIDER_FAILURE, type: "text" }],
                outcome: "failed",
                providerError: PROVIDER_ERROR,
                providerId: "test",
                requestedModelId: "test/provider-failure",
                role: "error",
            }),
        );
    });

    it("reports the failed turn to external consumers instead of a completed one", async () => {
        const session = createSession();

        const run = session.submit({ text: "Fail this turn." });
        await session.waitForRun(run.runId);

        const mapper = new HappyMessageMapper();
        const happy = (session.events.since(undefined) ?? [])
            .flatMap((event) => mapper.map(event))
            .map((message) => message.content.ev);
        // The failure reads as the same line a failed attempt gets, told apart
        // by the outcome, and the turn still ends.
        expect(happy).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    outcome: "failed",
                    reason: PROVIDER_FAILURE,
                    t: "failure",
                }),
                expect.objectContaining({ status: "failed", t: "turn-end" }),
            ]),
        );
    });

    it("restores structured provider diagnostics from messages and run events", async () => {
        const directory = await mkdtemp(join(tmpdir(), "rig-provider-failure-"));
        const databasePath = join(directory, "sessions.sqlite");
        const fixture = createFixture();
        try {
            const initial = new PersistentSessionStore({
                createRuntime: fixture.createRuntime,
                databasePath,
                modelCatalog: fixture.catalog,
            });
            const session = initial.create({
                cwd: "/tmp/rig-provider-failure-persistence",
                modelId: fixture.model.id,
                providerId: fixture.provider.id,
            });
            const run = session.submit({ text: "Persist this failure." });
            await session.waitForRun(run.runId);
            const sessionId = session.id;
            initial.close();

            const restoredStore = new PersistentSessionStore({
                createRuntime: fixture.createRuntime,
                databasePath,
                modelCatalog: fixture.catalog,
            });
            try {
                const restored = restoredStore.get(sessionId)!;
                expect(
                    restored.state().messages.find((entry) => entry.message.role === "error")
                        ?.message,
                ).toMatchObject({
                    providerError: PROVIDER_ERROR,
                    providerId: "test",
                    requestedModelId: "test/provider-failure",
                });
                expect(
                    restored.state().contextMessages?.find((message) => message.role === "error"),
                ).toMatchObject({
                    providerError: PROVIDER_ERROR,
                    providerId: "test",
                    requestedModelId: "test/provider-failure",
                });
                expect(runBoundary(restored, run.runId).data).toMatchObject({
                    providerError: PROVIDER_ERROR,
                    providerId: "test",
                    requestedModelId: "test/provider-failure",
                });
            } finally {
                restoredStore.close();
            }
        } finally {
            await rm(directory, { force: true, recursive: true });
        }
    });
});

function createSession(): InMemorySession {
    const fixture = createFixture();
    return new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: fixture.createRuntime,
        modelCatalog: fixture.catalog,
        request: {
            cwd: "/tmp/rig-provider-failure",
            modelId: fixture.model.id,
            providerId: fixture.provider.id,
        },
    });
}

function createFixture() {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/provider-failure",
        name: "Provider failure",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            const message = assistantError(model.id);
            return createInferenceStream(async function* () {
                yield { type: "start", partial: message };
                yield { type: "error", reason: "error", error: message };
                return message;
            });
        },
    });
    const catalog: ModelCatalog = {
        defaultModelId: model.id,
        defaultProviderId: provider.id,
        models: [model],
        providers: [{ providerId: provider.id, models: [model] }],
    };
    return {
        catalog,
        createRuntime: (options: CreateCodingAssistantAgentOptions) =>
            createRuntime(options, provider),
        model,
        provider,
    };
}

function createRuntime(
    options: CreateCodingAssistantAgentOptions,
    provider: ReturnType<typeof defineProvider>,
): CodingAssistantRuntime {
    const processManager = new NativeProcessManager();
    const context = createNodeAgentContext({ cwd: options.cwd, processManager });
    return {
        agent: new Agent({
            context,
            modelId: options.modelId ?? provider.models[0]?.id ?? "",
            printToConsole: false,
            provider,
            tools: [],
        }),
        context,
        cwd: options.cwd,
        processManager,
        executor: provider,
    };
}

function assistantError(model: string): AssistantMessage {
    return {
        api: "test",
        content: [],
        errorMessage: PROVIDER_FAILURE,
        model,
        provider: "test",
        providerError: PROVIDER_ERROR,
        role: "assistant",
        stopReason: "error",
        timestamp: Date.now(),
        usage: {
            cacheRead: 0,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 0,
            output: 0,
            totalTokens: 0,
        },
    };
}

function runBoundary(session: InMemorySession, runId: string) {
    const boundary = session.events
        .since(undefined)
        ?.findLast(
            (event) =>
                (event.type === "run_finished" || event.type === "run_error") &&
                event.data.runId === runId,
        );
    if (boundary === undefined) throw new Error("The run produced no durable boundary event.");
    return boundary;
}
