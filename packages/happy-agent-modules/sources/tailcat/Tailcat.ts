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

/** A named exposure's stable identity name; `default` belongs to `[feature.tailcat]`. */
export const tailcatExposureNameSchema = Type.String({
    maxLength: 32,
    minLength: 1,
    pattern: "^[a-z][a-z0-9-]*$",
});

/** What a module asks for when it opens its own exposure next to `[feature.tailcat]`. */
export const tailcatNamedExposureRequestSchema = Type.Object(
    {
        name: tailcatExposureNameSchema,
        port: Type.Integer({ minimum: 1, maximum: 65_535 }),
        target: tailcatTransportTargetSchema,
    },
    { additionalProperties: false },
);

export type TailcatState = Static<typeof tailcatStateSchema>;
export type TailcatStatus = Static<typeof tailcatStatusSchema>;
export type TailcatTransportTarget = Static<typeof tailcatTransportTargetSchema>;
export type TailcatNamedExposureRequest = Static<typeof tailcatNamedExposureRequestSchema>;

/**
 * One open named exposure. Its address carries the identity's pre-shared key, so it is a secret.
 * Closing stops the supervised process; the identity key stays for the next open.
 */
export interface TailcatNamedExposure {
    readonly address: string;
    readonly name: string;
    readonly port: number;
    close(): Promise<void>;
}
