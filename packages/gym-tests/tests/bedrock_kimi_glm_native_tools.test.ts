import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
    createGym,
    type Gym,
    type HttpInterceptHandler,
    type HttpResponseReplacement,
} from "@slopus/happy-terminal-gym";

const callSchema = Type.Object({
    id: Type.String(),
    type: Type.Literal("function"),
    function: Type.Object({ name: Type.String(), arguments: Type.String() }),
});
const requestSchema = Type.Object({
    model: Type.String(),
    stream: Type.Literal(true),
    reasoning_effort: Type.String(),
    messages: Type.Array(
        Type.Object({
            role: Type.String(),
            content: Type.Optional(
                Type.Union([Type.String(), Type.Null(), Type.Array(Type.Unknown())]),
            ),
            reasoning_content: Type.Optional(Type.String()),
            tool_call_id: Type.Optional(Type.String()),
            tool_calls: Type.Optional(Type.Array(callSchema)),
        }),
    ),
    tools: Type.Optional(
        Type.Array(
            Type.Object({
                type: Type.Literal("function"),
                function: Type.Object({
                    name: Type.String(),
                    description: Type.Optional(Type.String()),
                    parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
                }),
            }),
        ),
    ),
});
type ChatRequest = Static<typeof requestSchema>;
type ToolCall = Static<typeof callSchema>;

const models = [
    {
        model: "moonshotai/kimi-k3",
        runtimeModel: "us.moonshotai.kimi-k3",
        effort: "high",
        name: "Kimi",
    },
    { model: "zai/glm-5.3", runtimeModel: "us.zai.glm-5.3", effort: "max", name: "GLM" },
] as const;

