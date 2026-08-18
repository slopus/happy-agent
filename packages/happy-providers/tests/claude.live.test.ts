import { testContext } from "./testContext.js";

import { createServer } from "node:http";
import { query as claudeSdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { Type, type TSchema } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { ClaudeAuthTokenCredential } from "@/vendors/claude/ClaudeAuthTokenCredential.js";
import { ClaudeCodeCredential } from "@/vendors/claude/ClaudeCodeCredential.js";
import { ClaudeSession, type ClaudeSdkQuery } from "@/vendors/claude/ClaudeSession.js";
import { renderClaudeSystemPrompt } from "@/vendors/claude/impl/renderClaudeSystemPrompt.js";
import { claude_opus_4_8_system_prompt } from "@/vendors/claude/prompts/claude_opus_4_8_system_prompt.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { collectSessionEvents, textFromSessionEvents } from "./helpers/collectSessionEvents.js";

const live = process.env.RIG_LIVE_TEST === "1" && process.env.ANTHROPIC_AUTH_TOKEN;
const liveTools: readonly SessionTool[] = [
    {
        name: "Read",
        description: "Read one file during the live provider check.",
        parameters: Type.Object(
            { file_path: Type.String({ description: "Absolute file path." }) },
            { additionalProperties: false },
        ),
    },
];

describe.skipIf(!live)("Claude live session", () => {
    it(
        "sends the complete supplied system prompt and tool schemas over the wire",
        { timeout: 120_000 },
        async () => {
            let capturedRequest:
                | {
                      system: { text: string }[];
                      tools: { name: string; description: string; input_schema: TSchema }[];
                  }
                | undefined;
            const server = createServer(async (request, response) => {
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const requestBody = Buffer.concat(chunks);
                if (requestBody.length > 0 && request.url?.startsWith("/v1/messages")) {
                    capturedRequest = JSON.parse(requestBody.toString("utf8"));
                }
                const headers = new Headers();
                for (const [name, value] of Object.entries(request.headers)) {
                    if (
                        value === undefined ||
                        ["connection", "content-length", "host"].includes(name)
                    ) {
                        continue;
                    }
                    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
                }
                const upstream = await fetch(`https://api.anthropic.com${request.url}`, {
                    method: request.method ?? "POST",
                    headers,
                    ...(requestBody.length === 0 ? {} : { body: requestBody }),
                });
                const responseBody = Buffer.from(await upstream.arrayBuffer());
                response.writeHead(
                    upstream.status,
                    Object.fromEntries(
                        [...upstream.headers].filter(
                            ([name]) =>
                                ![
                                    "content-encoding",
                                    "content-length",
                                    "transfer-encoding",
                                ].includes(name),
                        ),
                    ),
                );
                response.end(responseBody);
            });
            await new Promise<void>((resolve, reject) => {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", resolve);
            });
            const address = server.address();
            if (address === null || typeof address === "string") {
                throw new Error("Missing Claude capture port.");
            }
            const credential = await ClaudeAuthTokenCredential.tryLoad({ env: process.env });
            if (credential === null) throw new Error("Missing ANTHROPIC_AUTH_TOKEN.");
            const session = new ClaudeSession("wire-golden", {
                instructions: "Wire-specific instructions.",
                credential,
                env: {
                    ...process.env,
                    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
                },
                model: "opus[1m]",
                tools: liveTools,
            });
            try {
                await collectSessionEvents(
                    session.run(testContext, {
                        context: {
                            instructions: "",
                            messages: [
                                {
                                    role: "user",
                                    content: [
                                        { type: "text" as const, text: "Reply exactly WIRE_OK." },
                                    ],
                                },
                            ],
                        },
                    }),
                );
            } finally {
                session.destroy();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
            expect(capturedRequest?.system.at(-1)?.text).toBe(
                `${renderClaudeSystemPrompt(claude_opus_4_8_system_prompt, {
                    cwd: process.cwd(),
                    env: process.env,
                })}\n\nWire-specific instructions.`,
            );
            expect(capturedRequest?.tools.map(({ name }) => name).sort()).toEqual(
                liveTools.map(({ name }) => name).sort(),
            );
            expect(capturedRequest?.tools.every(({ description }) => description.length > 0)).toBe(
                true,
            );
            expect(
                capturedRequest?.tools
                    .map(({ name, input_schema }) => ({
                        name,
                        input_schema: normalizeJsonSchema(input_schema),
                    }))
                    .sort((left, right) => left.name.localeCompare(right.name)),
            ).toEqual(
                liveTools
                    .map(({ name, parameters }) => ({
                        name,
                        input_schema: normalizeJsonSchema(parameters),
                    }))
                    .sort((left, right) => left.name.localeCompare(right.name)),
            );
        },
    );

    it(
        "runs stripped SDK turns, switches models, and compacts reconstructed context",
        { timeout: 120_000 },
        async () => {
            const credential = await ClaudeAuthTokenCredential.tryLoad({
                env: process.env,
            });
            if (credential === null) throw new Error("Missing ANTHROPIC_AUTH_TOKEN.");
            const instructions =
                "You are testing Rig's Claude provider. Follow exact reply instructions.";
            const firstMessages = [
                {
                    role: "user" as const,
                    content: [
                        {
                            type: "text" as const,
                            text: "Reply with exactly FIRST RIG_CLAUDE_SKILL and nothing else.",
                        },
                    ],
                },
            ];
            const switchedMessages = [
                ...firstMessages,
                {
                    role: "assistant" as const,
                    content: [{ type: "text" as const, text: "FIRST RIG_CLAUDE_SKILL" }],
                },
                {
                    role: "user" as const,
                    content: [
                        {
                            type: "text" as const,
                            text: "Remember the exact marker RIG_CLAUDE_SKILL. Reply with exactly SWITCHED and nothing else.",
                        },
                    ],
                },
            ];
            const session = new ClaudeSession("happy-providers-claude-live", {
                instructions,
                credential,
                model: "opus[1m]",
            });
            try {
                const first = await collectSessionEvents(
                    session.run(testContext, {
                        context: {
                            instructions,
                            messages: firstMessages,
                        },
                    }),
                );
                expect(textFromSessionEvents(first).trim()).toBe("FIRST RIG_CLAUDE_SKILL");

                const switched = await collectSessionEvents(
                    session.run(testContext, {
                        model: "sonnet[1m]",
                        context: {
                            instructions,
                            messages: switchedMessages,
                        },
                    }),
                );
                expect(textFromSessionEvents(switched).trim()).toBe("SWITCHED");

                const compacted = await session.compact(testContext, {
                    instructions: "Preserve the exact markers RIG_CLAUDE_SKILL and SWITCHED.",
                    context: {
                        instructions,
                        messages: switchedMessages,
                    },
                });
                expect(compacted.status).toBe("completed");
                if (compacted.status === "completed") {
                    expect(compacted.summary).toContain("RIG_CLAUDE_SKILL");
                    expect(compacted.summary).toContain("SWITCHED");
                    const continued = await collectSessionEvents(
                        session.run(testContext, {
                            context: {
                                instructions,
                                messages: [
                                    ...compacted.context.messages,
                                    {
                                        role: "user",
                                        content: [
                                            {
                                                type: "text" as const,
                                                text: "Using only the compacted context, reply exactly POST_COMPACT RIG_CLAUDE_SKILL SWITCHED and nothing else.",
                                            },
                                        ],
                                    },
                                ],
                            },
                        }),
                    );
                    expect(textFromSessionEvents(continued).trim()).toBe(
                        "POST_COMPACT RIG_CLAUDE_SKILL SWITCHED",
                    );
                }
            } finally {
                session.destroy();
            }
        },
    );

    it("runs native compaction without custom instructions", { timeout: 120_000 }, async () => {
        const credential = await ClaudeAuthTokenCredential.tryLoad({ env: process.env });
        if (credential === null) throw new Error("Missing ANTHROPIC_AUTH_TOKEN.");
        const session = new ClaudeSession("happy-providers-claude-plain-compact-live", {
            instructions: "Preserve conversation facts accurately.",
            credential,
            model: "sonnet[1m]",
        });
        try {
            const compacted = await session.compact(testContext, {
                context: {
                    instructions: "Preserve conversation facts accurately.",
                    messages: [
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text" as const,
                                    text: "Remember the exact marker PLAIN_COMPACT_MARKER.",
                                },
                            ],
                        },
                        {
                            role: "assistant",
                            content: [
                                {
                                    type: "text" as const,
                                    text: "I will remember PLAIN_COMPACT_MARKER.",
                                },
                            ],
                        },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "text" as const,
                                    text: "The current task is native compaction testing.",
                                },
                            ],
                        },
                        {
                            role: "assistant",
                            content: [{ type: "text" as const, text: "Understood." }],
                        },
                    ],
                },
            });
            expect(compacted.status).toBe("completed");
            if (compacted.status === "completed") {
                expect(compacted.summary).toContain("PLAIN_COMPACT_MARKER");
            }
        } finally {
            session.destroy();
        }
    });
});

