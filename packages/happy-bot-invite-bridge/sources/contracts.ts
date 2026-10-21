import { isIP } from "node:net";
import { FormatRegistry, Type, type Static } from "@sinclair/typebox";

FormatRegistry.Set("clip-ip-address", (value) => isIP(value) !== 0);
export const ipAddressSchema = Type.String({ format: "clip-ip-address" });
const nameSegments = new Intl.Segmenter("und", { granularity: "grapheme" });
FormatRegistry.Set("clip-display-name", (value) => {
    if (!/^[\p{L}\p{M}\p{N} .'’_-]+$/u.test(value) || /[\p{C}\p{Zl}\p{Zp}]/u.test(value))
        return false;
    const segments = [...nameSegments.segment(value)];
    return (
        segments.length >= 1 &&
        segments.length <= 40 &&
        segments.every(
            ({ segment }) =>
                !/^\p{M}/u.test(segment) && (segment.match(/\p{M}/gu)?.length ?? 0) <= 4,
        )
    );
});
export const displayNameSchema = Type.String({ format: "clip-display-name", maxLength: 256 });
export const maxMembersSchema = Type.Integer({ minimum: 1, maximum: 20 });

export const redeemSchema = Type.Object(
    {
        token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
        redeemNonce: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }),
        displayName: Type.String({ minLength: 1, maxLength: 256 }),
    },
    { additionalProperties: false },
);
export const sendSchema = Type.Object(
    {
        localId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
        text: Type.String({ minLength: 1, maxLength: 4_000, pattern: "\\S" }),
    },
    { additionalProperties: false },
);
export type Send = Static<typeof sendSchema>;
export const emptySchema = Type.Object({}, { additionalProperties: false });
export const registrySchema = Type.Object(
    {
        trustedProxyAddress: Type.Optional(ipAddressSchema),
        exports: Type.Array(
            Type.Object(
                {
                    botId: Type.String({ minLength: 1, maxLength: 256 }),
                    connectUrl: Type.String({ minLength: 1, maxLength: 4_096 }),
                    tokenFile: Type.String({ minLength: 1, maxLength: 4_096 }),
                },
                { additionalProperties: false },
            ),
            { minItems: 1, maxItems: 10 },
        ),
    },
    { additionalProperties: false },
);
export const helloSchema = Type.Object({
    type: Type.Literal("hello"),
    protocol: Type.Literal(1),
    bot: Type.Object({ id: Type.String(), name: Type.String({ maxLength: 256 }) }),
});
export const replySchema = Type.Object({
    type: Type.Literal("reply"),
    seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    userId: Type.String(),
    chatId: Type.String(),
    text: Type.Optional(Type.String()),
});
export const ackSchema = Type.Object({
    type: Type.Literal("ack"),
    id: Type.String(),
});
export const rejectSchema = Type.Object({
    type: Type.Literal("reject"),
    id: Type.Optional(Type.String()),
    reason: Type.String(),
});

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly code?: string,
        readonly retryAfter?: number,
    ) {
        super(message);
    }
}
