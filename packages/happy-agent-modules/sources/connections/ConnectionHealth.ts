import { Type, type Static } from "@sinclair/typebox";

export const connectionHealthSchema = Type.Object(
    {
        connectionId: Type.String(),
        reachable: Type.Boolean(),
        authenticated: Type.Boolean(),
        ready: Type.Boolean(),
        protocol: Type.Optional(Type.Integer({ minimum: 0 })),
        error: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
);
export type ConnectionHealth = Static<typeof connectionHealthSchema>;
