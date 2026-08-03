import type { SessionContext } from "@/core/SessionContext.js";
import type { SessionEvent } from "@/core/SessionEvent.js";
import type { SessionRunRequest } from "@/core/SessionRunRequest.js";
import type { SessionTool } from "@/core/SessionTool.js";
import {
    mapOpenAIResponseStream,
    type OpenAIResponseRunResult,
} from "@/protocol/responses/mapOpenAIResponseStream.js";
import { createGrokOpenAIRequest } from "@/vendors/grok/impl/createGrokOpenAIRequest.js";
import { createGrokRequestHeaders } from "@/vendors/grok/impl/createGrokRequestHeaders.js";
import {
    createGrokOpenAIClient,
    type GrokOpenAIClient,
} from "@/vendors/grok/impl/createGrokOpenAIClient.js";

/**
 * One Grok request, and the pooled connection that carries it.
 *
 * Grok keeps a warm HTTP/2 dispatcher, so the client outlives any single request and is rebuilt
 * only when something invalidates it: a rotated token, or a transport failure that wants a
 * retry over HTTP/1. Because the token is captured when the client is built, the token that
 * built it is remembered here too — that comparison is the only thing that decides whether the
 * warm connection is still the right one.
 */
export class GrokConnection {
    private client: GrokOpenAIClient | undefined;
    private clientToken: string | undefined;

    constructor(
        private readonly options: {
            baseUrl: string;
            hostedTools?: readonly SessionTool[];
            sessionId: string;
            token: () => string;
            tools: readonly SessionTool[];
            userAgent?: string;
        },
    ) {}

    async stream(options: {
        abort?: AbortSignal;
        compaction?: boolean;
        context: SessionContext;
        effort?: SessionRunRequest["effort"];
        model: string;
        structuredOutput?: SessionRunRequest["structuredOutput"];
        tools?: readonly SessionTool[];
        turnIndex?: number;
    }): Promise<AsyncGenerator<SessionEvent, OpenAIResponseRunResult>> {
        const { abort } = options;
        const client = await this.resolve();
        const clientTools = options.tools ?? this.options.tools;
        // Compaction summarizes context that already exists, so it has nothing to search for.
        // Sending no hosted tools also means nothing in its response can be read as hosted, so a
        // compaction sample that calls a tool still counts as one and is resampled.
        const hostedTools = options.compaction === true ? [] : (this.options.hostedTools ?? []);
        const tools = [...clientTools, ...hostedTools];
        const responseStream = await client.responses.create(
            createGrokOpenAIRequest({
                apiModelId: options.model,
                context: options.context,
                ...(options.effort === undefined ? {} : { effort: options.effort }),
                ...(options.structuredOutput === undefined
                    ? {}
                    : { structuredOutput: options.structuredOutput }),
                tools,
                ...(options.compaction === undefined ? {} : { compaction: options.compaction }),
            }),
            {
                headers: createGrokRequestHeaders({
                    baseUrl: this.options.baseUrl,
                    model: options.model,
                    sessionId: this.options.sessionId,
                    ...(this.options.userAgent === undefined
                        ? {}
                        : { userAgent: this.options.userAgent }),
                    ...(options.turnIndex === undefined ? {} : { turnIndex: options.turnIndex }),
                }),
                ...(abort === undefined ? {} : { signal: abort }),
            },
        );
        return mapOpenAIResponseStream(responseStream, {
            ...(abort === undefined ? {} : { signal: abort }),
            failureMessage: `${options.model} failed to generate a response.`,
            requireTerminalEvent: true,
            vendor: "grok",
            clientToolNames: new Set(clientTools.map((tool) => tool.name)),
            hostedToolNames: new Set(hostedTools.map((tool) => tool.name)),
        });
    }

    /** Replaces the connection, optionally dropping to HTTP/1 for a retry. */
    async rebuild(forceHttp1: boolean): Promise<void> {
        await this.client?.close();
        this.clientToken = this.options.token();
        this.client = createGrokOpenAIClient({
            baseUrl: this.options.baseUrl,
            token: this.clientToken,
            forceHttp1,
        });
    }

    close(): void {
        void this.client?.close();
        this.client = undefined;
        this.clientToken = undefined;
    }

    private async resolve(): Promise<GrokOpenAIClient> {
        const token = this.options.token();
        if (this.client !== undefined && this.clientToken === token) return this.client;
        // A rotated token invalidates the client that captured the previous one.
        if (this.client !== undefined) await this.client.close();
        this.clientToken = token;
        this.client = createGrokOpenAIClient({ baseUrl: this.options.baseUrl, token });
        return this.client;
    }
}
