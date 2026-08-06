import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { CodexProvider } from "@/vendors/codex/CodexProvider.js";
import type { CodexSession } from "@/vendors/codex/CodexSession.js";
import type { SessionTool } from "@/core/SessionTool.js";
import { mapOpenAIResponseStream } from "@/protocol/responses/mapOpenAIResponseStream.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import { codex_hosted_tools, web_search } from "@/vendors/codex/tools/index.js";
import { toCodexToolDefinitions } from "@/vendors/codex/impl/toCodexToolDefinitions.js";

/**
 * OpenAI runs `web_search` on its own backend inside a single response, the way the Codex CLI does.
 * Rig declares it and reads the result back; it never executes or answers one.
 */
describe("Codex hosted search", () => {
    // Exactly the definition in the captured `gpt-5.5` CLI requests, which are the only recorded
    // ones that declare a search at all. `external_web_access: false` is what the CLI sent — it
    // prefers OpenAI's index to reaching the open web — so Rig sends what the reference sent
    // rather than quietly asking for more of the web.
    it("declares web search the way the captured CLI request does", () => {
        expect(toCodexToolDefinitions(codex_hosted_tools)).toEqual([
            {
                type: "web_search",
                external_web_access: false,
                search_content_types: ["text", "image"],
            },
        ]);
        expect(web_search.type).toBe("cloud");
    });

    it("reports a hosted search as provider-executed rather than a call Rig must answer", async () => {
        const { events, result } = await replay(
            [
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "web_search_call",
                        id: "ws_1",
                        action: { type: "search", query: "Node.js current stable version" },
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            new Set(["web_search"]),
        );

        expect(
            events.flatMap((event) => (event.type === "server_toolcall_end" ? [event.name] : [])),
        ).toEqual(["web_search"]);
        // Nothing was asked of the client, so the turn is a finished answer rather than a loop.
        expect(result.toolCalls).toEqual([]);
        expect(result.stopReason).toBe("stop");
    });

    // Everything above this line reads a response. None of it can tell whether the hosted tool ever
    // reached a request, which is the half that was silently broken: the provider accepted the
    // callback and dropped it on the way to the session, so Rig declared no search at all and the
    // mapper was simply never given the chance to be wrong. This asserts on the bytes on the wire.
    it("puts the hosted search into the request the provider actually sends", async () => {
        const declared = await declaredTools({ hostedTools: () => codex_hosted_tools });

        expect(declared).toContainEqual({
            type: "web_search",
            external_web_access: false,
            search_content_types: ["text", "image"],
        });
    });

    // The same provider without the grant sends no search, so the tool follows the permission
    // answer rather than the provider being Codex.
    it("sends no search when nothing granted one", async () => {
        const declared = await declaredTools({});

        expect(declared.some((tool) => tool.type === "web_search")).toBe(false);
    });

    // Compaction summarizes context that already exists, so there is nothing for it to search. It
    // never adds hosted tools, but it was also forwarding whatever tools it was handed — so a
    // configured one would have ridden along. It drops them instead, which is also what keeps a
    // compaction sample that calls a tool counting as a tool call rather than as provider work.
    it("declares no hosted search while compacting, even when handed one", async () => {
        const declared = await declaredTools({}, async (session) => {
            await session.compact().catch(() => {
                // The stub server does not return a real compaction item; the request it was sent
                // is the whole subject here.
            });
        });

        expect(declared.some((tool) => tool.type === "web_search")).toBe(false);
    });

    // A request that did not declare hosted search cannot receive one. Compaction sends none, so
    // this is also what keeps a compaction sample that calls a tool counting as a tool call.
    it("treats the same item as client work when nothing hosted was declared", async () => {
        const { events } = await replay(
            [
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "custom_tool_call",
                        call_id: "call-1",
                        name: "web_search",
                        input: '{"query":"anything"}',
                    },
                },
                {
                    type: "response.completed",
                    response: { output: [], usage: { total_tokens: 1 } },
                },
            ],
            new Set(),
        );

        expect(events.some((event) => event.type.startsWith("server_tool_call"))).toBe(false);
    });
});

async function replay(events: readonly unknown[], hostedToolNames: ReadonlySet<string>) {
    const mapped = mapOpenAIResponseStream(stream(events), {
        failureMessage: "unused",
        hostedToolNames,
        vendor: "codex",
    });
    const collected: SessionEvent[] = [];
    let next = await mapped.next();
    while (next.done !== true) {
        collected.push(next.value);
        next = await mapped.next();
    }
    return { events: collected, result: next.value };
}

async function* stream(events: readonly unknown[]) {
    for (const event of events) yield event as never;
}

/**
 * Runs one real turn against a local server and returns every tool Rig declared to OpenAI.
 *
 * Which request carries them depends on the model: the classic shape sends a `tools` array, while
 * the lite shape these models use sends them ahead of the turn as `additional_tools`. Both are Rig
 * telling OpenAI what it may run, so both count, and the test does not have to know which is which.
 */
async function declaredTools(
    options: { hostedTools?: () => readonly SessionTool[] },
    exercise?: (session: CodexSession) => Promise<void>,
): Promise<readonly { type?: string }[]> {
    const bodies: Record<string, any>[] = [];
    const server = createServer(async (request, response) => {
        bodies.push(JSON.parse(await readBody(request)));
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
        const provider = new CodexProvider({
            credential: { name: "codex-api-key", credential: { apiKey: "test" } } as never,
            endpoint: `http://127.0.0.1:${address.port}/v1`,
            transport: "sse",
            ...options,
        });
        const session = await provider.session("session-1", {
            instructions: "Be brief.",
            // Configured directly rather than granted, which is the path that was forwarding a
            // hosted tool into places it does not belong.
            ...(exercise === undefined ? {} : { tools: codex_hosted_tools }),
        });
        for await (const _event of session.run({
            context: { messages: [{ role: "user", content: "Reply with OK." }] },
            effort: "low",
            model: "gpt-5.6-sol",
        })) {
            // Drain the response.
        }
        if (exercise !== undefined) {
            // A configured tool belongs in the turn above; what follows is the subject.
            bodies.length = 0;
            await exercise(session);
        }
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    if (bodies.length === 0) throw new Error("The provider sent no request.");
    return bodies.flatMap((body) => [
        ...((body.tools as readonly { type?: string }[] | undefined) ?? []),
        ...((body.input as readonly Record<string, any>[] | undefined) ?? []).flatMap(
            (item): readonly { type?: string }[] =>
                item.type === "additional_tools" ? (item.tools ?? []) : [],
        ),
    ]);
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
            body += chunk;
        });
        request.once("end", () => {
            resolve(body);
        });
        request.once("error", reject);
    });
}

function completeSse(response: ServerResponse): void {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
        [
            `event: response.completed`,
            `data: ${JSON.stringify({
                type: "response.completed",
                response: { output: [], usage: { total_tokens: 1 } },
            })}`,
            "",
            "",
        ].join("\n"),
    );
}