describe("Bedrock Runtime native Kimi and GLM tools", () => {
    it("runs Kimi Bash, Write, Read, and Edit once and preserves reasoning and tool identities on follow-up", async () => {
        const calls = [
            toolCall("kimi-bash", "Bash", {
                command: "printf 'KIMI_BASH_ONCE\\n' >> kimi-executions.txt",
            }),
            toolCall("kimi-write", "Write", {
                path: "/workspace/kimi-result.txt",
                content: "before\n",
            }),
            toolCall("kimi-read-before", "Read", { path: "/workspace/kimi-result.txt" }),
            toolCall("kimi-edit", "Edit", {
                path: "/workspace/kimi-result.txt",
                old_string: "before",
                new_string: "after",
            }),
            toolCall("kimi-read-after", "Read", { path: "/workspace/kimi-result.txt" }),
        ];
        const requests: ChatRequest[] = [];
        const gym = await startGym(
            models[0],
            intercept(requests, (index) =>
                index < calls.length
                    ? responseFor({ call: calls[index]!, reasoning: `Kimi step ${index + 1}.` })
                    : responseFor({
                          text:
                              index === calls.length
                                  ? "KIMI_NATIVE_TOOLS_COMPLETE"
                                  : "KIMI_FOLLOWUP_COMPLETE",
                      }),
            ),
        );
        try {
            gym.terminal.type(
                "Run the shell marker once, write kimi-result.txt, read it, change before to after, and read the result.",
            );
            gym.terminal.press("enter");
            await waitForCompletion(gym, "KIMI_NATIVE_TOOLS_COMPLETE");
            expect(requests).toHaveLength(6);
            assertNativeRequest(requests[0]!, models[0]);
            const names = requests[0]!.tools!.map((tool) => tool.function.name);
            expect(names).toEqual(
                expect.arrayContaining([
                    "Bash",
                    "Read",
                    "Write",
                    "Edit",
                    "Glob",
                    "Grep",
                    "ReadMediaFile",
                    "TaskInput",
                    "TaskOutput",
                    "TaskStop",
                ]),
            );
            for (const name of ["exec_command", "apply_patch", "write_stdin"])
                expect(names).not.toContain(name);
            const system = requests[0]!.messages.find((message) => message.role === "system");
            expect(system?.content).toContain(
                "an interactive general AI agent running on a user's computer",
            );
            expect(
                JSON.stringify(
                    requests[0]!.tools!.find((tool) => tool.function.name === "Write")?.function
                        .parameters,
                ),
            ).toContain('"path"');
            await expect(gym.readFile("kimi-result.txt")).resolves.toBe("after\n");
            await expect(gym.readFile("kimi-executions.txt")).resolves.toBe("KIMI_BASH_ONCE\n");
            expect(toolResult(requests[3]!, "kimi-read-before").content).toContain("before");
            expect(toolResult(requests[5]!, "kimi-read-after").content).toContain("after");
            const firstContinuation = requests[1]!.messages.find((message) =>
                message.tool_calls?.some((call) => call.id === "kimi-bash"),
            );
            expect(firstContinuation?.reasoning_content).toBe("Kimi step 1.");

            gym.terminal.type("Continue from the edited file without running the tools again.");
            gym.terminal.press("enter");
            await waitForCompletion(gym, "KIMI_FOLLOWUP_COMPLETE");
            expect(requests).toHaveLength(7);
            assertToolHistory(requests[6]!, calls);
            expect(requests[6]!.tools).toEqual(requests[0]!.tools);
            for (const [index, call] of calls.entries()) {
                const assistant = requests[6]!.messages.find((message) =>
                    message.tool_calls?.some((item) => item.id === call.id),
                );
                expect(assistant?.reasoning_content).toBe(`Kimi step ${index + 1}.`);
            }
            await expect(gym.readFile("kimi-executions.txt")).resolves.toBe("KIMI_BASH_ONCE\n");
            await expect(gym.readFile("kimi-result.txt")).resolves.toBe("after\n");
            expect(gym.inference.requests).toHaveLength(0);
        } finally {
            await gym.dispose();
        }
    }, 90_000);

    it("keeps Kimi background tasks alive for stdin, reads only new output, and stops them", async () => {
        const requests: ChatRequest[] = [];
        let taskId = "";
        const calls: ToolCall[] = [];
        const command = `node -e 'const fs = require("node:fs"); process.stdin.setEncoding("utf8"); process.stdin.on("data", value => { fs.appendFileSync("kimi-stdin.txt", value); process.stdout.write("KIMI_STDIN:" + value); }); console.log("KIMI_PROCESS_READY"); setInterval(() => {}, 1000);'`;
        const gym = await startGym(
            models[0],
            intercept(requests, (index) => {
                if (index === 0) {
                    const call = toolCall("kimi-background-start", "Bash", {
                        command,
                        run_in_background: true,
                    });
                    calls.push(call);
                    return responseFor({ call });
                }
                if (index === 1) {
                    const result = toolResult(requests[1]!, "kimi-background-start");
                    expect(result.content).toContain("KIMI_PROCESS_READY");
                    const match = String(result.content).match(
                        /Task ([1-9][0-9]*) keeps running in the background/u,
                    );
                    if (match?.[1] === undefined)
                        throw new Error("Bash did not expose its live shell task identifier.");
                    taskId = match[1];
                    const call = toolCall("kimi-background-input", "TaskInput", {
                        task_id: taskId,
                        input: "HELLO_FROM_KIMI\n",
                        timeout: 2000,
                    });
                    calls.push(call);
                    return responseFor({ call });
                }
                if (index === 2) {
                    expect(toolResult(requests[2]!, "kimi-background-input").content).toContain(
                        "KIMI_STDIN:HELLO_FROM_KIMI",
                    );
                    const call = toolCall("kimi-background-drain", "TaskOutput", {
                        task_id: taskId,
                    });
                    calls.push(call);
                    return responseFor({ call });
                }
                if (index === 3) {
                    const output = toolResult(requests[3]!, "kimi-background-drain");
                    expect(output.content).toContain("running");
                    expect(output.content).not.toContain("KIMI_PROCESS_READY");
                    expect(output.content).not.toContain("KIMI_STDIN:HELLO_FROM_KIMI");
                    const call = toolCall("kimi-background-stop", "TaskStop", { task_id: taskId });
                    calls.push(call);
                    return responseFor({ call });
                }
                if (index === 4) {
                    expect(toolResult(requests[4]!, "kimi-background-stop").content).toContain(
                        `Stopped shell task ${taskId}`,
                    );
                    const call = toolCall("kimi-background-exited", "TaskOutput", {
                        task_id: taskId,
                    });
                    calls.push(call);
                    return responseFor({ call });
                }
                expect(toolResult(requests[5]!, "kimi-background-exited").content).toMatch(
                    /completed|killed/u,
                );
                return responseFor({ text: "KIMI_BACKGROUND_COMPLETE" });
            }),
        );
        try {
            gym.terminal.type(
                "Start a background stdin echo process, send HELLO_FROM_KIMI, read only new output, stop it, and confirm it ended.",
            );
            gym.terminal.press("enter");
            await waitForCompletion(gym, "KIMI_BACKGROUND_COMPLETE");
            expect(requests).toHaveLength(6);
            expect(taskId.length).toBeGreaterThan(0);
            assertToolHistory(requests[5]!, calls);
            await expect(gym.readFile("kimi-stdin.txt")).resolves.toBe("HELLO_FROM_KIMI\n");
            expect(gym.inference.requests).toHaveLength(0);
        } finally {
            await gym.dispose();
        }
    }, 90_000);

    it("executes GLM's Claude-shaped Bash and Read and replays each call exactly once", async () => {
        const calls = [
            toolCall("glm-bash", "Bash", {
                command: "printf 'GLM_SHELL_RESULT\\n' >> glm-result.txt",
            }),
            toolCall("glm-read", "Read", { file_path: "/workspace/glm-result.txt" }),
        ];
        const requests: ChatRequest[] = [];
        const gym = await startGym(
            models[1],
            intercept(requests, (index) =>
                index < calls.length
                    ? responseFor({ call: calls[index]!, reasoning: `GLM step ${index + 1}.` })
                    : responseFor({
                          text:
                              index === calls.length
                                  ? "GLM_NATIVE_TOOLS_COMPLETE"
                                  : "GLM_FOLLOWUP_COMPLETE",
                      }),
            ),
        );
        try {
            gym.terminal.type(
                "Write the GLM shell marker once, then read glm-result.txt with the file tool.",
            );
            gym.terminal.press("enter");
            await waitForCompletion(gym, "GLM_NATIVE_TOOLS_COMPLETE");
            expect(requests).toHaveLength(3);
            assertNativeRequest(requests[0]!, models[1]);
            const names = requests[0]!.tools!.map((tool) => tool.function.name);
            expect(names).toEqual(
                expect.arrayContaining(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
            );
            expect(names).not.toContain("ReadMediaFile");
            const system = requests[0]!.messages.find((message) => message.role === "system");
            expect(system?.content).toContain(
                "an interactive agent that helps users with software engineering tasks.",
            );
            expect(system?.content).toContain("# Harness");
            expect(
                JSON.stringify(
                    requests[0]!.tools!.find((tool) => tool.function.name === "Read")?.function
                        .parameters,
                ),
            ).toContain('"file_path"');
            expect(toolResult(requests[2]!, "glm-read").content).toContain("1\tGLM_SHELL_RESULT");
            await expect(gym.readFile("glm-result.txt")).resolves.toBe("GLM_SHELL_RESULT\n");

            gym.terminal.type("Continue the same conversation without running the shell again.");
            gym.terminal.press("enter");
            await waitForCompletion(gym, "GLM_FOLLOWUP_COMPLETE");
            expect(requests).toHaveLength(4);
            assertToolHistory(requests[3]!, calls);
            expect(requests[3]!.tools).toEqual(requests[0]!.tools);
            await expect(gym.readFile("glm-result.txt")).resolves.toBe("GLM_SHELL_RESULT\n");
            expect(gym.inference.requests).toHaveLength(0);
        } finally {
            await gym.dispose();
        }
    }, 90_000);

    it("returns text for GLM image reads and keeps later inference usable", async () => {
        const imageCall = toolCall("glm-image", "Read", { file_path: "/workspace/tiny.png" });
        const requests: ChatRequest[] = [];
        const gym = await startGym(
            models[1],
            intercept(requests, (index) =>
                index === 0
                    ? responseFor({ call: imageCall })
                    : responseFor({
                          text:
                              index === 1
                                  ? "GLM_IMAGE_REFUSAL_COMPLETE"
                                  : "GLM_AFTER_IMAGE_COMPLETE",
                      }),
            ),
            {
                "tiny.png": Buffer.from(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD6kAAAAASUVORK5CYII=",
                    "base64",
                ),
            },
        );
        try {
            gym.terminal.type("Read tiny.png and tell me if this model can inspect it.");
            gym.terminal.press("enter");
            await waitForCompletion(gym, "GLM_IMAGE_REFUSAL_COMPLETE");
            expect(requests).toHaveLength(2);
            const refusal = toolResult(requests[1]!, "glm-image");
            expect(typeof refusal.content).toBe("string");
            expect(refusal.content).toMatch(
                /(?:does not support image|GLM.*(?:text|image)|image.*(?:not supported|cannot|does not support))/iu,
            );
            expect(JSON.stringify(requests[1]!.messages).includes("image_url")).toBe(false);
            expect(JSON.stringify(requests[1]!.messages).includes("data:image")).toBe(false);

            gym.terminal.type("Continue with a text-only answer.");
            gym.terminal.press("enter");
            await waitForCompletion(gym, "GLM_AFTER_IMAGE_COMPLETE");
            expect(requests).toHaveLength(3);
            assertToolHistory(requests[2]!, [imageCall]);
            expect(JSON.stringify(requests[2]!.messages).includes("image_url")).toBe(false);
            expect(gym.inference.requests).toHaveLength(0);
        } finally {
            await gym.dispose();
        }
    }, 90_000);

    it.each(models)(
        "keeps $name shell writes confined to the workspace despite explicit escalation",
        async (model) => {
            const outside = "/home/happy-terminal/outside-denied.txt";
            const deniedCall = toolCall("outside-write", "Bash", {
                command: `printf 'SHOULD_NOT_EXIST\\n' > ${outside}`,
                ...(model.name === "Kimi"
                    ? {
                          sandbox_permissions: "require_escalated",
                          justification: "Exercise the workspace-write permission boundary.",
                      }
                    : { dangerouslyDisableSandbox: true }),
            });
            const checkCall = toolCall("check-boundary", "Bash", {
                command: `if [ -e ${outside} ]; then printf 'OUTSIDE_WRITE_PRESENT\\n'; else printf 'OUTSIDE_WRITE_ABSENT\\n'; fi; printf 'SAFE_WORKSPACE_WRITE\\n' > safe-result.txt`,
            });
            const requests: ChatRequest[] = [];
            const gym = await startGym(
                model,
                intercept(requests, (index) =>
                    index < 2
                        ? responseFor({ call: index === 0 ? deniedCall : checkCall })
                        : responseFor({ text: "WORKSPACE_BOUNDARY_COMPLETE" }),
                ),
            );
            try {
                gym.terminal.type(
                    "Check the shell permission boundary, then write a safe workspace marker.",
                );
                gym.terminal.press("enter");
                await waitForCompletion(gym, "WORKSPACE_BOUNDARY_COMPLETE");
                expect(requests).toHaveLength(3);
                expect(toolResult(requests[1]!, "outside-write").content).toMatch(
                    /(?:denied|permission|not permitted|blocked|workspace)/iu,
                );
                expect(toolResult(requests[2]!, "check-boundary").content).toContain(
                    "OUTSIDE_WRITE_ABSENT",
                );
                await expect(gym.readFile("safe-result.txt")).resolves.toBe(
                    "SAFE_WORKSPACE_WRITE\n",
                );
                assertToolHistory(requests[2]!, [deniedCall, checkCall]);
            } finally {
                await gym.dispose();
            }
        },
        90_000,
    );

    describe.each(models)("$name Auto review", (model) => {
        it.each(["allow", "deny"] as const)(
            "enforces %s and restores the next command's sandbox",
            async (outcome) => {
                const elevatedCall = toolCall("auto-elevated", "Bash", {
                    command: "printf 'approved\\n' > .git/elevation-test.txt",
                    ...(model.name === "Kimi"
                        ? {
                              sandbox_permissions: "require_escalated",
                              justification:
                                  "Create the one explicitly authorized Git-control marker.",
                          }
                        : {
                              dangerouslyDisableSandbox: true,
                              description:
                                  "Create the one explicitly authorized Git-control marker.",
                          }),
                });
                const sandboxCall = toolCall("auto-restored", "Bash", {
                    command: "printf 'leaked\\n' > .git/unreviewed.txt",
                });
                const requests: ChatRequest[] = [];
                const reviews: string[] = [];
                const gym = await startGym(
                    model,
                    intercept(
                        requests,
                        (index) =>
                            index < 2
                                ? responseFor({ call: index === 0 ? elevatedCall : sandboxCall })
                                : responseFor({ text: "AUTO_BOUNDARY_COMPLETE" }),
                        { outcome, reviews },
                    ),
                    {},
                    "auto",
                );
                try {
                    gym.terminal.type(
                        "Create .git/elevation-test.txt containing approved. I authorize Full access for that one command only. Keep the next command sandboxed. AUTO_ELEVATION_USER_AUTH.",
                    );
                    gym.terminal.press("enter");
                    await waitForCompletion(gym, "AUTO_BOUNDARY_COMPLETE");
                    expect(requests).toHaveLength(3);
                    expect(reviews).toHaveLength(1);
                    expect(reviews[0]).toContain("unrestricted filesystem");
                    expect(reviews[0]).toContain("network access");
                    expect(reviews[0]).toContain(
                        "Create the one explicitly authorized Git-control marker.",
                    );
                    expect(reviews[0]).toContain("AUTO_ELEVATION_USER_AUTH");
                    expect(reviews[0]).toContain(
                        "I authorize Full access for that one command only.",
                    );
                    if (outcome === "allow") {
                        await expect(gym.readFile(".git/elevation-test.txt")).resolves.toBe(
                            "approved\n",
                        );
                    } else {
                        await expect(gym.readFile(".git/elevation-test.txt")).rejects.toThrow();
                        expect(toolResult(requests[1]!, "auto-elevated").content).toMatch(
                            /denied|permission/iu,
                        );
                    }
                    await expect(gym.readFile(".git/unreviewed.txt")).rejects.toThrow();
                    expect(toolResult(requests[2]!, "auto-restored").content).toMatch(
                        /denied|permission|not permitted/iu,
                    );
                    assertToolHistory(requests[2]!, [elevatedCall, sandboxCall]);
                    expect(gym.inference.requests).toHaveLength(0);
                } finally {
                    await gym.dispose();
                }
            },
            90_000,
        );
    });
});

async function startGym(
    model: (typeof models)[number],
    handler: HttpInterceptHandler,
    files: Readonly<Record<string, string | Uint8Array>> = {},
    permissionMode: "workspace_write" | "auto" = "workspace_write",
): Promise<Gym> {
    return await createGym({
        mode: "docker",
        providerId: "bedrock",
        modelId: model.model,
        permissionMode,
        rows: 50,
        files,
        environment: { AWS_BEARER_TOKEN_BEDROCK: "gym-placeholder-token" },
        homeFiles: {
            "happy/config/happy.toml": [
                "[providers]",
                "default_enable = false",
                "[providers.bedrock]",
                "enabled = true",
                'region = "us-east-1"',
                `include_models = ["${model.model}"]`,
                `[providers.bedrock.model_overrides."${model.model}"]`,
                'endpoint = "http://bedrock.gym.test/openai/v1"',
            ].join("\n"),
        },
        httpProxy: { handler },
    });
}

function intercept(
    requests: ChatRequest[],
    respond: (index: number) => HttpResponseReplacement,
    review?: { outcome: "allow" | "deny"; reviews: string[] },
): HttpInterceptHandler {
    return (request) => {
        if (
            request.method !== "POST" ||
            new URL(request.url).pathname !== "/openai/v1/chat/completions"
        ) {
            return {
                response: {
                    status: 404,
                    body: "Only scripted Bedrock Runtime inference is allowed.",
                },
            };
        }
        expect(request.headers.authorization).toBe("Bearer gym-placeholder-token");
        const text = Buffer.from(request.body).toString();
        if (text.includes("Create a concise session title")) {
            return { response: responseFor({ text: "Native Bedrock session" }) };
        }
        if (text.includes("You are judging one planned coding-agent action.")) {
            if (review === undefined)
                throw new Error("Unexpected Auto review for a workspace-write scenario.");
            review.reviews.push(text);
            return {
                response: responseFor({
                    text: `<review><outcome>${review.outcome}</outcome><risk_level>medium</risk_level><user_authorization>high</user_authorization><rationale>Scripted review of one explicitly authorized elevated command.</rationale></review>`,
                }),
            };
        }
        const body: unknown = JSON.parse(text);
        Value.Assert(requestSchema, body);
        requests.push(body);
        if (requests.length > 10)
            return { response: { status: 500, body: "Unexpected repeated inference." } };
        return { response: respond(requests.length - 1) };
    };
}

function assertNativeRequest(request: ChatRequest, model: (typeof models)[number]): void {
    expect(request.model).toBe(model.runtimeModel);
    expect(request.reasoning_effort).toBe(model.effort);
    expect(request).not.toHaveProperty("thinking");
    expect(request.tools?.length).toBeGreaterThan(0);
    expect(request.tools!.every((tool) => tool.type === "function")).toBe(true);
}

function toolResult(request: ChatRequest, id: string) {
    const result = request.messages.find(
        (message) => message.role === "tool" && message.tool_call_id === id,
    );
    if (result === undefined) throw new Error(`Missing result for tool call ${id}.`);
    return result;
}

function assertToolHistory(request: ChatRequest, expected: readonly ToolCall[]): void {
    const calls = request.messages.flatMap((message) => message.tool_calls ?? []);
    for (const call of expected) {
        expect(calls.filter((item) => item.id === call.id)).toEqual([call]);
        expect(
            request.messages.filter(
                (message) => message.role === "tool" && message.tool_call_id === call.id,
            ),
        ).toHaveLength(1);
        const assistantIndex = request.messages.findIndex((message) =>
            message.tool_calls?.some((item) => item.id === call.id),
        );
        const resultIndex = request.messages.findIndex(
            (message) => message.role === "tool" && message.tool_call_id === call.id,
        );
        expect(resultIndex).toBeGreaterThan(assistantIndex);
    }
}

async function waitForCompletion(gym: Gym, marker: string): Promise<void> {
    const screen = await gym.terminal.waitUntil(
        (snapshot) => snapshot.text.includes(marker) && !snapshot.text.includes("esc to interrupt"),
        marker,
        30_000,
    );
    expect(screen.text).not.toContain("without a matching start");
    expect(screen.text).not.toContain("Authentication with Amazon Bedrock failed");
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
    return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function responseFor(options: {
    call?: ToolCall;
    text?: string;
    reasoning?: string;
}): HttpResponseReplacement {
    const chunks: object[] = [];
    if (options.reasoning !== undefined)
        chunks.push(chunk({ reasoning_content: options.reasoning }));
    if (options.call !== undefined)
        chunks.push(chunk({ tool_calls: [{ index: 0, ...options.call }] }));
    if (options.text !== undefined) chunks.push(chunk({ content: options.text }));
    chunks.push(chunk({}, options.call === undefined ? "stop" : "tool_calls"), {
        choices: [],
        usage: {
            prompt_tokens: 200,
            completion_tokens: 50,
            prompt_tokens_details: { cached_tokens: 100 },
        },
    });
    return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body:
            chunks.map((item) => `data: ${JSON.stringify(item)}\n\n`).join("") + "data: [DONE]\n\n",
    };
}

function chunk(delta: object, finish_reason: string | null = null): object {
    return { choices: [{ index: 0, delta, finish_reason }] };
}
