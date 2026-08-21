import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

import type { GymInferenceRequest } from "./inferenceTypes.js";
import type { GymInferenceHandler, GymMockResponse } from "./types.js";

export class MockInferenceServer {
    /**
     * Failures thrown by the inference handler, which is where a test puts its assertions about
     * what the agent sent. The agent only ever sees an HTTP error, so without these the assertion
     * would surface as whatever the test was waiting for simply never arriving.
     */
    readonly handlerFailures: Error[] = [];
    readonly requests: GymInferenceRequest[] = [];
    readonly token = randomBytes(24).toString("hex");

    #agentCallIndex = 0;
    #handler: GymInferenceHandler;
    #pathReplacements: readonly [string, string][];
    #server: Server | undefined;
    #timeScale: number;
    #url: string | undefined;

    constructor(
        inference: readonly GymMockResponse[] | GymInferenceHandler,
        pathReplacements: readonly [string, string][] = [],
    ) {
        this.#pathReplacements = pathReplacements;
        this.#timeScale = readTimeScale();
        if (typeof inference === "function") {
            this.#handler = inference;
        } else {
            const responses = [...inference];
            this.#handler = (_request, callIndex) => {
                const response = responses[callIndex];
                if (response === undefined) {
                    return {
                        body: `No scripted inference response exists for agent call ${callIndex + 1}.`,
                        httpStatus: 500,
                    };
                }
                return response;
            };
        }
    }

    get url(): string {
        if (this.#url === undefined) throw new Error("Mock inference server has not started.");
        return this.#url;
    }

    get localUrl(): string {
        if (this.#url === undefined) throw new Error("Mock inference server has not started.");
        return this.#url.replace("host.docker.internal", "127.0.0.1");
    }

    async start(): Promise<void> {
        if (this.#server !== undefined) return;
        const server = createServer((request, response) => {
            void this.#respond(request, response);
        });
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "0.0.0.0", () => {
                server.off("error", reject);
                resolve();
            });
        });
        const address = server.address();
        if (address === null || typeof address === "string") {
            server.close();
            throw new Error("Mock inference server did not receive a TCP port.");
        }
        this.#server = server;
        this.#url = `http://host.docker.internal:${address.port}/inference`;
    }

    async stop(): Promise<void> {
        const server = this.#server;
        this.#server = undefined;
        this.#url = undefined;
        if (server === undefined) return;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
    }

    async #respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            if (request.method !== "POST" || request.url !== "/inference") {
                send(response, 404, "Unknown gym inference route.");
                return;
            }
            if (request.headers.authorization !== `Bearer ${this.token}`) {
                send(response, 401, "Invalid gym inference token.");
                return;
            }
            const payload = JSON.parse(await readBody(request)) as GymInferenceRequest;
            this.requests.push(payload);
            const isTitle = payload.options.sessionId?.endsWith(":title") === true;
            const reply = isTitle
                ? {
                      content: [
                          {
                              type: "text" as const,
                              text: [
                                  "<title>Gym session</title>",
                                  "<recap>The user worked with Happy Agent in the Gym environment.</recap>",
                              ].join("\n"),
                          },
                      ],
                      stopReason: "stop" as const,
                  }
                : await this.#handler(payload, this.#agentCallIndex++);
            if ("disconnect" in reply) {
                response.destroy();
                return;
            }
            if ("httpStatus" in reply) {
                send(response, reply.httpStatus, reply.body ?? "Mock inference failure.");
                return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify(
                    scaleMockTime(this.#replaceVirtualToolPaths(reply), this.#timeScale),
                ),
            );
        } catch (error) {
            if (this.handlerFailures.length === 0) {
                this.handlerFailures.push(
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
            send(response, 500, error instanceof Error ? error.message : String(error));
        }
    }

    #replaceVirtualToolPaths(reply: GymMockResponse): GymMockResponse {
        if (!("content" in reply)) return reply;
        return {
            ...reply,
            content: reply.content.map((block) => {
                if (!("arguments" in block) || block.arguments === undefined) return block;
                return {
                    ...block,
                    arguments: replacePaths(block.arguments, this.#pathReplacements) as Record<
                        string,
                        unknown
                    >,
                };
            }),
        };
    }
}

function readTimeScale(): number {
    const value = Number(process.env.HAPPY_TERMINAL_GYM_TIME_SCALE ?? "1");
    return Number.isFinite(value) && value > 0 ? value : 1;
}

function scaleMockTime(value: unknown, scale: number, key?: string): unknown {
    if (key === "arguments") return value;
    if (
        typeof value === "number" &&
        (key === "completionDelayMs" || key?.endsWith("DeltaDelayMs") === true)
    ) {
        return value <= 0 ? value : Math.max(1, Math.round(value * scale));
    }
    if (Array.isArray(value)) return value.map((item) => scaleMockTime(item, scale));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, scaleMockTime(item, scale, name)]),
    );
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > 16 * 1024 * 1024) throw new Error("Gym inference request is too large.");
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: string): void {
    response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    response.end(body);
}

function replacePaths(value: unknown, replacements: readonly [string, string][]): unknown {
    if (typeof value === "string") {
        return replacements.reduce(
            (replaced, [virtualPath, realPath]) => replaced.replaceAll(virtualPath, realPath),
            value,
        );
    }
    if (Array.isArray(value)) return value.map((item) => replacePaths(item, replacements));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value).map(([name, item]) => [name, replacePaths(item, replacements)]),
    );
}
