import { Type, type Static } from "@sinclair/typebox";

const exact = { additionalProperties: false } as const;
const headersSchema = Type.Record(
    Type.String({ maxLength: 64, minLength: 1, pattern: "^[a-z0-9-]+$" }),
    Type.String({ maxLength: 16 * 1024, pattern: "^[^\\u0000-\\u001F\\u007F]*$" }),
    { additionalProperties: false, maxProperties: 32 },
);

export const p2pHttpRequestHeadSchema = Type.Object(
    {
        headers: headersSchema,
        method: Type.Union([
            Type.Literal("DELETE"),
            Type.Literal("GET"),
            Type.Literal("HEAD"),
            Type.Literal("OPTIONS"),
            Type.Literal("PATCH"),
            Type.Literal("POST"),
            Type.Literal("PUT"),
        ]),
        path: Type.String({
            maxLength: 16 * 1024,
            minLength: 1,
            pattern: "^/[^\\u0000-\\u001F\\u007F]*$",
        }),
    },
    exact,
);
export type P2pHttpRequestHead = Static<typeof p2pHttpRequestHeadSchema>;

export const p2pHttpResponseHeadSchema = Type.Object(
    {
        headers: headersSchema,
        status: Type.Integer({ maximum: 599, minimum: 100 }),
    },
    exact,
);
export type P2pHttpResponseHead = Static<typeof p2pHttpResponseHeadSchema>;

export type P2pHttpRequest = P2pHttpRequestHead & { body: Uint8Array };

export interface P2pHttpResponse extends P2pHttpResponseHead {
    body: AsyncIterable<Uint8Array>;
}

export type ServeP2pHttpRequest = (
    peerId: string,
    request: P2pHttpRequest,
    signal: AbortSignal,
) => Promise<P2pHttpResponse>;

export const P2P_HTTP_MAXIMUM_BODY_BYTES = 40 * 1024 * 1024;
