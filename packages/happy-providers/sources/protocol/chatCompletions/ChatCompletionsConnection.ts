import OpenAI, { APIError } from "openai";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { BedrockCredential } from "@/vendors/VendorCredential.js";
import {
    bedrockEndpointOptions,
    bedrockSigningQuery,
} from "@/vendors/bedrock/impl/bedrockEndpointOptions.js";
import { readServerSentEvents } from "./readServerSentEvents.js";

/** Gateways may omit `choices` on a usage-only chunk and `delta` or `finish_reason` on a choice. */
const chunkSchema = Type.Object({
    choices: Type.Optional(
        Type.Array(
            Type.Object({
                index: Type.Integer(),
                delta: Type.Optional(
                    Type.Object({
                        content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        reasoning_content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        /** OpenRouter and several gateways stream reasoning under this name. */
                        reasoning: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                        tool_calls: Type.Optional(
                            Type.Array(
                                Type.Object({
                                    index: Type.Integer(),
                                    id: Type.Optional(Type.String()),
                                    function: Type.Optional(
                                        Type.Object({
                                            name: Type.Optional(Type.String()),
                                            arguments: Type.Optional(Type.String()),
                                        }),
                                    ),
                                }),
                            ),
                        ),
                    }),
                ),
                finish_reason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            }),
        ),
    ),
    usage: Type.Optional(
        Type.Union([
            Type.Null(),
            Type.Object({
                prompt_tokens: Type.Integer({ minimum: 0 }),
                completion_tokens: Type.Integer({ minimum: 0 }),
                prompt_tokens_details: Type.Optional(
                    Type.Object({
                        cached_tokens: Type.Optional(Type.Integer({ minimum: 0 })),
                    }),
                ),
            }),
        ]),
    ),
});

export type ChatCompletionsChunk = Static<typeof chunkSchema>;

/** An error reported inside an open stream, which the OpenAI SDK raises as an `APIError`. */
const streamErrorSchema = Type.Object({
    error: Type.Union([Type.Object({}), Type.String({ minLength: 1 })]),
});

class BedrockChatClient extends OpenAI {
    protected override makeStatusError(
        status: number,
        body: object,
        message: string | undefined,
        headers: Headers,
    ): APIError {
        const awsErrorSchema = Type.Object({
            message: Type.String(),
            error: Type.Optional(Type.Never()),
        });
        return super.makeStatusError(
            status,
            Value.Check(awsErrorSchema, body) ? { error: body } : body,
            message,
            headers,
        );
    }
}

/** A Bedrock Runtime or Mantle route, signed with SigV4 or sent with a Bedrock bearer token. */
export interface BedrockChatCompletionsConnectionOptions {
    credential: BedrockCredential;
    endpoint: string;
    region: string;
    /** The SigV4 service: `bedrock` for Runtime, `bedrock-mantle` for Mantle. */
    service: "bedrock" | "bedrock-mantle";
    userAgent: string;
    fetch?: typeof fetch;
}

/** Any other OpenAI-compatible endpoint, authenticated with a plain bearer API key. */
export interface ApiKeyChatCompletionsConnectionOptions {
    apiKey: string;
    endpoint: string;
    /** Extra headers sent with every request, such as a gateway's attribution headers. */
    headers?: Readonly<Record<string, string>>;
    /** Replaces the SDK's own user agent only when set. */
    userAgent?: string;
    /** How the vendor is named in error text. */
    vendor: string;
    fetch?: typeof fetch;
}

export type ChatCompletionsConnectionOptions =
    | BedrockChatCompletionsConnectionOptions
    | ApiKeyChatCompletionsConnectionOptions;

/** One reusable SDK client; each stream owns and releases its HTTP response. */
export class ChatCompletionsConnection {
    private readonly client: OpenAI;
    private readonly vendor: string;

    constructor(options: ChatCompletionsConnectionOptions) {
        if ("apiKey" in options) {
            this.vendor = options.vendor;
            this.client = new OpenAI({
                apiKey: options.apiKey,
                baseURL: options.endpoint,
                defaultHeaders: {
                    ...options.headers,
                    ...(options.userAgent === undefined ? {} : { "user-agent": options.userAgent }),
                },
                maxRetries: 0,
                ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            });
            return;
        }
        this.vendor = "Bedrock";
        const credential = options.credential;
        const underlyingFetch = options.fetch ?? globalThis.fetch;
        const signer =
            credential.name === "bedrock-aws"
                ? new SignatureV4({
                      credentials: async () => await credential.credential.provider(),
                      region: options.region,
                      service: options.service,
                      sha256: Hash.bind(null, "sha256"),
                  })
                : undefined;
        this.client = new BedrockChatClient({
            apiKey:
                credential.name === "bedrock-bearer-token"
                    ? credential.credential.bearerToken
                    : "bedrock-runtime-sigv4",
            ...bedrockEndpointOptions(options.endpoint),
            defaultHeaders: { "user-agent": options.userAgent },
            maxRetries: 0,
            fetch:
                signer === undefined
                    ? underlyingFetch
                    : async (input, init) => {
                          const url = new URL(input instanceof Request ? input.url : input);
                          const headers = new Headers(init?.headers);
                          headers.delete("authorization");
                          headers.set("host", url.host);
                          if (typeof init?.body !== "string") {
                              throw new Error(
                                  "Bedrock chat requests require a replayable JSON body.",
                              );
                          }
                          const signed = await signer.sign({
                              method: init.method ?? "POST",
                              protocol: url.protocol,
                              hostname: url.hostname,
                              ...(url.port ? { port: Number(url.port) } : {}),
                              path: url.pathname,
                              query: bedrockSigningQuery(url),
                              headers: Object.fromEntries(headers),
                              body: init.body,
                          });
                          return await underlyingFetch(url, {
                              ...init,
                              headers: signed.headers,
                              redirect: "manual",
                          });
                      },
        });
    }

    async *run(body: object, signal?: AbortSignal): AsyncGenerator<ChatCompletionsChunk> {
        // The SDK still builds, authenticates, and rejects the request; the body is decoded here.
        const response = await this.client
            .post("/chat/completions", {
                body,
                stream: true,
                ...(signal === undefined ? {} : { signal }),
            })
            .asResponse();
        if (response.body === null) {
            throw new Error(`${this.vendor} returned a chat response without a body.`);
        }
        for await (const event of readServerSentEvents(response.body)) {
            if (event.data.startsWith("[DONE]")) return;
            let chunk: unknown;
            try {
                chunk = JSON.parse(event.data);
            } catch {
                throw new Error(`${this.vendor} returned an invalid chat response chunk.`);
            }
            if (Value.Check(streamErrorSchema, chunk)) {
                throw new APIError(undefined, chunk.error, undefined, response.headers);
            }
            if (!Value.Check(chunkSchema, chunk)) {
                throw new Error(`${this.vendor} returned an invalid chat response chunk.`);
            }
            yield chunk;
        }
    }
}
