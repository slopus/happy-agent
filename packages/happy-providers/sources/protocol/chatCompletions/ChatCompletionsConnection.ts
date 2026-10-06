import OpenAI, { APIError } from "openai";
import type { Stream } from "openai/core/streaming";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { BedrockCredential } from "@/vendors/VendorCredential.js";

const chunkSchema = Type.Object({
    choices: Type.Array(
        Type.Object({
            index: Type.Integer(),
            delta: Type.Object({
                content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
                reasoning_content: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
            finish_reason: Type.Union([Type.String(), Type.Null()]),
        }),
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

/** One reusable SDK client; each stream owns and releases its HTTP response. */
export class ChatCompletionsConnection {
    private readonly client: OpenAI;

    constructor(options: {
        credential: BedrockCredential;
        endpoint: string;
        region: string;
        userAgent: string;
        fetch?: typeof fetch;
    }) {
        const credential = options.credential;
        const underlyingFetch = options.fetch ?? globalThis.fetch;
        const signer =
            credential.name === "bedrock-aws"
                ? new SignatureV4({
                      credentials: async () => await credential.credential.provider(),
                      region: options.region,
                      service: "bedrock",
                      sha256: Hash.bind(null, "sha256"),
                  })
                : undefined;
        this.client = new BedrockChatClient({
            apiKey:
                credential.name === "bedrock-bearer-token"
                    ? credential.credential.bearerToken
                    : "bedrock-runtime-sigv4",
            baseURL: options.endpoint,
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
        const stream = await this.client.post<Stream<unknown>>("/chat/completions", {
            body,
            stream: true,
            ...(signal === undefined ? {} : { signal }),
        });
        try {
            for await (const chunk of stream) {
                if (!Value.Check(chunkSchema, chunk)) {
                    throw new Error("Bedrock returned an invalid chat response chunk.");
                }
                yield chunk;
            }
        } finally {
            stream.controller.abort();
        }
    }
}
