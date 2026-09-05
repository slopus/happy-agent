import { Type, type Static } from "@sinclair/typebox";

export const tailcatAddressSchema = Type.String({
    maxLength: 8_192,
    minLength: 3,
    pattern: "^tc[A-Za-z0-9_-]+$",
});

export const tailcatStateSchema = Type.Union([
    Type.Literal("disabled"),
    Type.Literal("starting"),
    Type.Literal("open"),
    Type.Literal("stopping"),
    Type.Literal("failed"),
]);

export const tailcatStatusSchema = Type.Object(
    {
        address: Type.Optional(tailcatAddressSchema),
        enabled: Type.Boolean(),
        error: Type.Optional(Type.String({ minLength: 1, maxLength: 8_192 })),
        port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65_535 })),
        state: tailcatStateSchema,
    },
    { additionalProperties: false },
);

export const tailcatTransportTargetSchema = Type.Union([
    Type.Object(
        { socketPath: Type.String({ minLength: 1, maxLength: 4_096 }) },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            host: Type.String({ minLength: 1, maxLength: 255 }),
            port: Type.Integer({ minimum: 1, maximum: 65_535 }),
        },
        { additionalProperties: false },
    ),
]);

export type TailcatState = Static<typeof tailcatStateSchema>;
export type TailcatStatus = Static<typeof tailcatStatusSchema>;
export type TailcatTransportTarget = Static<typeof tailcatTransportTargetSchema>;