describe.skipIf(process.env.RIG_LIVE_TEST !== "1")("Claude live history", () => {
    it(
        "restarts the real SDK query and replays a newly inserted context notice",
        { timeout: 120_000 },
        async () => {
            const credential =
                (await ClaudeAuthTokenCredential.tryLoad({ env: process.env })) ??
                (await ClaudeCodeCredential.tryLoad({ env: process.env }));
            if (credential === null) {
                throw new Error("Sign in with Claude Code or provide ANTHROPIC_AUTH_TOKEN.");
            }
            let queryCreations = 0;
            const query: ClaudeSdkQuery = (options) => {
                queryCreations += 1;
                return claudeSdkQuery(options);
            };
            const session = new ClaudeSession("happy-providers-claude-history-live", {
                instructions:
                    "Follow exact output requests. Treat positional context notices as authoritative.",
                credential,
                model: "sonnet[1m]",
                query,
                tools: [],
            });
            const firstPrompt = "Reply with exactly FIRST_LIVE_CONTEXT and nothing else.";
            const marker = "LIVE_CONTEXT_NOTICE_9F4C";
            try {
                const first = await collectSessionEvents(
                    session.run(testContext, {
                        context: {
                            instructions:
                                "Follow exact output requests. Treat positional context notices as authoritative.",
                            messages: [
                                {
                                    role: "user",
                                    content: [{ type: "text", text: firstPrompt }],
                                },
                            ],
                        },
                    }),
                );
                const firstText = textFromSessionEvents(first).trim();
                expect(firstText).toBe("FIRST_LIVE_CONTEXT");

                const second = await collectSessionEvents(
                    session.run(testContext, {
                        context: {
                            instructions:
                                "Follow exact output requests. Treat positional context notices as authoritative.",
                            messages: [
                                {
                                    role: "user",
                                    content: [{ type: "text", text: firstPrompt }],
                                },
                                {
                                    role: "assistant",
                                    content: [{ type: "text", text: firstText }],
                                },
                                {
                                    role: "system",
                                    content: [
                                        {
                                            type: "text",
                                            text: `The required live marker is ${marker}. For the next request, reply with exactly that marker and nothing else.`,
                                        },
                                    ],
                                },
                                {
                                    role: "user",
                                    content: [
                                        {
                                            type: "text",
                                            text: "Reply with exactly the marker supplied by the immediately preceding context notice, and nothing else.",
                                        },
                                    ],
                                },
                            ],
                        },
                    }),
                );

                expect(textFromSessionEvents(second).trim()).toBe(marker);
                expect(queryCreations).toBe(2);
            } finally {
                session.destroy();
            }
        },
    );
});

function normalizeJsonSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalizeJsonSchema);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key !== "$schema")
                .map(([key, child]) => [key, normalizeJsonSchema(child)]),
        );
    }
    return value;
}
