import { describe, expect, it } from "vitest";

import { Agent, createNodeAgentContext } from "../../agent/index.js";
import { NativeProcessManager } from "../../processes/index.js";
import {
    createEventIdFactory,
    type ModelCatalog,
    type SessionEvent,
} from "../../protocol/index.js";
import type { CodingAssistantRuntime } from "../../runtime/CodingAssistantRuntime.js";
import type { CreateCodingAssistantAgentOptions } from "../../runtime/createCodingAssistantAgent.js";
import {
    createInferenceStream,
    defineModel,
    defineProvider,
    type AssistantMessage,
} from "@slopus/rig-execution";
import { InMemorySession } from "../InMemorySession.js";

const ARGUMENTS_LIMIT = 8_192;

/**
 * A search the provider ran carries its sources back, and how many it returns is the provider's
 * choice rather than Rig's. A call Rig had to close itself was already kept to a bounded prefix,
 * but that is the rare case; the ordinary one is a call that simply finished, which is every
 * completed search. Unbounded there means one unusual response grows the session's durable state
 * without limit, in memory, in SQLite, and in every replay afterwards.
 */
describe("a provider-run call the provider finished", () => {
    it("is persisted with its arguments bounded", async () => {
        const oversized = JSON.stringify({ query: "deno", sources: "x".repeat(40_000) });
        expect(oversized.length).toBeGreaterThan(ARGUMENTS_LIMIT);

        const session = createSession(oversized);
        const submitted = session.submit({ text: "Search for something." });
        await session.waitForRun(submitted.runId);

        const ended = (session.events.since(undefined) ?? []).flatMap((event: SessionEvent) => {
            if (event.type !== "agent_event") return [];
            const inner = (event.data as { event: { type: string; arguments?: string } }).event;
            return inner.type === "server_toolcall_end" ? [inner] : [];
        });

        expect(ended).toHaveLength(1);
        expect(ended[0]?.arguments?.length).toBe(ARGUMENTS_LIMIT);
        // The query leads the payload, so what survives is the part that says what was searched
        // for rather than an arbitrary window of the sources.
        expect(ended[0]?.arguments?.startsWith('{"query":"deno"')).toBe(true);

        await session.beginShutdown();
    });

    it("keeps a payload that already fits exactly as the provider sent it", async () => {
        const modest = JSON.stringify({ query: "deno", sources: ["https://deno.com"] });
        const session = createSession(modest);
        const submitted = session.submit({ text: "Search for something." });
        await session.waitForRun(submitted.runId);

        const ended = (session.events.since(undefined) ?? []).flatMap((event: SessionEvent) => {
            if (event.type !== "agent_event") return [];
            const inner = (event.data as { event: { type: string; arguments?: string } }).event;
            return inner.type === "server_toolcall_end" ? [inner] : [];
        });

        expect(ended[0]?.arguments).toBe(modest);

        await session.beginShutdown();
    });
});

function createSession(hostedArguments: string): InMemorySession {
    const model = defineModel({
        defaultThinkingLevel: "off",
        id: "test/provider-tool-call",
        name: "Provider tool call",
        thinkingLevels: ["off"],
    });
    const provider = defineProvider({
        id: "test",
        models: [model],
        stream() {
            const message = assistantMessage(model.id);
            return createInferenceStream(async function* () {
                yield { type: "start", partial: { ...message, content: [] } };
                yield { type: "server_toolcall_start", callId: "hosted-1", name: "web_search" };
                yield {
                    type: "server_toolcall_end",
                    callId: "hosted-1",
                    name: "web_search",
                    arguments: hostedArguments,
                };
                yield { type: "done", reason: "stop", message };
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
    return new InMemorySession({
        createEventId: createEventIdFactory(),
        createRuntime: (options) => createRuntime(options, provider),
        modelCatalog: catalog,
        request: {
            cwd: "/tmp/rig-provider-tool-call",
            modelId: model.id,
            providerId: provider.id,
        },
    });
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
        executor: provider,
        processManager,
    };
}

function assistantMessage(model: string): AssistantMessage {
    return {
        api: "test",
        content: [{ type: "text", text: "Here is what I found." }],
        model,
        provider: "test",
        stopReason: "stop",
        timestamp: 0,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    };
}
