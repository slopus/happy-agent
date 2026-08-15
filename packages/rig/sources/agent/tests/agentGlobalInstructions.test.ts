import { describe, expect, it } from "vitest";

import { Agent } from "../Agent.js";
import { AGENTS_MD_REMOVAL_NOTICE, AGENTS_MD_REPLACEMENT_NOTICE } from "../impl/agentsMdNotices.js";
import { createJustBashToolHarness } from "../../testing/createAgentTestHarness.js";
import { isInternalMessage } from "../impl/isInternalMessage.js";
import { createTestRootContext } from "../../testing/createTestRootContext.js";
import {
    defineModel,
    defineProvider,
    type AssistantMessage,
    type Context,
    type InferenceStream,
    type Usage,
} from "@slopus/rig-execution";

const ctx = createTestRootContext();

const model = defineModel({
    id: "openai/gpt-test",
    name: "GPT Test",
    thinkingLevels: ["off"],
    defaultThinkingLevel: "off",
});

function zeroUsage(): Usage {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function streamFor(message: AssistantMessage): InferenceStream {
    return {
        [Symbol.asyncIterator]: async function* () {
            yield { type: "text", text: "ok" } as never;
        },
        result: async () => message,
    } as unknown as InferenceStream;
}

function createRecordingProvider(): {
    provider: ReturnType<typeof defineProvider>;
    contexts: Context[];
} {
    const contexts: Context[] = [];
    const provider = defineProvider({
        id: "codex",
        models: [model],
        stream(_ctx, _model, context) {
            contexts.push(context);
            return streamFor({
                role: "assistant",
                content: [{ type: "text", text: "done" }],
                api: "test",
                provider: "codex",
                model: model.id,
                usage: zeroUsage(),
                stopReason: "stop",
                timestamp: contexts.length,
            });
        },
    });

    return { provider, contexts };
}

/** Stands in for the user's global AGENTS.md, which the agent reads before every turn. */
async function createWorkspace(
    provider: ReturnType<typeof defineProvider>,
    options: { global?: string; project?: string } = {},
): Promise<{ agent: Agent; setGlobalInstructions: (text: string | undefined) => void }> {
    const harness = createJustBashToolHarness({ cwd: "/workspace" });
    if (options.project !== undefined) {
        await harness.writeFile("/workspace/AGENTS.md", options.project);
    }
    let globalInstructions = options.global;
    const agent = new Agent({
        context: harness.context,
        modelId: model.id,
        provider,
        readGlobalInstructions: () => Promise.resolve(globalInstructions),
        tools: [],
    });

    return {
        agent,
        setGlobalInstructions: (text) => {
            globalInstructions = text;
        },
    };
}

function textOfFirstUserContent(context: Context): string {
    const first = context.messages[0];
    if (first?.role !== "user") return "";
    if (typeof first.content === "string") return first.content;
    return first.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

function textOfRecord(agent: Agent, index: number): string {
    const recorded = (agent.snapshot().contextMessages ?? []).filter((message) =>
        isInternalMessage(message),
    );
    return (recorded[index]?.blocks ?? [])
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
}

describe("global instructions in the conversation", () => {
    it("hands the global AGENTS.md to the model ahead of the first user message", async () => {
        const { provider, contexts } = createRecordingProvider();
        const { agent } = await createWorkspace(provider, { global: "Answer in English.\n" });

        await agent.send(ctx, "Fix the bug.");

        const leading = textOfFirstUserContent(contexts[0]!);
        expect(leading).toContain("# Global AGENTS.md instructions");
        expect(leading).toContain("Answer in English.");
        expect(contexts[0]!.messages).toHaveLength(2);
    });

    it("delivers the global instructions before the project's own", async () => {
        const { provider, contexts } = createRecordingProvider();
        const { agent } = await createWorkspace(provider, {
            global: "Answer in English.\n",
            project: "Always run the linter.\n",
        });

        await agent.send(ctx, "Fix the bug.");

        const leading = textOfFirstUserContent(contexts[0]!);
        expect(leading.indexOf("Answer in English.")).toBeLessThan(
            leading.indexOf("Always run the linter."),
        );
        expect(leading).toContain("# AGENTS.md instructions for");
    });

    it("repeats byte-identical instructions while nothing changes", async () => {
        const { provider, contexts } = createRecordingProvider();
        const { agent } = await createWorkspace(provider, { global: "Answer in English.\n" });

        await agent.send(ctx, "Fix the bug.");
        await agent.send(ctx, "Keep going.");

        expect(textOfFirstUserContent(contexts[1]!)).toBe(textOfFirstUserContent(contexts[0]!));
    });

    it("supersedes global instructions the user changed between turns", async () => {
        const { provider } = createRecordingProvider();
        const { agent, setGlobalInstructions } = await createWorkspace(provider, {
            global: "Answer in English.\n",
        });

        await agent.send(ctx, "Fix the bug.");
        setGlobalInstructions("Answer in French.\n");
        await agent.send(ctx, "Keep going.");

        expect(textOfRecord(agent, 0)).toContain("Answer in English.");
        expect(textOfRecord(agent, 1)).toContain(AGENTS_MD_REPLACEMENT_NOTICE);
        expect(textOfRecord(agent, 1)).toContain("Answer in French.");
    });

    it("tells the model when the user cleared the global instructions", async () => {
        const { provider } = createRecordingProvider();
        const { agent, setGlobalInstructions } = await createWorkspace(provider, {
            global: "Answer in English.\n",
        });

        await agent.send(ctx, "Fix the bug.");
        setGlobalInstructions(undefined);
        await agent.send(ctx, "Keep going.");

        expect(textOfRecord(agent, 1)).toContain(AGENTS_MD_REMOVAL_NOTICE);
    });

    it("adds nothing when the user has no global instructions", async () => {
        const { provider, contexts } = createRecordingProvider();
        const { agent } = await createWorkspace(provider);

        await agent.send(ctx, "Fix the bug.");

        expect(contexts[0]!.messages).toHaveLength(1);
        expect(agent.snapshot().contextMessages).toBeUndefined();
    });
});
