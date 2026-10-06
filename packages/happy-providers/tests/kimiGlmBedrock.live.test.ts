import { Type } from "@sinclair/typebox";
import { beforeAll, describe, expect, it } from "vitest";
import {
    BedrockAwsCredential,
    BedrockBearerTokenCredential,
    KimiProvider,
    GlmProvider,
    assistantMessageFromEvents,
    type BedrockCredential,
    type SessionContext,
    type SessionEvent,
    type SessionStream,
} from "@/index.js";
import { testContext } from "./testContext.js";

describe.skipIf(process.env.RIG_LIVE_TEST !== "1")(
    "Kimi and GLM Bedrock Runtime live continuation",
    () => {
        let credential: BedrockCredential;
        beforeAll(async () => {
            const loaded =
                (await BedrockBearerTokenCredential.tryLoad()) ??
                (await BedrockAwsCredential.tryLoad());
            if (loaded === null)
                throw new Error(
                    "Configure a Bedrock bearer token or AWS credentials before running the Bedrock live tests.",
                );
            credential = loaded;
        });

        for (const [name, Provider] of [
            ["Kimi K3", KimiProvider],
            ["GLM 5.3", GlmProvider],
        ] as const) {
            it(`${name} replays reasoning and tool results, then continues after native compaction`, async () => {
                const session = await new Provider({
                    credential,
                    region: process.env.AWS_REGION ?? "us-east-1",
                    inferenceMaxRetries: 0,
                }).session(`live-${crypto.randomUUID()}`, {
                    instructions:
                        "Follow the test instructions precisely. Call echo once when asked, then wait for its result before replying.",
                    tools: [
                        {
                            name: "echo",
                            description: "Echo the supplied test text.",
                            parameters: Type.Object({ text: Type.String() }),
                        },
                    ],
                });
                let context: SessionContext = {
                    instructions:
                        "Follow the test instructions precisely. Call echo once when asked, then wait for its result before replying.",
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text",
                                    text: "Calculate 13 multiplied by 17, then call echo with text BEDROCK_OK. After its result, report the calculation and the echoed text.",
                                },
                            ],
                        },
                    ],
                };
                try {
                    const first = await collect(
                        session.run(testContext, { context, effort: "low" }),
                    );
                    expect(first.at(-1)).toMatchObject({ type: "done", state: "tool_call" });
                    const assistant = assistantMessageFromEvents(first);
                    expect(assistant).toBeDefined();
                    const call = assistant!.content.find((block) => block.type === "tool_call");
                    if (call?.type !== "tool_call")
                        throw new Error("The live model did not return the requested echo call.");
                    expect(call.name).toBe("echo");
                    context = {
                        ...context,
                        messages: [
                            ...context.messages,
                            assistant!,
                            {
                                role: "tool",
                                callId: call.callId,
                                content: [{ type: "text", text: "BEDROCK_OK" }],
                            },
                        ],
                    };
                    const second = await collect(
                        session.run(testContext, { context, effort: "low" }),
                    );
                    expect(second.at(-1)).toMatchObject({ type: "done", state: "normal" });
                    const answer = assistantMessageFromEvents(second);
                    expect(
                        answer?.content
                            .filter((block) => block.type === "text")
                            .map((block) => block.text)
                            .join(""),
                    ).toContain("BEDROCK_OK");
                    context = { ...context, messages: [...context.messages, answer!] };
                    const compacted = await session.compact(testContext, {
                        context,
                        instructions: "Preserve the echoed marker and the arithmetic result.",
                    });
                    expect(compacted.status).toBe("completed");
                    if (compacted.status !== "completed")
                        throw new Error("Live Bedrock compaction did not finish.");
                    const continuation = await collect(
                        session.run(testContext, {
                            context: {
                                ...compacted.context,
                                messages: [
                                    ...compacted.context.messages,
                                    {
                                        role: "user",
                                        content: [
                                            {
                                                type: "text",
                                                text: "What was the echoed marker? Reply with the marker only.",
                                            },
                                        ],
                                    },
                                ],
                            },
                            effort: "low",
                        }),
                    );
                    expect(continuation.at(-1)).toMatchObject({ type: "done", state: "normal" });
                    expect(
                        assistantMessageFromEvents(continuation)
                            ?.content.filter((block) => block.type === "text")
                            .map((block) => block.text)
                            .join(""),
                    ).toContain("BEDROCK_OK");
                } finally {
                    session.destroy();
                }
            }, 120_000);
        }
    },
);

async function collect(stream: SessionStream): Promise<SessionEvent[]> {
    const events: SessionEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
}
