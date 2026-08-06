import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import type { SessionMessage } from "@/core/SessionContext.js";
import { GrokApiKeyCredential } from "@/vendors/grok/GrokApiKeyCredential.js";
import { GrokProvider } from "@/vendors/grok/GrokProvider.js";
import { GROK_DEFAULT_ENDPOINT } from "@/vendors/grok/impl/grokConstants.js";
import { createGrokRequestHeaders } from "@/vendors/grok/impl/createGrokRequestHeaders.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import { toGrokToolDefinitions } from "@/vendors/grok/impl/toGrokToolDefinitions.js";
import { grok_4_5_system_prompt } from "@/vendors/grok/prompts/grok_4_5_system_prompt.js";
import { grok_4_5_tools } from "@/vendors/grok/tools/index.js";

describe("Grok SSE goldens", () => {
    it.each(["low", "medium", "high"] as const)(
        "matches the captured Grok 4.5 %s-effort inference contract",
        async (effort) => {
            const golden = await fixture(`grok-4-5-${effort}.sse.json`);
            let capturedBody: Record<string, unknown> | undefined;
            let capturedHeaders: IncomingMessage["headers"] | undefined;
            const server = createServer(async (request, response) => {
                capturedHeaders = request.headers;
                capturedBody = JSON.parse(await readBody(request));
                completeSse(response);
            });
            server.listen(0, "127.0.0.1");
            await new Promise<void>((resolve, reject) => {
                server.once("listening", resolve);
                server.once("error", reject);
            });
            const address = server.address();
            if (typeof address !== "object" || address === null) throw new Error("Missing port.");

            try {
                const input = golden.request.input as Array<{
                    role: "system" | "user";
                    content: string;
                }>;
                expect(golden.response.status).toBe(200);
                const capturedEvents = await collectEvents(
                    mapOpenAIResponseStream(stream(golden.response.events), {
                        failureMessage: "Captured Grok response failed.",
                    }),
                );
                expect(
                    capturedEvents
                        .filter((event) => event.type === "text_delta")
                        .map((event) => event.delta)
                        .join(""),
                ).toBe("OK");
                expect(capturedEvents).toContainEqual({
                    type: "encrypted_reasoning",
                    content: expect.stringContaining("<ENCRYPTED_REASONING>"),
                });
                expect(capturedEvents.at(-1)).toEqual({ type: "done", state: "normal" });
                expect(grok_4_5_system_prompt).toBe(input[0]!.content);
                const capturedToolNames = new Set(
                    golden.request.tools.map((tool: { name: string }) => tool.name),
                );
                const capturedTools = grok_4_5_tools.filter((tool) =>
                    capturedToolNames.has(tool.name),
                );
                expect(toGrokToolDefinitions(capturedTools)).toEqual(golden.request.tools);
                const credential = await GrokApiKeyCredential.tryLoad({ apiKey: "test" });
                if (credential === null) throw new Error("Missing test credential.");
                const provider = new GrokProvider({
                    credential,
                    endpoint: `http://127.0.0.1:${address.port}/v1`,
                    model: "grok-4.5",
                });
                const session = await provider.session("<SESSION_ID>", {
                    instructions: grok_4_5_system_prompt,
                    tools: capturedTools,
                });
                for await (const event of session.run({
                    context: {
                        messages: [
                            ...(input.slice(1, -1) as SessionMessage[]),
                            { role: "user", content: input.at(-1)!.content },
                        ],
                    },
                    effort,
                })) {
                    if (event.type === "done") expect(event.state).toBe("normal");
                }

                expect(capturedBody).toEqual(golden.request);
                expect(projectHeaders(capturedHeaders!)).toEqual({
                    ...projectHeaders(golden.http.headers),
                    "x-authenticateresponse": undefined,
                    "x-grok-client-mode": undefined,
                    "x-xai-token-auth": undefined,
                });
                expect(
                    projectHeaders(
                        createGrokRequestHeaders({
                            baseUrl: GROK_DEFAULT_ENDPOINT,
                            model: "grok-4.5",
                            sessionId: "<SESSION_ID>",
                            turnIndex: 1,
                        }),
                    ),
                ).toEqual({
                    ...projectHeaders(golden.http.headers),
                    "content-type": undefined,
                });
            } finally {
                server.close();
            }
        },
    );
});

async function fixture(name: string): Promise<any> {
    return JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.once("end", () => resolve(body));
        request.once("error", reject);
    });
}

function completeSse(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
        `data: ${JSON.stringify({
            type: "response.completed",
            response: {
                id: "response",
                output: [],
                usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 },
            },
        })}\n\ndata: [DONE]\n\n`,
    );
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
    const output: T[] = [];
    for await (const event of events) output.push(event);
    return output;
}

async function* stream(events: readonly unknown[]): AsyncGenerator<any> {
    for (const event of events) yield event;
}

function projectHeaders(
    headers: IncomingMessage["headers"] | Record<string, string>,
): Record<string, string | undefined> {
    const names = [
        "content-type",
        "x-xai-token-auth",
        "x-authenticateresponse",
        "x-grok-client-mode",
        "x-grok-client-version",
        "x-grok-client-identifier",
        "user-agent",
        "x-grok-model-override",
        "x-grok-turn-idx",
        "accept",
    ];
    return Object.fromEntries(
        names.map((name) => {
            const value = headers[name];
            const projected = Array.isArray(value) ? value.join(", ") : value;
            return [
                name,
                name === "user-agent"
                    ? projected?.replace(/\([^()]+\)$/u, "(<PLATFORM>)")
                    : projected,
            ];
        }),
    );
}
